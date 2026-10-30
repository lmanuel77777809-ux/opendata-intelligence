/**
 * Contrato de la API REST propia (PostgREST sobre el esquema api), probado por HTTP.
 *
 * Variables:
 *   API_URL          base de la API: http://localhost:3000 (PostgREST local) o https://<ref>.supabase.co/rest/v1
 *   API_KEY          opcional: clave publicable de Supabase (cabecera apikey)
 *   API_FIXTURE      'synthetic' (por defecto) si la base tiene db/test/api-fixture.sql; 'real' para datos reales
 *   PAGING_INDICATOR indicador para la prueba de paginación (por defecto test_source:TEST.IND)
 *   PAGE_SIZE        tamaño de página de esa prueba (por defecto 7; Supabase sirve como máximo 1000 filas)
 *
 * Son las mismas peticiones que hacen las consultas de Power Query (integrations/powerquery).
 */
import { describe, expect, it } from 'vitest';

const API_URL = process.env.API_URL?.replace(/\/$/, '');
const API_KEY = process.env.API_KEY;
const SYNTHETIC = (process.env.API_FIXTURE ?? 'synthetic') === 'synthetic';
const PAGING_INDICATOR = process.env.PAGING_INDICATOR ?? 'test_source:TEST.IND';
const PAGE_SIZE = Number(process.env.PAGE_SIZE ?? 7);

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return {
    'Accept-Profile': 'api',
    Accept: 'application/json',
    ...(API_KEY ? { apikey: API_KEY } : {}),
    ...extra,
  };
}

async function get(path: string, extra: Record<string, string> = {}) {
  const res = await fetch(`${API_URL}${path}`, { headers: headers(extra) });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* CSV u otro formato */
  }
  return { res, body };
}

describe.skipIf(!API_URL)('API REST (PostgREST, esquema api)', () => {
  it('publica la descripción OpenAPI con las vistas de api', async () => {
    const { res, body } = await get('/', { Accept: 'application/openapi+json' });
    expect(res.status).toBe(200);
    const paths = Object.keys((body as { paths: Record<string, unknown> }).paths);
    for (const p of ['/v_source', '/v_indicator', '/v_observation', '/v_geo', '/v_dataset', '/rpc/get_series']) {
      expect(paths, p).toContain(p);
    }
  });

  it('el catálogo de fuentes solo muestra fuentes aprobadas, con licencia', async () => {
    const { res, body } = await get('/v_source?select=source_code,status,license_code');
    expect(res.status).toBe(200);
    const rows = body as Array<{ source_code: string; status: string; license_code: string }>;
    expect(rows.every((r) => ['approved', 'approved_restricted', 'quarantined'].includes(r.status))).toBe(true);
    expect(rows.every((r) => r.license_code)).toBe(true);
    if (SYNTHETIC) {
      expect(rows.map((r) => r.source_code)).toContain('test_source');
      expect(rows.map((r) => r.source_code)).not.toContain('worldbank');
    }
  });

  it.runIf(SYNTHETIC)('filtra por indicador, geografía y año, y ordena', async () => {
    const q = '/v_observation?select=geo_code,year,value,license_code&indicator_key=eq.test_source:TEST.IND&geo_code=in.(ZZA)&year=gte.2005&order=year.asc';
    const { res, body } = await get(q);
    expect(res.status).toBe(200);
    const rows = body as Array<{ geo_code: string; year: number; value: number; license_code: string }>;
    expect(rows.map((r) => r.year)).toEqual([2005, 2006, 2007, 2008, 2009, 2010]);
    expect(rows.every((r) => r.geo_code === 'ZZA' && r.license_code === 'TEST-LICENSE')).toBe(true);
    expect(rows[0]!.value).toBe(22.5);
  });

  it('pagina con limit/offset y devuelve el total con Prefer: count=exact', async () => {
    const pageSize = PAGE_SIZE;
    const base = `/v_observation?select=geo_code,period_start,value&indicator_key=eq.${PAGING_INDICATOR}&order=geo_code.asc,period_start.asc`;
    const first = await get(`${base}&limit=${pageSize}&offset=0`, { Prefer: 'count=exact' });
    expect(first.res.status).toBeLessThan(300);
    const range = first.res.headers.get('content-range');
    expect(range).toMatch(/^0-\d+\/\d+$/);
    const total = Number(range!.split('/')[1]);
    expect(total).toBeGreaterThan(pageSize);

    // Recorrido completo como lo hace Power Query: hasta recibir menos filas que el tamaño de página.
    const seen = new Set<string>();
    for (let offset = 0; ; offset += pageSize) {
      const { body } = await get(`${base}&limit=${pageSize}&offset=${offset}`);
      const rows = body as Array<{ geo_code: string; period_start: string }>;
      for (const r of rows) seen.add(`${r.geo_code}|${r.period_start}`);
      if (rows.length < pageSize) break;
    }
    expect(seen.size).toBe(total);
  });

  it('acepta exactamente la consulta que construye Power Query (fnOdiGet + Observaciones.pq)', async () => {
    // Mismos parámetros y codificación que Web.Contents con Query = [...].
    const params = new URLSearchParams({
      select: 'indicator_key,geo_kind,geo_code,geo_name,frequency,period_label,period_start,year,value,obs_status,license_code,updated_at',
      order: 'indicator_key.asc,geo_kind.asc,geo_code.asc,frequency.asc,period_start.asc',
      indicator_key: `in.(${PAGING_INDICATOR})`,
      and: '(year.gte.2000,year.lte.2004)',
      limit: '1000',
      offset: '0',
    });
    const { res, body } = await get(`/v_observation?${params.toString()}`, { Prefer: 'count=exact' });
    expect(res.status).toBeLessThan(300);
    const rows = body as Array<{ indicator_key: string; year: number; value: number; license_code: string }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.indicator_key === PAGING_INDICATOR && r.year >= 2000 && r.year <= 2004 && r.license_code)).toBe(true);
    // La primera página trae min(total, 1000) filas; con datos reales el total puede superar 1000.
    const total = Number(res.headers.get('content-range')!.split('/')[1]);
    expect(rows.length).toBe(Math.min(total, 1000));
  });

  it('get_series por RPC (GET y POST) devuelve la serie ordenada', async () => {
    const indicator = SYNTHETIC ? 'test_source:TEST.IND' : PAGING_INDICATOR;
    const geo = SYNTHETIC ? 'ZZB' : (process.env.PAGING_GEO ?? 'ESP');
    const viaGet = await get(`/rpc/get_series?p_indicator_key=${indicator}&p_geo_codes={${geo}}&p_year_from=2000&p_year_to=2004`);
    expect(viaGet.res.status).toBe(200);
    const rows = viaGet.body as Array<{ geo_code: string; year: number }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.geo_code === geo && r.year >= 2000 && r.year <= 2004)).toBe(true);
    expect(rows.map((r) => r.year)).toEqual([...rows.map((r) => r.year)].sort((a, b) => a - b));

    const res = await fetch(`${API_URL}/rpc/get_series`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json', 'Content-Profile': 'api' }),
      body: JSON.stringify({ p_indicator_key: indicator, p_geo_codes: [geo], p_year_from: 2000, p_year_to: 2004 }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(rows);
  });

  it('entrega CSV si se pide (útil para Excel)', async () => {
    const { res, body } = await get(`/v_observation?select=geo_code,year,value&indicator_key=eq.${PAGING_INDICATOR}&limit=3&order=geo_code,year`, {
      Accept: 'text/csv',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/csv/);
    expect(String(body).split('\n')[0]).toBe('geo_code,year,value');
  });

  it('rechaza escrituras', async () => {
    const res = await fetch(`${API_URL}/v_observation`, {
      method: 'POST',
      headers: headers({ 'Content-Type': 'application/json', 'Content-Profile': 'api' }),
      body: JSON.stringify({ geo_code: 'XXX', value: 1 }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const del = await fetch(`${API_URL}/v_observation?geo_code=eq.ZZA`, { method: 'DELETE', headers: headers({ 'Content-Profile': 'api' }) });
    expect(del.status).toBeGreaterThanOrEqual(400);
  });

  it('no expone tablas internas ni otros esquemas', async () => {
    expect((await get('/ingestion_error')).res.status).toBe(404);
    expect((await get('/observation')).res.status).toBe(404);
    expect((await get('/observation', { 'Accept-Profile': 'core' })).res.status).toBe(406);
    expect((await get('/rpc/merge_observations?p_run_id=1')).res.status).toBe(404);
  });
});
