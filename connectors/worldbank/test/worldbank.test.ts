import { describe, expect, it } from 'vitest';
import { HttpClient, IncompleteResponseError, type ConnectorContext } from '@odi/connector-sdk';
import { buildUrl, worldBankConnector, type WorldBankConfig } from '../src/index.ts';
import { syntheticScenario, type FakeWorldBank } from './fake-api.ts';

const silent = { info() {}, warn() {}, error() {} };
const config: WorldBankConfig = { wb_source_id: 2, per_page: 2, indicators: ['SP.POP.TOTL', 'SP.DYN.LE00.IN'] };

function ctxFor(fake: FakeWorldBank): ConnectorContext {
  const http = new HttpClient({
    allowedHosts: ['api.worldbank.org'],
    userAgent: 'test',
    fetchImpl: fake.fetch as typeof fetch,
    maxRetries: 0,
  });
  return { http, log: silent };
}

async function drain(fake: FakeWorldBank, code: string) {
  const fetch = worldBankConnector.fetchIndicator(ctxFor(fake), config, code);
  const pages = [];
  for await (const p of fetch.pages) pages.push(p);
  return { pages, fullSnapshot: fetch.fullSnapshot };
}

describe('URLs', () => {
  it('construye URLs JSON con idioma opcional', () => {
    expect(buildUrl('/country', { per_page: 400 })).toBe('https://api.worldbank.org/v2/country?format=json&per_page=400');
    expect(buildUrl('/indicator/SP.POP.TOTL', {}, 'es')).toBe('https://api.worldbank.org/v2/es/indicator/SP.POP.TOTL?format=json');
  });

  it('rechaza configuraciones con códigos peligrosos', () => {
    expect(() => worldBankConnector.parseConfig({ wb_source_id: 2, indicators: ['../../etc'] })).toThrow();
    expect(worldBankConnector.parseConfig({ wb_source_id: 2, indicators: ['SP.POP.TOTL'] })).toMatchObject({ per_page: 1000 });
  });
});

describe('Conector Banco Mundial (API simulada)', () => {
  it('admisión: pass con total > 0 y fail_auth_required ante 403', async () => {
    const fake = syntheticScenario();
    const ok = await worldBankConnector.checkAvailability(ctxFor(fake), config);
    expect(ok).toMatchObject({ ok: true, outcome: 'pass', httpStatus: 200, endpointCode: 'indicator_data_v2' });

    fake.forceStatus = { match: () => true, status: 403 };
    const denied = await worldBankConnector.checkAvailability(ctxFor(fake), config);
    expect(denied).toMatchObject({ ok: false, outcome: 'fail_auth_required', httpStatus: 403 });
  });

  it('geografía: separa países y agregados, con nombres en español y pertenencias', async () => {
    const geo = await worldBankConnector.fetchGeography!(ctxFor(syntheticScenario()));
    expect(geo.countries.map((c) => c.iso3)).toEqual(['ESP', 'FRA']);
    expect(geo.countries[0]).toMatchObject({ iso2: 'ES', nameEs: 'España', providerCodes: ['ESP', 'ES'], memberOf: ['ECS', 'HIC'] });
    expect(Object.fromEntries(geo.regions.map((r) => [r.code, r.kind]))).toEqual({ WLD: 'world', ECS: 'geographic', HIC: 'income_group' });
  });

  it('descubrimiento: ignora indicadores que el proveedor no reconoce', async () => {
    const found = await worldBankConnector.discoverIndicators(ctxFor(syntheticScenario()), { ...config, indicators: ['SP.POP.TOTL', 'NO.EXISTE'] });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ externalCode: 'SP.POP.TOTL', nameEs: 'Población, total' });
  });

  it('datos: recorre todas las páginas, descarta nulos y normaliza períodos', async () => {
    const fake = syntheticScenario();
    const { pages, fullSnapshot } = await drain(fake, 'SP.POP.TOTL');
    expect(fullSnapshot).toBe(true);
    expect(pages).toHaveLength(3);
    const all = pages.flatMap((p) => p.observations);
    expect(pages.reduce((n, p) => n + p.received, 0)).toBe(6);
    expect(pages.reduce((n, p) => n + p.nulls, 0)).toBe(1);
    expect(all).toHaveLength(5);
    expect(all[0]).toMatchObject({ geoCode: 'ESP', periodStart: '2023-01-01', periodEnd: '2023-12-31', frequency: 'A', value: 1000 });
    expect(pages[0]!.providerLastUpdated).toBe('2026-07-01');
    expect(fake.requests.every((u) => u.includes('source=2') && u.includes('format=json'))).toBe(true);
  });

  it('datos: conserva la marca de estado del proveedor', async () => {
    const { pages } = await drain(syntheticScenario(), 'SP.DYN.LE00.IN');
    const obs = pages.flatMap((p) => p.observations);
    expect(obs.find((o) => o.geoCode === 'ESP')!.obsStatus).toBe('E');
    expect(obs.find((o) => o.geoCode === 'FRA')!.obsStatus).toBeNull();
  });

  it('datos: si el total declarado no cuadra con lo recibido, falla antes de entregar el lote', async () => {
    const fake = syntheticScenario();
    fake.totalOffset['SP.DYN.LE00.IN'] = 1;
    await expect(drain(fake, 'SP.DYN.LE00.IN')).rejects.toBeInstanceOf(IncompleteResponseError);
  });
});
