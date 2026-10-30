import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AuthRequiredError,
  HostNotAllowedError,
  HttpClient,
  HttpError,
  SchemaValidationError,
  TimeoutError,
  parseRetryAfter,
  type Clock,
} from '../src/index.ts';

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

let server: Server;
let base: string;
let handler: Handler;
let hits: IncomingMessage[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    hits.push(req);
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(() => {
  hits = [];
});

/** Reloj falso: registra las esperas pedidas y no espera de verdad. */
function fakeClock(): Clock & { sleeps: number[] } {
  let now = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

function client(extra: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}) {
  return new HttpClient({
    allowedHosts: ['127.0.0.1'],
    userAgent: 'OpenDataIntelligence-test/0.1',
    allowInsecureLoopback: true,
    timeoutMs: 2_000,
    maxRetries: 3,
    baseDelayMs: 100,
    random: () => 0,
    clock: fakeClock(),
    ...extra,
  });
}

const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

describe('HttpClient', () => {
  it('rechaza hosts fuera de la lista blanca sin enviar la petición', async () => {
    handler = (_req, res) => json(res, 200, {});
    const http = new HttpClient({ allowedHosts: ['api.worldbank.org'], userAgent: 'x', allowInsecureLoopback: true });
    await expect(http.getText(`${base}/x`)).rejects.toBeInstanceOf(HostNotAllowedError);
    await expect(http.getText('https://evil.example.com/x')).rejects.toBeInstanceOf(HostNotAllowedError);
    await expect(http.getText('https://user:pw@api.worldbank.org/x')).rejects.toBeInstanceOf(HostNotAllowedError);
    expect(hits).toHaveLength(0);
    expect(http.stats.requests).toBe(0);
  });

  it('rechaza http:// salvo loopback en modo prueba', () => {
    const http = new HttpClient({ allowedHosts: ['api.worldbank.org'], userAgent: 'x' });
    expect(() => http.assertAllowed('http://api.worldbank.org/v2')).toThrow(HostNotAllowedError);
    expect(http.assertAllowed('https://api.worldbank.org/v2').hostname).toBe('api.worldbank.org');
  });

  it('envía User-Agent y nunca cabeceras de autenticación', async () => {
    handler = (_req, res) => json(res, 200, { ok: true });
    await client().getText(`${base}/ua`);
    expect(hits[0]!.headers['user-agent']).toBe('OpenDataIntelligence-test/0.1');
    expect(hits[0]!.headers.authorization).toBeUndefined();
    expect(hits[0]!.method).toBe('GET');
  });

  it('respeta Retry-After en 429 y luego tiene éxito', async () => {
    let calls = 0;
    handler = (_req, res) => (++calls === 1 ? json(res, 429, {}, { 'retry-after': '2' }) : json(res, 200, { ok: true }));
    const clock = fakeClock();
    const http = client({ clock });
    const { info } = await http.getText(`${base}/429`);
    expect(info.attempts).toBe(2);
    expect(clock.sleeps).toEqual([2_000]);
    expect(http.stats).toEqual({ requests: 2, retries: 1 });
  });

  it('reintenta errores 5xx con espera exponencial', async () => {
    let calls = 0;
    handler = (_req, res) => (++calls <= 2 ? json(res, 502, { error: 'bad gateway' }) : json(res, 200, { ok: true }));
    const clock = fakeClock();
    const { info } = await client({ clock }).getText(`${base}/5xx`);
    expect(info.attempts).toBe(3);
    expect(clock.sleeps).toEqual([100, 200]);
  });

  it('agota los reintentos y propaga el último error', async () => {
    handler = (_req, res) => json(res, 500, { error: 'boom' });
    await expect(client({ maxRetries: 2 }).getText(`${base}/500`)).rejects.toMatchObject({ httpStatus: 500, code: 'http_error' });
    expect(hits).toHaveLength(3);
  });

  it('no reintenta 404', async () => {
    handler = (_req, res) => json(res, 404, { error: 'not found' });
    await expect(client().getText(`${base}/404`)).rejects.toBeInstanceOf(HttpError);
    expect(hits).toHaveLength(1);
  });

  it('señala 401/403 como exigencia de autenticación, sin reintentar', async () => {
    handler = (_req, res) => json(res, 401, { error: 'token required' });
    await expect(client().getText(`${base}/401`)).rejects.toBeInstanceOf(AuthRequiredError);
    handler = (_req, res) => json(res, 403, { error: 'forbidden' });
    await expect(client().getText(`${base}/403`)).rejects.toBeInstanceOf(AuthRequiredError);
    expect(hits).toHaveLength(2);
  });

  it('corta por timeout y reintenta', async () => {
    handler = () => {
      /* nunca responde */
    };
    const http = client({ timeoutMs: 50, maxRetries: 1 });
    await expect(http.getText(`${base}/hang`)).rejects.toBeInstanceOf(TimeoutError);
    expect(hits).toHaveLength(2);
  });

  it('no sigue redirecciones hacia hosts no permitidos', async () => {
    handler = (_req, res) => {
      res.writeHead(302, { location: 'https://evil.example.com/steal' });
      res.end();
    };
    await expect(client().getText(`${base}/redirect`)).rejects.toBeInstanceOf(HostNotAllowedError);
    expect(hits).toHaveLength(1);
  });

  it('sigue redirecciones dentro del mismo host', async () => {
    handler = (req, res) => {
      if (req.url === '/old') {
        res.writeHead(301, { location: '/new' });
        res.end();
      } else json(res, 200, { moved: true });
    };
    const { body, info } = await client().getText(`${base}/old`);
    expect(JSON.parse(body)).toEqual({ moved: true });
    expect(info.url).toBe(`${base}/new`);
  });

  it('valida la estructura de la respuesta', async () => {
    handler = (_req, res) => json(res, 200, { total: 'no-es-numero' });
    const schema = z.object({ total: z.number() });
    await expect(client().getJson(`${base}/schema`, schema)).rejects.toBeInstanceOf(SchemaValidationError);
    handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html>no es JSON</html>');
    };
    await expect(client().getJson(`${base}/html`, schema)).rejects.toBeInstanceOf(SchemaValidationError);
    handler = (_req, res) => json(res, 200, { total: 3 });
    await expect(client().getJson(`${base}/ok`, schema)).resolves.toMatchObject({ data: { total: 3 } });
  });
});

describe('parseRetryAfter', () => {
  it('acepta segundos y fechas HTTP', () => {
    expect(parseRetryAfter('5', 0)).toBe(5_000);
    expect(parseRetryAfter('Thu, 01 Jan 1970 00:00:10 GMT', 0)).toBe(10_000);
    expect(parseRetryAfter('basura', 0)).toBeUndefined();
    expect(parseRetryAfter(null, 0)).toBeUndefined();
  });
});
