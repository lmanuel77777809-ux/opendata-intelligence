/** Errores del SDK. Cada uno indica si tiene sentido reintentar y en qué fase ocurrió. */

export class ConnectorError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly url: string | undefined;
  readonly httpStatus: number | undefined;

  constructor(code: string, message: string, opts: { retryable?: boolean; url?: string; httpStatus?: number; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = new.target.name;
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.url = opts.url;
    this.httpStatus = opts.httpStatus;
  }
}

/** La URL apunta a un host fuera de la lista blanca de la fuente. Nunca se envía la petición. */
export class HostNotAllowedError extends ConnectorError {
  constructor(url: string) {
    super('host_not_allowed', `Host no permitido: ${safeHost(url)}`, { url });
  }
}

/** El proveedor pide credenciales (401, 403, 407): la fuente incumple la regla de acceso anónimo. */
export class AuthRequiredError extends ConnectorError {
  constructor(url: string, httpStatus: number) {
    super('auth_required', `El proveedor exige autenticación (HTTP ${httpStatus})`, { url, httpStatus });
  }
}

export class HttpError extends ConnectorError {
  readonly bodyExcerpt: string;
  constructor(url: string, httpStatus: number, bodyExcerpt: string) {
    super('http_error', `HTTP ${httpStatus} en ${url}`, {
      url,
      httpStatus,
      retryable: httpStatus === 429 || httpStatus >= 500,
    });
    this.bodyExcerpt = bodyExcerpt;
  }
}

export class TimeoutError extends ConnectorError {
  constructor(url: string, timeoutMs: number) {
    super('timeout', `Sin respuesta en ${timeoutMs} ms: ${url}`, { url, retryable: true });
  }
}

export class NetworkError extends ConnectorError {
  constructor(url: string, cause: unknown) {
    super('network_error', `Error de red en ${url}: ${(cause as Error)?.message ?? String(cause)}`, { url, retryable: true, cause });
  }
}

/** La respuesta no tiene la estructura esperada: posible cambio de API. */
export class SchemaValidationError extends ConnectorError {
  readonly issues: unknown;
  constructor(url: string, issues: unknown) {
    super('schema_changed', `La respuesta de ${url} no cumple el esquema esperado`, { url });
    this.issues = issues;
  }
}

/** La paginación no cuadra con los totales del proveedor: respuesta incompleta. */
export class IncompleteResponseError extends ConnectorError {
  constructor(url: string, message: string) {
    super('incomplete_response', message, { url });
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '(URL no válida)';
  }
}
