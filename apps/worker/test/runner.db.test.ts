/**
 * Integración del worker con PostgreSQL (base de pruebas creada por scripts/db-test.sh)
 * y la API del Banco Mundial SIMULADA con datos sintéticos (sin red).
 * Ejecutar: WITH_INTEGRATION=1 pnpm db:test
 */
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { syntheticScenario, type FakeWorldBank } from '../../../connectors/worldbank/test/fake-api.ts';
import { connectors, createPool } from '../src/app.ts';
import { runDataset, type RunOutcome } from '../src/runner.ts';

const DB_URL = process.env.DATABASE_URL_TEST;
const DATASET = 'worldbank:wdi-demography';
const silent = { info() {}, warn() {}, error() {} };

describe.skipIf(!DB_URL)('worker + PostgreSQL (API simulada)', () => {
  let admin: pg.Pool;
  let worker: pg.Pool;
  const fake: FakeWorldBank = syntheticScenario();

  const run = () =>
    runDataset(worker, DATASET, { trigger: 'test', userAgent: 'odi-test', connectors, log: silent, fetchImpl: fake.fetch as typeof fetch });
  const one = async (sql: string, params: unknown[] = []) => (await admin.query(sql, params)).rows[0];

  const expectRun = (o: RunOutcome) => {
    if (o.status === 'not_started') throw new Error(`no arrancó: ${o.reason}`);
    const r = o.run;
    // Cuadre: cada fila recibida acaba en exactamente una categoría.
    expect(r.records_received).toBe(r.records_inserted + r.records_updated + r.records_unchanged + r.records_rejected + r.records_null);
    return r;
  };

  beforeAll(async () => {
    admin = new pg.Pool({ connectionString: DB_URL });
    worker = createPool(DB_URL!, 'ingest_writer');
    await admin.query(
      `update meta.dataset set config = '{"wb_source_id": 2, "per_page": 2, "indicators": ["SP.POP.TOTL", "SP.DYN.LE00.IN"]}'
       where code = $1`,
      [DATASET],
    );
  });

  afterAll(async () => {
    await worker?.end();
    await admin?.end();
  });

  it('el worker opera con el rol ingest_writer, no como superusuario', async () => {
    expect((await worker.query('select current_user as u')).rows[0]).toEqual({ u: 'ingest_writer' });
    await expect(worker.query(`update meta.source set status = 'approved'`)).rejects.toThrow(/permission denied/);
  });

  it('primera ejecución: carga, rechaza geografías desconocidas y no guarda nulos', async () => {
    const outcome = await run();
    expect(outcome.status).toBe('success');
    const r = expectRun(outcome);
    expect(r).toMatchObject({ records_received: 8, records_inserted: 6, records_rejected: 1, records_null: 1, records_updated: 0 });
    expect(r.http_requests).toBeGreaterThan(0);

    expect(await one(`select outcome, http_status from meta.admission_check order by id desc limit 1`)).toEqual({ outcome: 'pass', http_status: 200 });
    expect(await one(`select name_es from ref.country where iso3 = 'ESP'`)).toEqual({ name_es: 'España' });
    expect(await one(`select kind from ref.region where code = 'WLD'`)).toEqual({ kind: 'world' });
    expect(await one(`select count(*)::int as n from ref.region_member m join ref.country c on c.id = m.country_id where c.iso3 = 'ESP'`)).toEqual({ n: 2 });
    expect(await one(`select c.iso3 from ref.geo_code_map m join ref.country c on c.id = m.country_id where m.code = 'ES'`)).toEqual({ iso3: 'ESP' });
    expect(await one(`select name_es, provider_last_updated::text from core.indicator where external_code = 'SP.POP.TOTL'`)).toEqual({
      name_es: 'Población, total',
      provider_last_updated: '2026-07-01',
    });
    expect(await one(`select reason from ops.rejected_record where run_id = $1`, [r.id])).toEqual({ reason: 'unknown_geo_code' });
  });

  it('repetición: 0 nuevas, 0 modificadas, sin duplicados', async () => {
    const r = expectRun(await run());
    expect(r).toMatchObject({ records_inserted: 0, records_updated: 0, records_unchanged: 6, records_withdrawn: 0 });
    expect(await one(`select count(*)::int as n from core.observation`)).toEqual({ n: 6 });
    expect(await one(`select count(*)::int as n from core.observation_revision`)).toEqual({ n: 0 });
  });

  it('revisión del proveedor: 1 modificada con su historial', async () => {
    fake.indicators['SP.POP.TOTL']!.rows[0]!.value = 1010;
    const r = expectRun(await run());
    expect(r).toMatchObject({ records_inserted: 0, records_updated: 1, records_unchanged: 5 });
    expect(await one(`select change_kind, old_value::float, new_value::float from core.observation_revision`)).toEqual({
      change_kind: 'revised',
      old_value: 1000,
      new_value: 1010,
    });
  });

  it('dato retirado por el proveedor: se marca y se conserva', async () => {
    fake.indicators['SP.POP.TOTL']!.rows.splice(1, 1); // ESP 2022
    const r = expectRun(await run());
    expect(r.records_withdrawn).toBe(1);
    expect(await one(`select count(*)::int as n from core.observation`)).toEqual({ n: 6 });
    expect(await one(`select count(*)::int as n from core.observation where withdrawn_at is not null`)).toEqual({ n: 1 });
  });

  it('respuesta incompleta: el indicador falla sin tocar sus datos y la ejecución queda parcial', async () => {
    fake.totalOffset['SP.DYN.LE00.IN'] = 1;
    const before = await one(`select count(*)::int as n from core.observation_revision`);
    const outcome = await run();
    expect(outcome.status).toBe('partial');
    expectRun(outcome);
    if (outcome.status === 'not_started') return;
    expect(await one(`select phase, error_code from ops.ingestion_error where run_id = $1`, [outcome.run.id])).toEqual({
      phase: 'fetch',
      error_code: 'incomplete_response',
    });
    expect(await one(`select count(*)::int as n from core.observation_revision`)).toEqual(before);
    delete fake.totalOffset['SP.DYN.LE00.IN'];
  });

  it('admisión denegada (403): no se abre ejecución y queda la evidencia', async () => {
    const runsBefore = await one(`select count(*)::int as n from ops.ingestion_run`);
    fake.forceStatus = { match: () => true, status: 403 };
    const outcome = await run();
    fake.forceStatus = null;
    expect(outcome).toMatchObject({ status: 'not_started', admission: 'fail_auth_required' });
    expect(await one(`select count(*)::int as n from ops.ingestion_run`)).toEqual(runsBefore);
    expect(await one(`select outcome, http_status from meta.admission_check order by id desc limit 1`)).toEqual({
      outcome: 'fail_auth_required',
      http_status: 403,
    });
  });

  it('lectura pública: solo tras aprobar la fuente y publicar el dataset', async () => {
    const asAnon = async (sql: string, params: unknown[] = []) => {
      const client = await admin.connect();
      try {
        await client.query('set role anon');
        return (await client.query(sql, params)).rows;
      } finally {
        await client.query('reset role');
        client.release();
      }
    };
    const series = `select geo_code, period_label, value::float, license_code
                    from api.get_series('worldbank:SP.POP.TOTL', array['ESP'], 2020, 2024)`;
    expect(await asAnon(series)).toEqual([]);

    await admin.query(`update meta.source set status = 'approved' where code = 'worldbank'`);
    await admin.query(`update meta.dataset set is_public = true where code = $1`, [DATASET]);
    expect(await asAnon(series)).toEqual([{ geo_code: 'ESP', period_label: '2023', value: 1010, license_code: 'CC-BY-4.0' }]);
  });
});
