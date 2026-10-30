import type pg from 'pg';
import {
  AuthRequiredError,
  ConnectorError,
  HostNotAllowedError,
  HttpClient,
  HttpError,
  IncompleteResponseError,
  realClock,
  SchemaValidationError,
  type Clock,
  type Connector,
  type ConnectorContext,
  type Logger,
  type NormalizedObservation,
  type RejectedRecord,
} from '@odi/connector-sdk';
import {
  addCounters,
  finishRun,
  getRun,
  loadDatasetContext,
  loadGeoMap,
  logError,
  logRejected,
  recordAdmission,
  setIndicatorLastUpdated,
  stageAndMerge,
  startRun,
  upsertGeography,
  upsertIndicators,
  type RunRow,
} from './repository.ts';

export type ConnectorRegistry = Record<string, Connector<unknown>>;

/** Intentos de descarga completa por indicador y espera entre ellos. */
const INDICATOR_ATTEMPTS = 2;
const INDICATOR_RETRY_DELAY_MS = 30_000;

export interface RunOptions {
  trigger: 'schedule' | 'manual' | 'test';
  userAgent: string;
  connectors: ConnectorRegistry;
  log: Logger;
  fetchImpl?: typeof fetch;
  clock?: Clock;
}

export type RunOutcome =
  | { status: 'not_started'; datasetCode: string; reason: string; admission: string }
  | { status: 'success' | 'partial' | 'failed'; datasetCode: string; run: RunRow; indicators: IndicatorOutcome[] };

export interface IndicatorOutcome {
  code: string;
  ok: boolean;
  received?: number;
  inserted?: number;
  updated?: number;
  unchanged?: number;
  rejected?: number;
  withdrawn?: number;
  nulls?: number;
  error?: string;
}

/**
 * Ejecuta un dataset de principio a fin:
 * admisión → apertura → geografía → descubrimiento → por indicador (páginas, validación,
 * normalización, staging + fusión) → cierre con métricas.
 */
export async function runDataset(db: pg.Pool, datasetCode: string, opts: RunOptions): Promise<RunOutcome> {
  const ctxDb = await loadDatasetContext(db, datasetCode);
  const connector = opts.connectors[ctxDb.sourceCode];
  if (!connector) throw new Error(`No hay conector registrado para la fuente ${ctxDb.sourceCode}`);
  const config = connector.parseConfig(ctxDb.config);

  const http = new HttpClient({
    allowedHosts: ctxDb.allowedHosts,
    userAgent: opts.userAgent,
    timeoutMs: ctxDb.timeoutMs,
    rateLimits: ctxDb.rateLimits,
    ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.clock ? { clock: opts.clock } : {}),
  });
  const ctx: ConnectorContext = { http, log: opts.log };
  const sleep = (opts.clock ?? realClock).sleep;

  // 1. Admisión: petición anónima real; se registra siempre, pase o no.
  const availability = await connector.checkAvailability(ctx, config);
  await recordAdmission(db, ctxDb.sourceCode, availability);
  if (!availability.ok) {
    opts.log.error('Prueba de admisión fallida; no se abre ejecución', { datasetCode, outcome: availability.outcome, detail: availability.detail });
    return { status: 'not_started', datasetCode, reason: availability.detail ?? availability.outcome, admission: availability.outcome };
  }

  // 2. Apertura (la base comprueba de nuevo la admisión y el estado de la fuente).
  const runId = await startRun(db, datasetCode, opts.trigger, connector.version, { config });
  let requestsCounted = http.stats.requests;
  const flushRequests = async () => {
    const delta = http.stats.requests - requestsCounted;
    requestsCounted = http.stats.requests;
    if (delta > 0) await addCounters(db, runId, { requests: delta });
  };

  const outcomes: IndicatorOutcome[] = [];
  try {
    // 3. Geografía del proveedor.
    if (connector.fetchGeography) {
      try {
        const geo = await connector.fetchGeography(ctx);
        const counts = await upsertGeography(db, ctxDb.sourceId, geo);
        opts.log.info('Geografía actualizada', counts);
      } catch (error) {
        await logError(db, runId, errorRecord('discovery', error));
        const existing = await loadGeoMap(db, ctxDb.sourceId);
        if (existing.size === 0) throw error;
        opts.log.warn('No se pudo actualizar la geografía; se usa la ya almacenada', { codes: existing.size });
      }
    }

    // 4. Descubrimiento de indicadores.
    const discovered = await connector.discoverIndicators(ctx, config);
    const requested = (config as { indicators?: string[] }).indicators ?? discovered.map((d) => d.externalCode);
    const found = new Set(discovered.map((d) => d.externalCode));
    for (const code of requested.filter((c) => !found.has(c))) {
      await logError(db, runId, { phase: 'discovery', code: 'indicator_not_found', message: `El proveedor no reconoce el indicador ${code}` });
      outcomes.push({ code, ok: false, error: 'indicator_not_found' });
    }
    const indicatorIds = await upsertIndicators(db, ctxDb, discovered);
    const geoMap = await loadGeoMap(db, ctxDb.sourceId);
    await flushRequests();

    // 5. Datos, indicador por indicador. La descarga completa se reintenta ante fallos
    //    pasajeros; nada se escribe hasta tener todas las páginas.
    for (const [code, indicatorId] of indicatorIds) {
      try {
        let download: Download | undefined;
        for (let attempt = 1; !download; attempt++) {
          try {
            download = await downloadIndicator(connector, ctx, config, code);
          } catch (error) {
            if (attempt >= INDICATOR_ATTEMPTS || !isTransient(error)) throw error;
            await logError(db, runId, errorRecord(phaseOf(error), error, { indicator: code, attempt, retried: true }));
            opts.log.warn('Fallo pasajero; se repite la descarga del indicador', { code, attempt, error: (error as Error).message });
            await sleep(INDICATOR_RETRY_DELAY_MS);
          }
        }
        const { observations, rejected, received, nulls, lastUpdated, fullSnapshot } = download;

        const rows: Array<NormalizedObservation & { countryId: number | null; regionId: number | null }> = [];
        for (const o of observations) {
          const geo = geoMap.get(o.geoCode);
          if (!geo) rejected.push({ reason: 'unknown_geo_code', raw: o });
          else rows.push({ ...o, countryId: geo.countryId, regionId: geo.regionId });
        }

        const merged = await stageAndMerge(db, runId, indicatorId, rows, fullSnapshot);
        await logRejected(db, runId, rejected);
        await addCounters(db, runId, { received, rejected: rejected.length, nulls });
        if (lastUpdated) await setIndicatorLastUpdated(db, indicatorId, lastUpdated);
        outcomes.push({ code, ok: true, received, nulls, ...merged, rejected: merged.rejected + rejected.length });
        opts.log.info('Indicador cargado', { code, received, nulls, ...merged });
      } catch (error) {
        await logError(db, runId, errorRecord(phaseOf(error), error, { indicator: code }));
        outcomes.push({ code, ok: false, error: error instanceof Error ? error.message : String(error) });
        opts.log.error('Indicador fallido', { code, error: (error as Error).message });
      } finally {
        await flushRequests();
      }
    }

    const failed = outcomes.filter((o) => !o.ok).length;
    const status = failed === 0 ? 'success' : failed < outcomes.length ? 'partial' : 'failed';
    await finishRun(db, runId, status, failed ? `${failed} de ${outcomes.length} indicadores con error` : null);
    return { status, datasetCode, run: await getRun(db, runId), indicators: outcomes };
  } catch (error) {
    await flushRequests().catch(() => undefined);
    await logError(db, runId, errorRecord(phaseOf(error), error)).catch(() => undefined);
    await finishRun(db, runId, 'failed', (error as Error).message);
    return { status: 'failed', datasetCode, run: await getRun(db, runId), indicators: outcomes };
  }
}

interface Download {
  observations: NormalizedObservation[];
  rejected: RejectedRecord[];
  received: number;
  nulls: number;
  lastUpdated: string | null;
  fullSnapshot: boolean;
}

async function downloadIndicator(connector: Connector<unknown>, ctx: ConnectorContext, config: unknown, code: string): Promise<Download> {
  const fetch = connector.fetchIndicator(ctx, config, code);
  const d: Download = { observations: [], rejected: [], received: 0, nulls: 0, lastUpdated: null, fullSnapshot: fetch.fullSnapshot };
  for await (const page of fetch.pages) {
    d.observations.push(...page.observations);
    d.rejected.push(...page.rejected);
    d.received += page.received;
    d.nulls += page.nulls;
    d.lastUpdated = page.providerLastUpdated ?? d.lastUpdated;
  }
  return d;
}

/**
 * Fallos que merecen repetir la descarga completa del indicador: red, timeouts, respuestas
 * incompletas y errores HTTP sueltos (incluido 400: el Banco Mundial ha devuelto 400 puntuales
 * en páginas válidas). No se repiten exigencias de autenticación, hosts no permitidos ni
 * cambios de esquema.
 */
function isTransient(error: unknown): boolean {
  if (error instanceof AuthRequiredError || error instanceof HostNotAllowedError || error instanceof SchemaValidationError) return false;
  if (error instanceof HttpError) return error.httpStatus !== 404;
  return error instanceof ConnectorError && (error.retryable || error instanceof IncompleteResponseError);
}

function phaseOf(error: unknown): 'fetch' | 'validate' | 'store' {
  if (error instanceof SchemaValidationError) return 'validate';
  if (error instanceof ConnectorError || error instanceof IncompleteResponseError) return 'fetch';
  return 'store';
}

function errorRecord(phase: string, error: unknown, extra?: Record<string, unknown>) {
  if (error instanceof ConnectorError) {
    return {
      phase,
      code: error.code,
      message: error.message,
      httpStatus: error.httpStatus,
      url: error.url,
      detail: {
        ...extra,
        ...(error instanceof SchemaValidationError ? { issues: error.issues } : {}),
        ...(error instanceof HttpError ? { body: error.bodyExcerpt } : {}),
      },
    };
  }
  return { phase, code: 'unexpected', message: error instanceof Error ? error.message : String(error), detail: extra };
}
