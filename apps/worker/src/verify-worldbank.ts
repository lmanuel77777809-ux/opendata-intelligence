/**
 * Verificación independiente de una carga real del Banco Mundial.
 * Se ejecuta después de `pnpm ingest run` sobre una base de pruebas (nunca sobre producción:
 * aprueba la fuente y publica los datasets para medir la API como `anon`).
 *
 *  1. Conteo por indicador: filas en base frente a valores no nulos que publica la API
 *     (descarga propia, por otro camino que el conector).
 *  2. 20 observaciones al azar comparadas una a una con la API.
 *  3. Tiempo de api.get_series como anon (mediana de 5).
 *
 * Variables: DATABASE_URL (superusuario de la base de pruebas). Salida: JSON en stdout y
 * anotaciones ::notice:: para GitHub Actions.
 */
import pg from 'pg';
import { HttpClient } from '@odi/connector-sdk';
import { userAgent } from './app.ts';

const API = 'https://api.worldbank.org/v2';
const http = new HttpClient({ allowedHosts: ['api.worldbank.org'], userAgent: userAgent(), rateLimits: { 'api.worldbank.org': { perSecond: 4 } } });

interface WbRow {
  countryiso3code: string;
  country: { id: string };
  date: string;
  value: number | null;
}

/** Descarga todas las páginas con un código mínimo, distinto del conector. */
async function wb(path: string): Promise<{ total: number; rows: WbRow[] }> {
  const rows: WbRow[] = [];
  let total = 0;
  for (let page = 1, pages = 1; page <= pages; page++) {
    const { body } = await http.getText(`${API}${path}&page=${page}`);
    const json = JSON.parse(body) as [{ total: number; pages: number }, WbRow[] | null];
    if (!Array.isArray(json) || json.length < 2) throw new Error(`Respuesta inesperada en ${path}: ${body.slice(0, 200)}`);
    total = json[0].total;
    pages = json[0].pages;
    rows.push(...(json[1] ?? []));
  }
  return { total, rows };
}

function notice(title: string, lines: string[]) {
  const msg = lines.join('\n').replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
  console.error(`::notice title=${title}::${msg}`);
}

async function main() {
  const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const q = async <T extends pg.QueryResultRow>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows;
  const report: Record<string, unknown> = {};

  // Ejecuciones registradas.
  const runs = await q(`
    select r.id, d.code as dataset, r.status, r.http_requests, r.records_received as received, r.records_inserted as inserted,
           r.records_updated as updated, r.records_unchanged as unchanged, r.records_rejected as rejected,
           r.records_null as nulls, r.records_withdrawn as withdrawn, r.duration_ms
    from ops.ingestion_run r join meta.dataset d on d.id = r.dataset_id order by r.id`);
  report.runs = runs;
  notice(
    'Ejecuciones de ingesta (API real)',
    runs.map((r) => `#${r.id} ${r.dataset} ${r.status}: recibidas ${r.received}, nuevas ${r.inserted}, modificadas ${r.updated}, iguales ${r.unchanged}, rechazadas ${r.rejected}, sin valor ${r.nulls}, peticiones ${r.http_requests}, ${r.duration_ms} ms`),
  );

  // 1. Conteos por indicador frente a la API.
  const geoCodes = new Set((await q<{ code: string }>(`select m.code from ref.geo_code_map m join meta.source s on s.id = m.source_id where s.code = 'worldbank'`)).map((r) => r.code));
  const indicators = await q<{ id: number; code: string; n: string }>(`
    select i.id, i.external_code as code, count(o.*) filter (where o.withdrawn_at is null) as n
    from core.indicator i left join core.series s on s.indicator_id = i.id left join core.observation o on o.series_id = s.id
    group by i.id, i.external_code order by i.external_code`);
  const counts = [];
  for (const ind of indicators) {
    const { total, rows } = await wb(`/country/all/indicator/${ind.code}?format=json&per_page=30000&source=2`);
    const nonNull = rows.filter((r) => r.value !== null);
    const known = nonNull.filter((r) => geoCodes.has(r.countryiso3code || r.country.id));
    counts.push({ indicator: ind.code, api_total: total, api_non_null: nonNull.length, api_known_geo: known.length, db: Number(ind.n), match: Number(ind.n) === known.length });
  }
  report.counts = counts;
  notice('Conteo por indicador: base vs API', counts.map((c) => `${c.match ? 'OK ' : 'DIF'} ${c.indicator}: base ${c.db} | API no nulos ${c.api_non_null} (geografía conocida ${c.api_known_geo}) | filas API ${c.api_total}`));

  // 2. Muestra aleatoria reproducible.
  await q(`select setseed(0.42)`);
  const sample = await q<{ indicator: string; geo: string; year: number; value: string }>(`
    select i.external_code as indicator, coalesce(c.iso3::text, r.code) as geo, extract(year from o.period_start)::int as year, o.value::text as value
    from core.observation o join core.series s on s.id = o.series_id join core.indicator i on i.id = s.indicator_id
    left join ref.country c on c.id = s.country_id left join ref.region r on r.id = s.region_id
    where o.withdrawn_at is null order by random() limit 20`);
  const checks = [];
  for (const s of sample) {
    const { rows } = await wb(`/country/${s.geo}/indicator/${s.indicator}?format=json&date=${s.year}&source=2`);
    const api = rows[0]?.value ?? null;
    checks.push({ ...s, api, match: api !== null && Number(s.value) === api });
  }
  report.sample = checks;
  notice(
    `Muestra: ${checks.filter((c) => c.match).length} de ${checks.length} coinciden con la API`,
    checks.map((c) => `${c.match ? 'OK ' : 'DIF'} ${c.indicator} ${c.geo} ${c.year}: base ${c.value} | API ${c.api}`),
  );

  // 3. Rendimiento como anon (solo en esta base de pruebas: se aprueba y publica para poder medir).
  await q(`update meta.source set status = 'approved' where code = 'worldbank'`);
  await q(`update meta.dataset set is_public = true where code like 'worldbank:%'`);
  const client = await db.connect();
  const times: number[] = [];
  let rowsReturned = 0;
  try {
    await client.query('set role anon');
    for (let i = 0; i < 5; i++) {
      const plan = await client.query(
        `explain (analyze, format json) select * from api.get_series('worldbank:NY.GDP.MKTP.CD', array['ESP','FRA','DEU'], 2000, 2024)`,
      );
      const root = plan.rows[0]['QUERY PLAN'][0];
      times.push(root['Execution Time']);
      rowsReturned = root.Plan['Actual Rows'];
    }
  } finally {
    await client.query('reset role');
    client.release();
  }
  times.sort((a, b) => a - b);
  const total = await q<{ n: string }>(`select count(*) as n from core.observation`);
  report.performance = { query: "get_series('worldbank:NY.GDP.MKTP.CD', ESP/FRA/DEU, 2000-2024)", rows: rowsReturned, median_ms: times[2], runs_ms: times, observations_in_db: Number(total[0]!.n) };
  notice('Rendimiento get_series como anon', [
    `Filas devueltas: ${rowsReturned}; mediana ${times[2]?.toFixed(2)} ms (5 ejecuciones: ${times.map((t) => t.toFixed(2)).join(', ')} ms)`,
    `Observaciones totales en base: ${total[0]!.n}`,
  ]);

  report.http_requests_verification = http.stats.requests;
  console.log(JSON.stringify(report, null, 2));
  await db.end();

  const ok = counts.every((c) => c.match) && checks.every((c) => c.match);
  process.exit(ok ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error(`::error title=Verificación fallida::${String(error instanceof Error ? error.stack : error).replace(/\n/g, '%0A')}`);
  process.exit(1);
});
