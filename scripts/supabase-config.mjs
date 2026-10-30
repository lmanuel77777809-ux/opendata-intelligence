// Deriva la configuración de Supabase a partir de la cadena "Session pooler" (SUPABASE_DB_URL),
// para que el responsable solo tenga que copiar esa cadena y elegir una contraseña de ingesta.
//   - PROJECT_REF y SUPABASE_URL salen del usuario postgres.<ref>.
//   - INGEST_DATABASE_URL = misma cadena con usuario ingest_writer.<ref> y INGEST_WRITER_PASSWORD.
// Uso en GitHub Actions: node scripts/supabase-config.mjs  (lee las variables de entorno, enmascara
// los valores secretos y los añade a $GITHUB_ENV). Sin Node ni dependencias externas.
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const config = deriveSupabaseConfig(process.env.SUPABASE_DB_URL, process.env.INGEST_WRITER_PASSWORD);
    if (config.INGEST_DATABASE_URL) console.log(`::add-mask::${config.INGEST_DATABASE_URL}`);
    const lines = Object.entries(config).map(([k, v]) => `${k}=${v}`);
    if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, `${lines.join('\n')}\n`);
    console.log(`Proyecto Supabase: ${config.PROJECT_REF} (${config.SUPABASE_URL})${config.INGEST_DATABASE_URL ? '; conexión de ingesta derivada' : ''}`);
  } catch (error) {
    console.log(`::error title=Configuración de Supabase::${error.message}`);
    process.exit(1);
  }
}
