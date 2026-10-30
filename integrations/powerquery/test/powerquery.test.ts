/**
 * Validación sintáctica de las consultas M con el analizador oficial de Microsoft
 * (@microsoft/powerquery-parser). No sustituye a la prueba en Excel/Power BI: comprueba que
 * cada fichero es una expresión M válida y que usa el patrón actualizable en el servicio.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DefaultSettings, TaskUtils } from '@microsoft/powerquery-parser';

const dir = join(import.meta.dirname, '..');
const files = readdirSync(dir).filter((f) => f.endsWith('.pq'));

describe('consultas Power Query', () => {
  it('existen las consultas esperadas', () => {
    expect(files.sort()).toEqual(
      ['Datasets.pq', 'Fuentes.pq', 'Geografias.pq', 'Indicadores.pq', 'Observaciones.pq', 'OdiApiKey.pq', 'OdiBaseUrl.pq', 'fnOdiGet.pq'].sort(),
    );
  });

  it.each(files)('%s es M válido', async (file) => {
    const task = await TaskUtils.tryLexParse(DefaultSettings, readFileSync(join(dir, file), 'utf8'));
    const ok = TaskUtils.isParseStageOk(task);
    expect(ok, ok ? '' : String((task as { error?: Error }).error?.message)).toBe(true);
  });

  it('la función usa URL base fija con RelativePath y Query (actualizable en el servicio)', () => {
    const fn = readFileSync(join(dir, 'fnOdiGet.pq'), 'utf8');
    expect(fn).toMatch(/Web\.Contents\(\s*OdiBaseUrl,/);
    expect(fn).toMatch(/RelativePath = "rest\/v1\/" & vista/);
    expect(fn).toMatch(/#"Accept-Profile" = "api"/);
    expect(fn).not.toMatch(/service_role|Authorization/);
  });

  it('las consultas solo llaman a la API propia, nunca a los proveedores', () => {
    for (const f of files) {
      const text = readFileSync(join(dir, f), 'utf8');
      expect(text, f).not.toMatch(/worldbank\.org|ourworldindata|gleif\.org|wikidata\.org|jolpi\.ca/i);
    }
  });
});
