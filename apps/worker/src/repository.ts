import type pg from 'pg';
import type {
  AvailabilityResult,
  GeographySnapshot,
  IndicatorRecord,
  NormalizedObservation,
  RateLimit,
  RejectedRecord,
} from '@odi/connector-sdk';

/** Acceso a la base de datos del worker. Todo pasa por los permisos del rol ingest_writer. */

export interface DatasetContext {
  datasetId: number;
  datasetCode: string;
  config: unknown;
  categoryId: number;
  sourceId: number;
  sourceCode: string;
  sourceStatus: string;
  endpointCode: string;
  timeoutMs: number;
  allowedHosts: string[];
  rateLimits: Record<string, RateLimit>;
}

export async function loadDatasetContext(db: pg.Pool, datasetCode: string): Promise<DatasetContext> {
  const { rows } = await db.query(
    `select d.id, d.code, d.config, d.category_id, s.id as source_id, s.code as source_code, s.status,
            e.code as endpoint_code, e.timeout_ms
     from meta.dataset d
     join meta.source s on s.id = d.source_id
     join meta.endpoint e on e.id = d.endpoint_id
     where d.code = $1`,
    [datasetCode],
  );
  const row = rows[0];
  if (!row) throw new Error(`El dataset ${datasetCode} no existe`);

  const hosts = await db.query<{ host: string }>('select host from meta.source_host where source_id = $1', [row.source_id]);
  const endpoints = await db.query<{ base_url: string; rate_limit_per_second: string | null; rate_limit_per_hour: number | null }>(
    'select base_url, rate_limit_per_second, rate_limit_per_hour from meta.endpoint where source_id = $1',
    [row.source_id],
  );
  // El límite más estricto de los endpoints de un mismo host.
  const rateLimits: Record<string, RateLimit> = {};
  for (const e of endpoints.rows) {
    const host = new URL(e.base_url).hostname;
    const current = rateLimits[host] ?? {};
    const perSecond = e.rate_limit_per_second === null ? undefined : Number(e.rate_limit_per_second);
    const perHour = e.rate_limit_per_hour ?? undefined;
    rateLimits[host] = {
      perSecond: minDefined(current.perSecond, perSecond),
      perHour: minDefined(current.perHour, perHour),
    };
  }

  return {
    datasetId: row.id,
    datasetCode: row.code,
    config: row.config,
    categoryId: row.category_id,
    sourceId: row.source_id,
    sourceCode: row.source_code,
    sourceStatus: row.status,
    endpointCode: row.endpoint_code,
    timeoutMs: row.timeout_ms,
    allowedHosts: hosts.rows.map((h) => h.host),
    rateLimits,
  };
}

function minDefined(a: number | undefined, b: number | undefined): number | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  return Math.min(a, b);
}

export async function recordAdmission(db: pg.Pool, sourceCode: string, r: AvailabilityResult): Promise<void> {
  await db.query('select ops.record_admission_check($1, $2, $3, $4, $5, $6, $7, $8)', [
    sourceCode,
    r.endpointCode,
    r.url,
    r.httpStatus,
    r.contentType,
    r.latencyMs,
    r.outcome,
    r.detail ?? null,
  ]);
}

export async function startRun(db: pg.Pool, datasetCode: string, trigger: string, version: string, parameters: object): Promise<number> {
  const { rows } = await db.query<{ id: string }>('select ops.start_run($1, $2, $3, $4::jsonb) as id', [
    datasetCode,
    trigger,
    version,
    JSON.stringify(parameters),
  ]);
  return Number(rows[0]!.id);
}

export async function finishRun(db: pg.Pool, runId: number, status: 'success' | 'partial' | 'failed', summary: string | null) {
  await db.query('select ops.finish_run($1, $2, $3)', [runId, status, summary]);
}

export async function addCounters(db: pg.Pool, runId: number, c: { requests?: number; received?: number; rejected?: number; nulls?: number }) {
  await db.query('select ops.add_run_counters($1, $2, $3, $4, $5)', [runId, c.requests ?? 0, c.received ?? 0, c.rejected ?? 0, c.nulls ?? 0]);
}

export async function logError(
  db: pg.Pool,
  runId: number,
  e: { phase: string; code: string; message: string; httpStatus?: number | undefined; url?: string | undefined; detail?: unknown },
) {
  await db.query(
    `insert into ops.ingestion_error (run_id, phase, error_code, message, http_status, url, detail)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
    [runId, e.phase, e.code, e.message.slice(0, 2000), e.httpStatus ?? null, e.url ?? null, e.detail === undefined ? null : JSON.stringify(e.detail)],
  );
}

export async function logRejected(db: pg.PoolClient | pg.Pool, runId: number, rejected: RejectedRecord[]) {
  for (let i = 0; i < rejected.length; i += 1000) {
    const chunk = rejected.slice(i, i + 1000);
    await db.query(
      `insert into ops.rejected_record (run_id, reason, raw)
       select $1, r.reason, r.raw from unnest($2::text[], $3::jsonb[]) as r (reason, raw)`,
      [runId, chunk.map((r) => r.reason), chunk.map((r) => JSON.stringify(r.raw))],
    );
  }
}

/** Inserta o actualiza países, agregados, pertenencias y equivalencias de códigos del proveedor. */
export async function upsertGeography(db: pg.Pool, sourceId: number, geo: GeographySnapshot): Promise<{ countries: number; regions: number }> {
  const client = await db.connect();
  try {
    await client.query('begin');
    for (const c of geo.countries) {
      await client.query(
        `insert into ref.country (iso3, iso2, name_en, name_es) values ($1, $2, $3, $4)
         on conflict (iso3) do update
           set iso2 = coalesce(excluded.iso2, ref.country.iso2),
               name_en = excluded.name_en,
               name_es = coalesce(excluded.name_es, ref.country.name_es),
               updated_at = now()
         where (ref.country.iso2, ref.country.name_en, ref.country.name_es)
               is distinct from (coalesce(excluded.iso2, ref.country.iso2), excluded.name_en, coalesce(excluded.name_es, ref.country.name_es))`,
        [c.iso3, c.iso2, c.nameEn, c.nameEs],
      );
    }
    for (const r of geo.regions) {
      await client.query(
        `insert into ref.region (defined_by_source_id, code, name_en, name_es, kind) values ($1, $2, $3, $4, $5)
         on conflict (defined_by_source_id, code) do update
           set name_en = excluded.name_en,
               name_es = coalesce(excluded.name_es, ref.region.name_es),
               kind = excluded.kind,
               updated_at = now()
         where (ref.region.name_en, ref.region.name_es, ref.region.kind)
               is distinct from (excluded.name_en, coalesce(excluded.name_es, ref.region.name_es), excluded.kind)`,
        [sourceId, r.code, r.nameEn, r.nameEs, r.kind],
      );
    }
    // Equivalencias de códigos: un código del proveedor apunta a un solo destino; los países tienen prioridad.
    const countryCodes = new Map<string, string>();
    for (const c of geo.countries) for (const code of c.providerCodes) if (!countryCodes.has(code)) countryCodes.set(code, c.iso3);
    const regionCodes = new Map<string, string>();
    for (const r of geo.regions) for (const code of r.providerCodes) if (!countryCodes.has(code) && !regionCodes.has(code)) regionCodes.set(code, r.code);

    await client.query(
      `insert into ref.geo_code_map (source_id, code, country_id)
       select $1, x.code, c.id from unnest($2::text[], $3::text[]) as x (code, iso3) join ref.country c on c.iso3 = x.iso3
       on conflict (source_id, code) do update set country_id = excluded.country_id, region_id = null
       where ref.geo_code_map.country_id is distinct from excluded.country_id`,
      [sourceId, [...countryCodes.keys()], [...countryCodes.values()]],
    );
    await client.query(
      `insert into ref.geo_code_map (source_id, code, region_id)
       select $1, x.code, r.id from unnest($2::text[], $3::text[]) as x (code, region_code)
       join ref.region r on r.defined_by_source_id = $1 and r.code = x.region_code
       on conflict (source_id, code) do update set region_id = excluded.region_id, country_id = null
       where ref.geo_code_map.region_id is distinct from excluded.region_id`,
      [sourceId, [...regionCodes.keys()], [...regionCodes.values()]],
    );
    await client.query(
      `insert into ref.region_member (region_id, country_id)
       select r.id, c.id from unnest($2::text[], $3::text[]) as x (iso3, region_code)
       join ref.country c on c.iso3 = x.iso3
       join ref.region r on r.defined_by_source_id = $1 and r.code = x.region_code
       on conflict do nothing`,
      [sourceId, geo.countries.flatMap((c) => c.memberOf.map(() => c.iso3)), geo.countries.flatMap((c) => c.memberOf)],
    );
    await client.query('commit');
    return { countries: geo.countries.length, regions: geo.regions.length };
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export async function upsertIndicators(
  db: pg.Pool,
  ctx: Pick<DatasetContext, 'sourceId' | 'datasetId' | 'categoryId'>,
  indicators: IndicatorRecord[],
): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  for (const i of indicators) {
    const { rows } = await db.query<{ id: number }>(
      `insert into core.indicator (source_id, dataset_id, external_code, name_en, name_es, description, unit_label, category_id, source_organization)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       on conflict (source_id, external_code) do update
         set name_en = excluded.name_en, name_es = excluded.name_es, description = excluded.description,
             unit_label = excluded.unit_label, source_organization = excluded.source_organization, updated_at = now()
       returning id`,
      [ctx.sourceId, ctx.datasetId, i.externalCode, i.nameEn, i.nameEs, i.description, i.unitLabel, ctx.categoryId, i.sourceOrganization],
    );
    ids.set(i.externalCode, rows[0]!.id);
  }
  return ids;
}

export async function setIndicatorLastUpdated(db: pg.Pool, indicatorId: number, date: string) {
  await db.query('update core.indicator set provider_last_updated = $2::date, updated_at = now() where id = $1 and provider_last_updated is distinct from $2::date', [
    indicatorId,
    date,
  ]);
}

export type GeoMap = Map<string, { countryId: number | null; regionId: number | null }>;

export async function loadGeoMap(db: pg.Pool, sourceId: number): Promise<GeoMap> {
  const { rows } = await db.query<{ code: string; country_id: number | null; region_id: number | null }>(
    'select code, country_id, region_id from ref.geo_code_map where source_id = $1',
    [sourceId],
  );
  return new Map(rows.map((r) => [r.code, { countryId: r.country_id, regionId: r.region_id }]));
}

export interface MergeCounts {
  inserted: number;
  updated: number;
  unchanged: number;
  rejected: number;
  withdrawn: number;
}

/**
 * Carga en staging y fusiona en una sola transacción: si algo falla no queda nada a medias
 * ni se mezcla con el lote del siguiente indicador.
 */
export async function stageAndMerge(
  db: pg.Pool,
  runId: number,
  indicatorId: number,
  rows: Array<NormalizedObservation & { countryId: number | null; regionId: number | null }>,
  fullSnapshot: boolean,
): Promise<MergeCounts> {
  const client = await db.connect();
  try {
    await client.query('begin');
    for (let i = 0; i < rows.length; i += 5000) {
      const chunk = rows.slice(i, i + 5000);
      await client.query(
        `insert into staging.observation_load
           (run_id, indicator_id, country_id, region_id, frequency, dimensions, period_start, period_end, period_label, value, obs_status)
         select $1, $2, x.country_id, x.region_id, x.frequency, x.dimensions, x.period_start, x.period_end, x.period_label, x.value, x.obs_status
         from unnest($3::smallint[], $4::integer[], $5::text[], $6::jsonb[], $7::date[], $8::date[], $9::text[], $10::numeric[], $11::text[])
           as x (country_id, region_id, frequency, dimensions, period_start, period_end, period_label, value, obs_status)`,
        [
          runId,
          indicatorId,
          chunk.map((r) => r.countryId),
          chunk.map((r) => r.regionId),
          chunk.map((r) => r.frequency),
          chunk.map((r) => JSON.stringify(r.dimensions)),
          chunk.map((r) => r.periodStart),
          chunk.map((r) => r.periodEnd),
          chunk.map((r) => r.periodLabel),
          chunk.map((r) => String(r.value)),
          chunk.map((r) => r.obsStatus),
        ],
      );
    }
    const { rows: result } = await client.query<MergeCounts>('select * from ops.merge_observations($1, $2)', [runId, fullSnapshot]);
    await client.query('commit');
    return result[0]!;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
}

export interface RunRow {
  id: number;
  status: string;
  http_requests: number;
  records_received: number;
  records_inserted: number;
  records_updated: number;
  records_unchanged: number;
  records_rejected: number;
  records_withdrawn: number;
  records_null: number;
  duration_ms: number | null;
  error_summary: string | null;
}

export async function getRun(db: pg.Pool, runId: number): Promise<RunRow> {
  const { rows } = await db.query<RunRow>(
    `select id::int, status, http_requests, records_received, records_inserted, records_updated, records_unchanged,
            records_rejected, records_withdrawn, records_null, duration_ms, error_summary
     from ops.ingestion_run where id = $1`,
    [runId],
  );
  return rows[0]!;
}

export async function dueDatasets(db: pg.Pool): Promise<string[]> {
  const { rows } = await db.query<{ dataset_code: string }>('select dataset_code from ops.due_datasets()');
  return rows.map((r) => r.dataset_code);
}
