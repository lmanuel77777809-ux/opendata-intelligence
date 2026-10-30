/** Normalización de períodos publicados por los proveedores a fechas de inicio y fin. */

export type Frequency = 'A' | 'Q' | 'M' | 'W' | 'D';

export interface Period {
  frequency: Frequency;
  start: string; // YYYY-MM-DD
  end: string; // YYYY-MM-DD
  label: string;
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');
const iso = (y: number, m: number, d: number) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/**
 * Formatos admitidos: "2023" (anual), "2023Q1" (trimestral), "2023M01" o "2023-01" (mensual),
 * "2023-01-15" (diario). Devuelve null si el texto no es un período reconocible.
 */
export function parsePeriod(raw: string): Period | null {
  const text = raw.trim();
  let m: RegExpExecArray | null;

  if ((m = /^(\d{4})$/.exec(text))) {
    const y = Number(m[1]);
    return { frequency: 'A', start: iso(y, 1, 1), end: iso(y, 12, 31), label: text };
  }
  if ((m = /^(\d{4})-?Q([1-4])$/.exec(text))) {
    const y = Number(m[1]);
    const q = Number(m[2]);
    const endMonth = q * 3;
    return { frequency: 'Q', start: iso(y, endMonth - 2, 1), end: iso(y, endMonth, lastDay(y, endMonth)), label: `${y}Q${q}` };
  }
  if ((m = /^(\d{4})(?:M|-)(\d{2})$/.exec(text))) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    if (mo < 1 || mo > 12) return null;
    return { frequency: 'M', start: iso(y, mo, 1), end: iso(y, mo, lastDay(y, mo)), label: `${y}-${pad(mo)}` };
  }
  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text))) {
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > lastDay(y, mo)) return null;
    return { frequency: 'D', start: text, end: text, label: text };
  }
  return null;
}
