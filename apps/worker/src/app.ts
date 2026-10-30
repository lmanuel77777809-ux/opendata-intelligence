import pg from 'pg';
import type { Connector, Logger } from '@odi/connector-sdk';
import { worldBankConnector } from '@odi/connector-worldbank';
import type { ConnectorRegistry } from './runner.ts';

export const connectors: ConnectorRegistry = {
  worldbank: worldBankConnector as Connector<unknown>,
};

export function userAgent(contact = process.env.ODI_CONTACT): string {
  const repo = 'https://github.com/lmanuel77777809-ux/opendata-intelligence';
  return `OpenDataIntelligence/0.1 (+${repo}${contact ? `; contact: ${contact}` : ''})`;
}

export const jsonLog: Logger = {
  info: (message, data) => console.error(JSON.stringify({ level: 'info', message, ...data })),
  warn: (message, data) => console.error(JSON.stringify({ level: 'warn', message, ...data })),
  error: (message, data) => console.error(JSON.stringify({ level: 'error', message, ...data })),
};

/** Pool de conexiones. Con `role`, cada conexión asume ese rol (pruebas locales como superusuario). */
export function createPool(connectionString: string, role?: string): pg.Pool {
  if (role !== undefined && !/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error(`Nombre de rol no válido: ${role}`);
  return new pg.Pool({
    connectionString,
    max: 4,
    application_name: 'odi-worker',
    // El parámetro de arranque "role" equivale a SET ROLE antes de la primera consulta.
    ...(role ? { options: `-c role=${role}` } : {}),
  });
}
