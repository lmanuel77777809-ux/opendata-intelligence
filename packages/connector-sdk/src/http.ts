import type { z } from 'zod';
import {
  AuthRequiredError,
  ConnectorError,
  HostNotAllowedError,
  HttpError,
  NetworkError,
  SchemaValidationError,
  TimeoutError,
} from './errors.ts';
import { HostRateLimiter, realClock, type Clock, type RateLimit } from './rate-limiter.ts';

export interface HttpClientOptions {
  /** Hosts permitidos (meta.source_host). Cualquier otro se rechaza antes de enviar nada. */
  allowedHosts: Iterable<string>;
  /** Identificación del cliente; algunas fuentes exigen un contacto en él. */
  userAgent: string;
  timeoutMs?: number;
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  maxRedirects?: number;
  /** Límites por host (meta.endpoint.rate_limit_*). */
  rateLimits?: Record<string, RateLimit>;
  /** Solo pruebas: permite http://127.0.0.1 y http://localhost. */
  allowInsecureLoopback?: boolean;
  fetchImpl?: typeof fetch;
  clock?: Clock;
  random?: () => number;
}

export interface ResponseInfo {
  url: string;
  status: number;
  contentType: string | null;
  latencyMs: number;
  attempts: number;
}

export interface HttpStats {
  requests: number;
  retries: number;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost']);

/**
 * Cliente HTTP de solo lectura para API públicas: GET anónimo, lista blanca de hosts,
 * timeout, reintentos con espera exponencial y Retry-After, y límite de tasa por host.
 * Nunca envía cabeceras de autenticación.
 */
export class HttpClient {
  readonly stats: HttpStats = { requests: 0, retries: 0 };
  private readonly allowedHosts: Set<string>;
  private readonly limiters = new Map<string, HostRateLimiter>();
  private readonly opts: Required<Omit<HttpClientOptions, 'allowedHosts' | 'rateLimits' | 'fetchImpl'>> & {
    rateLimits: Record<string, RateLimit>;
    fetchImpl: typeof fetch;
  };

  constructor(options: HttpClientOptions) {
    this.allowedHosts = new Set([...options.allowedHosts].map((h) => h.toLowerCase()));
    this.opts = {
      userAgent: options.userAgent,
      timeoutMs: options.timeoutMs ?? 30_000,
      maxRetries: options.maxRetries ?? 4,
      baseDelayMs: options.baseDelayMs ?? 1_000,
      maxDelayMs: options.maxDelayMs ?? 60_000,
      maxRedirects: options.maxRedirects ?? 3,
      rateLimits: options.rateLimits ?? {},
      allowInsecureLoopback: options.allowInsecureLoopback ?? false,
      fetchImpl: options.fetchImpl ?? globalThis.fetch.bind(globalThis),
      clock: options.clock ?? realClock,
      random: options.random ?? Math.random,
    };
  }

  /** Lanza HostNotAllowedError si la URL no está permitida. */
  assertAllowed(url: string): URL {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new HostNotAllowedError(url);
    }
    const host = parsed.hostname.toLowerCase();
    const schemeOk =
      parsed.protocol === 'https:' ||
      (parsed.protocol === 'http:' && this.opts.allowInsecureLoopback && LOOPBACK.has(host));
    if (!schemeOk || parsed.username || parsed.password || !this.allowedHosts.has(host)) {
      throw new HostNotAllowedError(url);
    }
    return parsed;
  }

  async getText(url: string): Promise<{ body: string; info: ResponseInfo }> {
    this.assertAllowed(url);
    let attempt = 0;
    for (;;) {
      try {
        const result = await this.attempt(url);
        return { body: result.body, info: { ...result.info, attempts: attempt + 1 } };
      } catch (error) {
        const retryable = error instanceof ConnectorError && error.retryable;
        if (!retryable || attempt >= this.opts.maxRetries) throw error;
        const retryAfter = error instanceof RetryAfterHttpError ? error.retryAfterMs : undefined;
        const backoff = this.opts.baseDelayMs * 2 ** attempt + Math.floor(this.opts.random() * 250);
        await this.opts.clock.sleep(Math.min(this.opts.maxDelayMs, retryAfter ?? backoff));
        this.stats.retries += 1;
        attempt += 1;
      }
    }
  }

  async getJson<T>(url: string, schema: z.ZodType<T>): Promise<{ data: T; info: ResponseInfo }> {
    const { body, info } = await this.getText(url);
    let json: unknown;
    try {
      json = JSON.parse(body);
    } catch (cause) {
      throw new SchemaValidationError(url, [{ message: 'La respuesta no es JSON válido', cause: String(cause) }]);
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new SchemaValidationError(url, parsed.error.issues);
    return { data: parsed.data, info };
  }

  private limiterFor(host: string): HostRateLimiter {
    let limiter = this.limiters.get(host);
    if (!limiter) {
      limiter = new HostRateLimiter(this.opts.rateLimits[host] ?? {}, this.opts.clock);
      this.limiters.set(host, limiter);
    }
    return limiter;
  }

  private async attempt(startUrl: string): Promise<{ body: string; info: Omit<ResponseInfo, 'attempts'> }> {
    let url = startUrl;
    for (let redirects = 0; ; redirects += 1) {
      const parsed = this.assertAllowed(url);
      await this.limiterFor(parsed.hostname.toLowerCase()).acquire();

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs);
      const started = performance.now();
      this.stats.requests += 1;
      try {
        let response: Response;
        try {
          response = await this.opts.fetchImpl(url, {
            method: 'GET',
            headers: { 'User-Agent': this.opts.userAgent, Accept: 'application/json, */*;q=0.5' },
            redirect: 'manual',
            signal: controller.signal,
          });
        } catch (cause) {
          if (controller.signal.aborted) throw new TimeoutError(url, this.opts.timeoutMs);
          throw new NetworkError(url, cause);
        }

        if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
          await response.body?.cancel();
          if (redirects >= this.opts.maxRedirects) throw new HttpError(url, response.status, 'demasiadas redirecciones');
          url = new URL(response.headers.get('location')!, url).toString();
          continue;
        }
        if (response.status === 401 || response.status === 403 || response.status === 407) {
          await response.body?.cancel();
          throw new AuthRequiredError(url, response.status);
        }

        let body: string;
        try {
          body = await response.text();
        } catch (cause) {
          if (controller.signal.aborted) throw new TimeoutError(url, this.opts.timeoutMs);
          throw new NetworkError(url, cause);
        }
        if (!response.ok) {
          const excerpt = body.slice(0, 500);
          if (response.status === 429 || response.status === 503) {
            throw new RetryAfterHttpError(url, response.status, excerpt, parseRetryAfter(response.headers.get('retry-after'), this.opts.clock.now()));
          }
          throw new HttpError(url, response.status, excerpt);
        }
        return {
          body,
          info: {
            url,
            status: response.status,
            contentType: response.headers.get('content-type'),
            latencyMs: Math.round(performance.now() - started),
          },
        };
      } finally {
        clearTimeout(timer);
      }
    }
  }
}

class RetryAfterHttpError extends HttpError {
  readonly retryAfterMs: number | undefined;
  constructor(url: string, status: number, excerpt: string, retryAfterMs: number | undefined) {
    super(url, status, excerpt);
    this.retryAfterMs = retryAfterMs;
  }
}

/** Retry-After admite segundos o una fecha HTTP. */
export function parseRetryAfter(value: string | null, nowMs: number): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - nowMs);
}
