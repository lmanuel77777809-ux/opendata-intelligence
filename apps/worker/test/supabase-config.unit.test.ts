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
