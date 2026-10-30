/**
 * Simulador de la World Bank Indicators API v2 para pruebas sin red.
 *
 * DATOS SINTÉTICOS: los valores numéricos son inventados para las pruebas y nunca se
 * cargan en una base real. La forma de las respuestas sigue la documentación del
 * Banco Mundial y debe contrastarse con una respuesta real grabada (pendiente: red bloqueada).
 */

export interface FakeCountry {
  id: string;
  iso2Code: string;
  name: string;
  nameEs: string;
  region: string; // 'NA' para agregados
  incomeLevel: string;
  lendingType: string;
}

export interface FakeObservation {
  geo: string; // countryiso3code
  geoId: string; // country.id (código de 2 caracteres del Banco Mundial)
  date: string;
  value: number | null;
  obsStatus?: string;
}

export interface FakeIndicator {
  name: string;
  nameEs: string;
  unit: string;
  sourceNote: string;
  sourceOrganization: string;
  rows: FakeObservation[];
}

export class FakeWorldBank {
  requests: string[] = [];
  lastupdated = '2026-07-01';
  /** Suma este número al total declarado de un indicador (simula respuestas incompletas). */
  totalOffset: Record<string, number> = {};
  /** Fuerza un código HTTP para las URL que cumplan el predicado. */
  forceStatus: { match: (url: URL) => boolean; status: number } | null = null;

  constructor(
    public countries: FakeCountry[],
    public indicators: Record<string, FakeIndicator>,
  ) {}

  readonly fetch = async (input: string | URL | Request): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    this.requests.push(url.toString());
    if (this.forceStatus?.match(url)) return new Response('{}', { status: this.forceStatus.status });
    if (url.hostname !== 'api.worldbank.org') return new Response('not found', { status: 404 });

    const lang = url.pathname.startsWith('/v2/es/') ? 'es' : 'en';
    const path = url.pathname.replace(/^\/v2(\/es)?/, '');
    const perPage = Number(url.searchParams.get('per_page') ?? 50);
    const page = Number(url.searchParams.get('page') ?? 1);

    if (path === '/country') {
      const items = this.countries.map((c) => ({
        id: c.id,
        iso2Code: c.iso2Code,
        name: lang === 'es' ? c.nameEs : c.name,
        region: c.region === 'NA' ? { id: 'NA', iso2code: 'NA', value: 'Aggregates' } : { id: c.region, iso2code: 'Z7', value: c.region },
        adminregion: { id: '', iso2code: '', value: '' },
        incomeLevel: { id: c.incomeLevel, iso2code: 'XD', value: c.incomeLevel },
        lendingType: { id: c.lendingType, iso2code: 'XX', value: c.lendingType },
        capitalCity: '',
        longitude: '',
        latitude: '',
      }));
      return this.paged(items, page, perPage);
    }

    let m = /^\/indicator\/([^/]+)$/.exec(path);
    if (m) {
      const code = decodeURIComponent(m[1]!);
      const ind = this.indicators[code];
      if (!ind) return this.message();
      return json([
        { page: 1, pages: 1, per_page: '50', total: 1 },
        [
          {
            id: code,
            name: lang === 'es' ? ind.nameEs : ind.name,
            unit: ind.unit,
            source: { id: '2', value: 'World Development Indicators' },
            sourceNote: ind.sourceNote,
            sourceOrganization: ind.sourceOrganization,
            topics: [],
          },
        ],
      ]);
    }

    m = /^\/country\/all\/indicator\/([^/]+)$/.exec(path);
    if (m) {
      const code = decodeURIComponent(m[1]!);
      const ind = this.indicators[code];
      if (!ind) return this.message();
      const items = ind.rows.map((r) => ({
        indicator: { id: code, value: ind.name },
        country: { id: r.geoId, value: r.geo },
        countryiso3code: r.geo,
        date: r.date,
        value: r.value,
        unit: '',
        obs_status: r.obsStatus ?? '',
        decimal: 0,
      }));
      return this.paged(items, page, perPage, this.totalOffset[code] ?? 0, { sourceid: '2', lastupdated: this.lastupdated });
    }
    return this.message();
  };

  private paged(items: unknown[], page: number, perPage: number, totalOffset = 0, extra: Record<string, string> = {}) {
    const total = items.length + totalOffset;
    const pages = Math.max(1, Math.ceil(total / perPage));
    const slice = items.slice((page - 1) * perPage, page * perPage);
    return json([{ page, pages, per_page: perPage, total, ...extra }, slice.length ? slice : null]);
  }

  private message() {
    return json([{ message: [{ id: '120', key: 'Invalid value', value: 'The provided parameter value is not valid' }] }]);
  }
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json;charset=utf-8' } });

/** Escenario sintético mínimo: 2 países, 2 agregados, 2 indicadores. */
export function syntheticScenario(): FakeWorldBank {
  return new FakeWorldBank(
    [
      { id: 'ESP', iso2Code: 'ES', name: 'Spain', nameEs: 'España', region: 'ECS', incomeLevel: 'HIC', lendingType: 'LNX' },
      { id: 'FRA', iso2Code: 'FR', name: 'France', nameEs: 'Francia', region: 'ECS', incomeLevel: 'HIC', lendingType: 'LNX' },
      { id: 'WLD', iso2Code: '1W', name: 'World', nameEs: 'Mundo', region: 'NA', incomeLevel: '', lendingType: '' },
      { id: 'ECS', iso2Code: 'Z7', name: 'Europe & Central Asia', nameEs: 'Europa y Asia central', region: 'NA', incomeLevel: '', lendingType: '' },
      { id: 'HIC', iso2Code: 'XD', name: 'High income', nameEs: 'Ingreso alto', region: 'NA', incomeLevel: '', lendingType: '' },
    ],
    {
      'SP.POP.TOTL': {
        name: 'Population, total',
        nameEs: 'Población, total',
        unit: '',
        sourceNote: 'Synthetic test indicator',
        sourceOrganization: 'Synthetic',
        rows: [
          { geo: 'ESP', geoId: 'ES', date: '2023', value: 1000 },
          { geo: 'ESP', geoId: 'ES', date: '2022', value: 990 },
          { geo: 'ESP', geoId: 'ES', date: '2021', value: null },
          { geo: 'FRA', geoId: 'FR', date: '2023', value: 2000 },
          { geo: 'WLD', geoId: '1W', date: '2023', value: 9000 },
          { geo: 'ZZZ', geoId: 'ZZ', date: '2023', value: 5 },
        ],
      },
      'SP.DYN.LE00.IN': {
        name: 'Life expectancy at birth, total (years)',
        nameEs: 'Esperanza de vida al nacer, total (años)',
        unit: '',
        sourceNote: 'Synthetic test indicator',
        sourceOrganization: 'Synthetic',
        rows: [
          { geo: 'ESP', geoId: 'ES', date: '2023', value: 80.5, obsStatus: 'E' },
          { geo: 'FRA', geoId: 'FR', date: '2023', value: 81.25 },
        ],
      },
    },
  );
}
