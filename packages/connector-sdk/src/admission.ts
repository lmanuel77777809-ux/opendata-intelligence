import {
  AuthRequiredError,
  HostNotAllowedError,
  HttpError,
  NetworkError,
  SchemaValidationError,
  TimeoutError,
} from './errors.ts';
import type { AvailabilityResult } from './types.ts';

/** Traduce el error de una prueba de admisión al resultado que se registra en meta.admission_check. */
export function availabilityFromError(endpointCode: string, url: string, error: unknown): AvailabilityResult {
  const base = { ok: false, endpointCode, url, contentType: null, latencyMs: null } as const;
  const detail = error instanceof Error ? error.message : String(error);
  if (error instanceof AuthRequiredError) {
    return { ...base, httpStatus: error.httpStatus ?? null, outcome: 'fail_auth_required', detail };
  }
  if (error instanceof SchemaValidationError) {
    return { ...base, httpStatus: 200, outcome: 'fail_format', detail };
  }
  if (error instanceof HttpError) {
    return { ...base, httpStatus: error.httpStatus ?? null, outcome: 'fail_http', detail };
  }
  if (error instanceof TimeoutError || error instanceof NetworkError || error instanceof HostNotAllowedError) {
    return { ...base, httpStatus: null, outcome: 'fail_network', detail };
  }
  return { ...base, httpStatus: null, outcome: 'fail_network', detail };
}
