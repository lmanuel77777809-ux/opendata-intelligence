import { parseArgs } from 'node:util';
import { connectors, createPool, jsonLog, userAgent } from './app.ts';
import { dueDatasets } from './repository.ts';
import { runDataset, type RunOutcome } from './runner.ts';

const USAGE = `Uso:
  pnpm ingest run <dataset>      Ejecuta un dataset (p. ej. worldbank:wdi-economy)
  pnpm ingest due                Ejecuta todos los datasets vencidos
Variables:
  DATABASE_URL   conexión PostgreSQL (rol ingest_writer)
  DB_ROLE        opcional: rol a asumir tras conectar (pruebas locales)
  ODI_CONTACT    opcional: contacto para el User-Agent
  NODE_USE_ENV_PROXY=1 si la salida a internet pasa por HTTPS_PROXY`;

const exitCode = (o: RunOutcome) => (o.status === 'success' ? 0 : o.status === 'partial' ? 2 : 1);

async function main(argv: string[]): Promise<number> {
  const { positionals } = parseArgs({ args: argv, allowPositionals: true });
  const [command, arg] = positionals;
  const url = process.env.DATABASE_URL;
  if (!url || (command !== 'run' && command !== 'due') || (command === 'run' && !arg)) {
    console.error(USAGE);
    return 64;
  }
  const pool = createPool(url, process.env.DB_ROLE);
  try {
    const opts = { trigger: 'manual' as const, userAgent: userAgent(), connectors, log: jsonLog };
    if (command === 'run') {
      const outcome = await runDataset(pool, arg!, opts);
      console.log(JSON.stringify(outcome, null, 2));
      return exitCode(outcome);
    }
    let worst = 0;
    for (const code of await dueDatasets(pool)) {
      const outcome = await runDataset(pool, code, { ...opts, trigger: 'schedule' });
      console.log(JSON.stringify(outcome, null, 2));
      worst = Math.max(worst, exitCode(outcome));
    }
    return worst;
  } finally {
    await pool.end();
  }
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error: unknown) => {
    jsonLog.error('Fallo no controlado', { error: error instanceof Error ? error.stack : String(error) });
    process.exit(1);
  },
);
