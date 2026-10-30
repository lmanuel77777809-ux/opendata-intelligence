// Cadenas de ejemplo con referencias y contraseñas inventadas: no corresponden a ningún proyecto.
import { describe, expect, it } from 'vitest';
// @ts-expect-error módulo JavaScript sin tipos
import { deriveSupabaseConfig } from '../../../scripts/supabase-config.mjs';

const REF = 'abcdefghijklmnopqrst';
const pooler = (user: string, pw: string, port = 5432) => `postgresql://${user}:${pw}@aws-0-us-east-1.pooler.supabase.com:${port}/postgres`;

describe('deriveSupabaseConfig', () => {
  it('deriva URL del proyecto y conexión de ingesta desde el Session pooler', () => {
    const c = deriveSupabaseConfig(pooler(`postgres.${REF}`, 'rio-mango-piedra-nube-silla-47'), 'otra-frase-de-prueba-12');
    expect(c.PROJECT_REF).toBe(REF);
    expect(c.SUPABASE_URL).toBe(`https://${REF}.supabase.co`);
    expect(c.INGEST_DATABASE_URL).toBe(pooler(`ingest_writer.${REF}`, 'otra-frase-de-prueba-12'));
  });

  it('codifica contraseñas con símbolos para que la cadena siga siendo válida', () => {
    const c = deriveSupabaseConfig(pooler(`postgres.${REF}`, 'x'), 'a@b:c/d');
    const u = new URL(c.INGEST_DATABASE_URL);
    expect(decodeURIComponent(u.password)).toBe('a@b:c/d');
    expect(u.hostname).toBe('aws-0-us-east-1.pooler.supabase.com');
  });

  it('sin contraseña de ingesta, no deriva la conexión de ingesta', () => {
    expect(deriveSupabaseConfig(pooler(`postgres.${REF}`, 'x'))).not.toHaveProperty('INGEST_DATABASE_URL');
  });

  it('rechaza los errores de copia habituales con un mensaje claro', () => {
    expect(() => deriveSupabaseConfig(`postgresql://postgres:x@db.${REF}.supabase.co:5432/postgres`)).toThrow(/conexión directa/);
    expect(() => deriveSupabaseConfig(pooler(`postgres.${REF}`, '[YOUR-PASSWORD]'))).toThrow(/Falta la contraseña/);
    expect(() => deriveSupabaseConfig(pooler('postgres', 'x'))).toThrow(/postgres\.<ref>/);
    expect(() => deriveSupabaseConfig(pooler(`postgres.${REF}`, 'x', 6543))).toThrow(/Session pooler/);
    expect(() => deriveSupabaseConfig('no es una url')).toThrow(/no es una dirección válida/);
    expect(() => deriveSupabaseConfig(undefined)).toThrow(/Falta el secreto/);
  });
});

describe('vía automática con la API de administración (simulada, datos inventados)', () => {
  // @ts-expect-error módulo JavaScript sin tipos
  const load = () => import('../../../scripts/supabase-config.mjs');

  function fakeApi(over: { postgrest?: string; projects?: unknown[]; status?: number } = {}) {
    const calls: Array<{ method: string; path: string; body?: string; auth: string | null }> = [];
    const routes: Record<string, unknown> = {
      '/projects': over.projects ?? [
        { id: 'zzzzzzzzzzzzzzzzzzzz', name: 'otro-proyecto' },
        { id: REF, name: 'opendata-intelligence' },
      ],
      [`/projects/${REF}/config/database/pooler`]: [
        { database_type: 'READ_REPLICA', db_host: 'replica.pooler.supabase.com' },
        { database_type: 'PRIMARY', db_host: 'aws-0-us-east-1.pooler.supabase.com', db_port: 6543 },
      ],
      [`/projects/${REF}/api-keys`]: [
        { name: 'anon', api_key: 'eyJ.anon' },
        { name: 'service_role', api_key: 'eyJ.SECRETA' },
        { name: 'default', type: 'publishable', api_key: 'sb_publishable_prueba' },
      ],
      [`/projects/${REF}/postgrest`]: { db_schema: over.postgrest ?? 'public, graphql_public', max_rows: 1000 },
    };
    const fetchImpl = async (url: string, init: RequestInit = {}) => {
      const path = url.replace('https://api.supabase.com/v1', '');
      const headers = init.headers as Record<string, string>;
      calls.push({ method: init.method ?? 'GET', path, body: init.body as string | undefined, auth: headers.Authorization ?? null });
      if (over.status) return new Response('{"message":"x"}', { status: over.status });
      if (init.method === 'PATCH') return new Response(JSON.stringify({ db_schema: JSON.parse(String(init.body)).db_schema }), { status: 200 });
      return path in routes ? new Response(JSON.stringify(routes[path]), { status: 200 }) : new Response('{}', { status: 404 });
    };
    return { calls, fetchImpl };
  }

  it('localiza el proyecto por nombre, monta las conexiones y publica el esquema api', async () => {
    const { resolveWithManagementApi } = await load();
    const api = fakeApi();
    const { config, exposedSchemas } = await resolveWithManagementApi({
      token: 'tok', dbPassword: 'frase-bd-1', ingestPassword: 'frase-ingesta-2', ensureApiSchema: true, fetchImpl: api.fetchImpl,
    });
    expect(config.PROJECT_REF).toBe(REF);
    expect(config.SUPABASE_URL).toBe(`https://${REF}.supabase.co`);
    expect(config.SUPABASE_DB_URL).toBe(pooler(`postgres.${REF}`, 'frase-bd-1'));
    expect(config.INGEST_DATABASE_URL).toBe(pooler(`ingest_writer.${REF}`, 'frase-ingesta-2'));
    expect(config.SUPABASE_PUBLISHABLE_KEY).toBe('sb_publishable_prueba');
    expect(JSON.stringify(config)).not.toContain('SECRETA');
    expect(exposedSchemas).toBe('public, graphql_public, api');
    expect(api.calls.find((c) => c.method === 'PATCH')).toMatchObject({ path: `/projects/${REF}/postgrest`, body: '{"db_schema":"public, graphql_public, api"}' });
    expect(api.calls.every((c) => c.auth === 'Bearer tok')).toBe(true);
  });

  it('no toca la Data API si el esquema api ya está expuesto', async () => {
    const { resolveWithManagementApi } = await load();
    const api = fakeApi({ postgrest: 'public,graphql_public,api' });
    const { exposedSchemas } = await resolveWithManagementApi({ token: 't', dbPassword: 'p', ensureApiSchema: true, fetchImpl: api.fetchImpl });
    expect(exposedSchemas).toBeNull();
    expect(api.calls.some((c) => c.method === 'PATCH')).toBe(false);
  });

  it('sin --ensure-api-schema solo lee', async () => {
    const { resolveWithManagementApi } = await load();
    const api = fakeApi();
    await resolveWithManagementApi({ token: 't', dbPassword: 'p', fetchImpl: api.fetchImpl });
    expect(api.calls.map((c) => c.method)).toEqual(['GET', 'GET', 'GET']);
  });

  it('explica los errores: token inválido, proyecto inexistente o duplicado', async () => {
    const { resolveWithManagementApi } = await load();
    await expect(resolveWithManagementApi({ token: 'x', dbPassword: 'p', fetchImpl: fakeApi({ status: 401 }).fetchImpl })).rejects.toThrow(/token de Supabase no es válido/);
    await expect(resolveWithManagementApi({ token: 'x', dbPassword: 'p', fetchImpl: fakeApi({ projects: [] }).fetchImpl })).rejects.toThrow(/ningún proyecto llamado "opendata-intelligence"/);
    const dup = fakeApi({ projects: [{ id: REF, name: 'opendata-intelligence' }, { id: 'yyyyyyyyyyyyyyyyyyyy', name: 'opendata-intelligence' }] });
    await expect(resolveWithManagementApi({ token: 'x', dbPassword: 'p', fetchImpl: dup.fetchImpl })).rejects.toThrow(/SUPABASE_PROJECT_REF/);
  });
});
