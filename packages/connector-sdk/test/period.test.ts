import { describe, expect, it } from 'vitest';
import { parsePeriod } from '../src/period.ts';

describe('parsePeriod', () => {
  it('anual', () => {
    expect(parsePeriod('2023')).toEqual({ frequency: 'A', start: '2023-01-01', end: '2023-12-31', label: '2023' });
  });
  it('trimestral', () => {
    expect(parsePeriod('2024Q1')).toEqual({ frequency: 'Q', start: '2024-01-01', end: '2024-03-31', label: '2024Q1' });
    expect(parsePeriod('2023-Q4')).toMatchObject({ start: '2023-10-01', end: '2023-12-31', label: '2023Q4' });
  });
  it('mensual, incluido febrero bisiesto', () => {
    expect(parsePeriod('2024M02')).toEqual({ frequency: 'M', start: '2024-02-01', end: '2024-02-29', label: '2024-02' });
    expect(parsePeriod('2023-02')).toMatchObject({ end: '2023-02-28' });
  });
  it('diario', () => {
    expect(parsePeriod('2024-12-31')).toEqual({ frequency: 'D', start: '2024-12-31', end: '2024-12-31', label: '2024-12-31' });
  });
  it('rechaza lo que no es un período', () => {
    for (const bad of ['', '23', '2023M13', '2023Q5', '2023-02-30', 'abc', '2023-13']) {
      expect(parsePeriod(bad), bad).toBeNull();
    }
  });
});
