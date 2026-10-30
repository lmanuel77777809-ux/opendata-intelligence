// Resuelve la configuración de Supabase para los workflows, por una de dos vías:
//
//  A. Automática (token): SUPABASE_ACCESS_TOKEN + SUPABASE_DB_PASSWORD [+ INGEST_WRITER_PASSWORD].
//     Con la API de administración de Supabase localiza el proyecto (SUPABASE_PROJECT_REF o, si no,
//     el proyecto llamado "opendata-intelligence"), obtiene el servidor del pooler y la clave
//     publicable y, con --ensure-api-schema, publica el esquema api en la Data API.
//  B. Manual: SUPABASE_DB_URL (cadena "Session pooler") [+ INGEST_WRITER_PASSWORD]
//     [+ SUPABASE_PUBLISHABLE_KEY].
//
// Escribe en $GITHUB_ENV: PROJECT_REF, SUPABASE_URL, SUPABASE_DB_URL, INGEST_DATABASE_URL,
// SUPABASE_PUBLISHABLE_KEY (los que haya) y, con --ingest, DATABASE_URL = INGEST_DATABASE_URL.
// Los valores con contraseña se enmascaran. Solo usa Node (sin dependencias).
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const MANAGEMENT_API = 'https://api.supabase.com/v1';
const DEFAULT_PROJECT_NAME = 'opendata-intelligence';

export function deriveSupabaseConfig(dbUrl, ingestPassword) {
  if (!dbUrl) throw new Error('Falta el secreto SUPABASE_DB_URL');
  let url;
  try {
    url = new URL(dbUrl.trim());
  } catch {
    throw new Error('SUPABASE_DB_URL no es una dirección válida: cópiala de Connect → Session pooler');
  }
  if (!/^postgres(ql)?:$/.test(url.protocol)) {
    throw new Error('SUPABASE_DB_URL debe empezar por postgresql://');
  }
  if (/^db\..+\.supabase\.co$/.test(url.hostname)) {
    throw new Error('SUPABASE_DB_URL es la conexión directa (solo IPv6, no funciona en GitHub Actions): usa Connect → Session pooler');
  }
  const user = decodeURIComponent(url.username);
  const match = /^postgres\.([a-z0-9]{10,40})$/.exec(user);
  if (!match) {
    throw new Error('El usuario de SUPABASE_DB_URL debe ser postgres.<ref>: usa la cadena de Connect → Session pooler');
  }
  const password = decodeURIComponent(url.password);
  if (!password || password.includes('YOUR-PASSWORD')) {
    throw new Error('Falta la contraseña de la base en SUPABASE_DB_URL (sustituye [YOUR-PASSWORD])');
  }
  if (url.port === '6543') {
    throw new Error('SUPABASE_DB_URL usa el puerto 6543 (Transaction pooler): usa Session pooler, puerto 5432');
  }

  const ref = match[1];
  const config = { PROJECT_REF: ref, SUPABASE_URL: `https://${ref}.supabase.co` };
  if (ingestPassword) {
    const ingest = new URL(url.toString());
    ingest.username = `ingest_writer.${ref}`;
    ingest.password = ingestPassword;
    config.INGEST_DATABASE_URL = ingest.toString();
  }
  return config;
}

/** Cadena del pooler en modo sesión (puerto 5432), con la contraseña codificada. */
export function buildPoolerUrl({ ref, host, password }) {
  const url = new URL(`postgresql://user@${host}:5432/postgres`);
  url.username = `postgres.${ref}`;
  url.password = password;
  return url.toString();
}

export function pickProjectRef(projects, { ref, name = DEFAULT_PROJECT_NAME }) {
  const list = Array.isArray(projects) ? projects : [];
  const refOf = (p) => p?.id ?? p?.ref;
  const matches = ref ? list.filter((p) => refOf(p) === ref) : list.filter((p) => p?.name === name);
  if (matches.length === 0) {
    throw new Error(ref ? `El token no da acceso a ningún proyecto con referencia ${ref}` : `El token no da acceso a ningún proyecto llamado "${name}"`);
  }
  if (matches.length > 1) {
    throw new Error(`Hay ${matches.length} proyectos llamados "${name}" (${matches.map(refOf).join(', ')}): define la variable SUPABASE_PROJECT_REF`);
  }
  return refOf(matches[0]);
}

export function pickPoolerHost(pooler) {
  const list = (Array.isArray(pooler) ? pooler : [pooler]).filter((p) => p?.db_host);
  const primary = list.find((p) => (p.database_type ?? 'PRIMARY') === 'PRIMARY') ?? list[0];
  if (!primary) throw new Error('La API de Supabase no devolvió el servidor del pooler');
  return primary.db_host;
}

/** Clave publicable (sb_publishable_…); si el proyecto no la tiene, la anon heredada. Nunca una secreta. */
export function pickPublishableKey(keys) {
  const list = Array.isArray(keys) ? keys : [];
  const publishable = list.find((k) => k?.type === 'publishable' || String(k?.api_key ?? '').startsWith('sb_publishable_'));
  const anon = list.find((k) => k?.name === 'anon' && k?.api_key);
  const key = publishable?.api_key ?? anon?.api_key;
  if (!key) throw new Error('No se encontró la clave publicable del proyecto');
  return key;
}

/** Lista de esquemas expuestos con api añadido, o null si ya estaba. */
export function withApiSchema(dbSchema) {
  const schemas = String(dbSchema ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return schemas.includes('api') ? null : [...schemas, 'api'].join(', ');
}

export async function resolveWithManagementApi({ token, ref, name, dbPassword, ingestPassword, ensureApiSchema = false, fetchImpl = fetch }) {
  const call = async (path, init = {}) => {
    const res = await fetchImpl(`${MANAGEMENT_API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    });
    const text = await res.text();
    if (res.status === 401) throw new Error('El token de Supabase no es válido o caducó (HTTP 401)');
    if (!res.ok) throw new Error(`API de Supabase ${init.method ?? 'GET'} ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };

  const projectRef = ref || pickProjectRef(await call('/projects'), { name });
  const host = pickPoolerHost(await call(`/projects/${projectRef}/config/database/pooler`));
  const publishableKey = pickPublishableKey(await call(`/projects/${projectRef}/api-keys`));

  let exposedSchemas = null;
  if (ensureApiSchema) {
    const postgrest = await call(`/projects/${projectRef}/postgrest`);
    const next = withApiSchema(postgrest?.db_schema);
    if (next) {
      await call(`/projects/${projectRef}/postgrest`, { method: 'PATCH', body: JSON.stringify({ db_schema: next }) });
      exposedSchemas = next;
    }
  }

  const dbUrl = buildPoolerUrl({ ref: projectRef, host, password: dbPassword });
  return {
    config: { ...deriveSupabaseConfig(dbUrl, ingestPassword), SUPABASE_DB_URL: dbUrl, SUPABASE_PUBLISHABLE_KEY: publishableKey },
    exposedSchemas,
  };
}

async function main() {
  const env = process.env;
  const args = process.argv.slice(2);
  let config;
  let exposedSchemas = null;
  if (env.SUPABASE_ACCESS_TOKEN) {
    if (!env.SUPABASE_DB_PASSWORD) throw new Error('Falta el secreto SUPABASE_DB_PASSWORD (la contraseña con la que se creó el proyecto)');
    ({ config, exposedSchemas } = await resolveWithManagementApi({
      token: env.SUPABASE_ACCESS_TOKEN,
      ref: env.SUPABASE_PROJECT_REF,
      name: env.SUPABASE_PROJECT_NAME || DEFAULT_PROJECT_NAME,
      dbPassword: env.SUPABASE_DB_PASSWORD,
      ingestPassword: env.INGEST_WRITER_PASSWORD,
      ensureApiSchema: args.includes('--ensure-api-schema'),
    }));
  } else {
    config = deriveSupabaseConfig(env.SUPABASE_DB_URL, env.INGEST_WRITER_PASSWORD);
    config.SUPABASE_DB_URL = env.SUPABASE_DB_URL.trim();
    if (env.SUPABASE_PUBLISHABLE_KEY) config.SUPABASE_PUBLISHABLE_KEY = env.SUPABASE_PUBLISHABLE_KEY;
  }
  if (args.includes('--ingest')) {
    if (!config.INGEST_DATABASE_URL) throw new Error('Falta el secreto INGEST_WRITER_PASSWORD');
    config.DATABASE_URL = config.INGEST_DATABASE_URL;
  }

  for (const key of ['SUPABASE_DB_URL', 'INGEST_DATABASE_URL', 'DATABASE_URL']) {
    if (config[key]) console.log(`::add-mask::${config[key]}`);
  }
  if (env.GITHUB_ENV) {
    appendFileSync(env.GITHUB_ENV, `${Object.entries(config).map(([k, v]) => `${k}=${v}`).join('\n')}\n`);
  }
  const via = env.SUPABASE_ACCESS_TOKEN ? 'API de administración' : 'SUPABASE_DB_URL';
  console.log(`Proyecto Supabase ${config.PROJECT_REF} (${config.SUPABASE_URL}), configurado vía ${via}`);
  if (exposedSchemas) console.log(`::notice title=Data API::Esquemas expuestos: ${exposedSchemas}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.log(`::error title=Configuración de Supabase::${error.message}`);
    process.exit(1);
  });
}
