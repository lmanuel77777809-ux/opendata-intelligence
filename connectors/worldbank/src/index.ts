import { z } from 'zod';
import {
  availabilityFromError,
  ConnectorError,
  IncompleteResponseError,
  parsePeriod,
  type AvailabilityResult,
  type Connector,
  type ConnectorContext,
  type CountryRecord,
  type GeographySnapshot,
  type IndicatorFetch,
  type IndicatorRecord,
  type NormalizedObservation,
  type ObservationPage,
  type RegionRecord,
  type RejectedRecord,
  type ResponseInfo,
} from '@odi/connector-sdk';
import {
  countrySchema,
  indicatorSchema,
  isApiMessage,
  observationSchema,
  wbResponse,
  type PageMeta,
  type WbCountry,
  type WbResponse,
} from './schemas.ts';

export const API_ROOT = 'https://api.worldbank.org/v2';
export const DATA_ENDPOINT = 'indicator_data_v2';

export const configSchema = z.object({
  /** Base de datos del Banco Mundial (2 = World Development Indicators). */
  wb_source_id: z.number().int().positive(),
  per_page: z.number().int().min(1).max(20_000).default(1_000),
  indicators: z.array(z.string().regex(/^[A-Za-z0-9._]+$/)).min(1),
});
export type WorldBankConfig = z.infer<typeof configSchema>;

type Lang = 'en' | 'es';

export function buildUrl(path: string, params: Record<string, string | number> = {}, lang: Lang = 'en'): string {
  const url = new URL(`${API_ROOT}${lang === 'en' ? '' : `/${lang}`}${path}`);
  url.searchParams.set('format', 'json');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  return url.toString();
}

const seg = (code: string) => encodeURIComponent(code);

interface Page<T> {
  meta: PageMeta;
  items: T[];
  info: ResponseInfo;
}

/**
 * Recorre todas las páginas de un recurso y comprueba que cuadran con el total declarado.
 * Si faltan o sobran filas lanza IncompleteResponseError al final, antes de que nada se guarde.
 */
async function* allPages<T extends z.ZodType>(
  ctx: ConnectorContext,
  item: T,
  path: string,
  params: Record<string, string | number>,
  lang: Lang = 'en',
): AsyncGenerator<Page<z.infer<T>>> {
  const schema = wbResponse(item);
  let page = 1;
  let seen = 0;
  let first: PageMeta | undefined;
  for (;;) {
    const url = buildUrl(path, { ...params, page }, lang);
    const { data, info } = await ctx.http.getJson(url, schema);
    const response = data as WbResponse<z.infer<T>>;
    if (isApiMessage(response)) {
      const text = response[0].message.map((m) => `${m.key}: ${m.value}`).join('; ');
      throw new ConnectorError('api_message', `El Banco Mundial respondió con un mensaje de error: ${text}`, { url });
    }
    const [meta, items] = response;
    first ??= meta;
    if (meta.page !== page || meta.total !== first.total || meta.pages !== first.pages) {
      throw new IncompleteResponseError(url, `Paginación inconsistente: página ${meta.page}/${meta.pages}, total ${meta.total} (inicio ${first.total})`);
    }
    const rows = items ?? [];
    seen += rows.length;
    yield { meta, items: rows, info };
    if (page >= meta.pages) break;
    page += 1;
  }
  if (seen !== first.total) {
    throw new IncompleteResponseError(buildUrl(path, params, lang), `Se recibieron ${seen} filas y el proveedor declara ${first.total}`);
  }
}

async function collect<T extends z.ZodType>(ctx: ConnectorContext, item: T, path: string, params: Record<string, string | number>, lang: Lang = 'en') {
  const out: z.infer<T>[] = [];
  for await (const page of allPages(ctx, item, path, params, lang)) out.push(...page.items);
  return out;
}

/** Intenta obtener la versión en español; si falla, sigue sin ella y lo deja en el log. */
async function optionalSpanish<T>(ctx: ConnectorContext, what: string, load: () => Promise<T>): Promise<T | null> {
  try {
    return await load();
  } catch (error) {
    ctx.log.warn(`No se pudo obtener ${what} en español; se usará solo inglés`, { error: (error as Error).message });
    return null;
  }
}

const CODE3 = /^[A-Z0-9]{3}$/;
const CODE2 = /^[A-Z0-9]{2}$/;
const AGGREGATE_REGION_ID = 'NA';

export function buildGeography(english: WbCountry[], spanish: WbCountry[] | null): GeographySnapshot {
  const nameEs = new Map((spanish ?? []).map((c) => [c.id, c.name.trim()]));
  const aggregates = english.filter((c) => c.region.id === AGGREGATE_REGION_ID);
  const economies = english.filter((c) => c.region.id !== AGGREGATE_REGION_ID);
  const aggregateIds = new Set(aggregates.map((a) => a.id));

  const geographic = new Set(economies.flatMap((c) => [c.region.id, c.adminregion?.id ?? '']));
  const income = new Set(economies.map((c) => c.incomeLevel.id));
  const lending = new Set(economies.map((c) => c.lendingType.id));
  const kindOf = (id: string): RegionRecord['kind'] =>
    id === 'WLD' ? 'world' : geographic.has(id) ? 'geographic' : income.has(id) ? 'income_group' : lending.has(id) ? 'lending_group' : 'other';

  const codes = (c: WbCountry) => [c.id, ...(CODE2.test(c.iso2Code) ? [c.iso2Code] : [])];

  const regions: RegionRecord[] = aggregates
    .filter((a) => CODE3.test(a.id))
    .map((a) => ({ code: a.id, nameEn: a.name.trim(), nameEs: nameEs.get(a.id) ?? null, kind: kindOf(a.id), providerCodes: codes(a) }));

  const countries: CountryRecord[] = economies
    .filter((c) => /^[A-Z]{3}$/.test(c.id))
    .map((c) => ({
      iso3: c.id,
      iso2: CODE2.test(c.iso2Code) ? c.iso2Code : null,
      nameEn: c.name.trim(),
      nameEs: nameEs.get(c.id) ?? null,
      providerCodes: codes(c),
      memberOf: [...new Set([c.region.id, c.adminregion?.id ?? '', c.incomeLevel.id, c.lendingType.id])].filter((id) => aggregateIds.has(id)),
    }));

  return { countries, regions };
}

export function normalizeObservations(
  indicatorCode: string,
  rows: z.infer<typeof observationSchema>[],
): { observations: NormalizedObservation[]; rejected: RejectedRecord[]; nulls: number } {
  const observations: NormalizedObservation[] = [];
  const rejected: RejectedRecord[] = [];
  let nulls = 0;
  for (const row of rows) {
    if (row.indicator.id !== indicatorCode) {
      rejected.push({ reason: 'unexpected_indicator', raw: row });
      continue;
    }
    if (row.value === null) {
      nulls += 1;
      continue;
    }
    if (!Number.isFinite(row.value)) {
      rejected.push({ reason: 'non_finite_value', raw: row });
      continue;
    }
    const period = parsePeriod(row.date);
    if (!period) {
      rejected.push({ reason: 'invalid_period', raw: row });
      continue;
    }
    const geoCode = row.countryiso3code.trim() || row.country.id.trim();
    if (!geoCode) {
      rejected.push({ reason: 'missing_geo_code', raw: row });
      continue;
    }
    observations.push({
      indicatorCode,
      geoCode,
      frequency: period.frequency,
      dimensions: {},
      periodStart: period.start,
      periodEnd: period.end,
      periodLabel: period.label,
      value: row.value,
      obsStatus: row.obs_status ? row.obs_status : null,
    });
  }
  return { observations, rejected, nulls };
}

export const worldBankConnector: Connector<WorldBankConfig> = {
  sourceCode: 'worldbank',
  version: '0.1.0',

  parseConfig(raw) {
    return configSchema.parse(raw);
  },

  async checkAvailability(ctx, config): Promise<AvailabilityResult> {
    const url = buildUrl(`/country/all/indicator/${seg(config.indicators[0]!)}`, { per_page: 1, source: config.wb_source_id });
    try {
      const { data, info } = await ctx.http.getJson(url, wbResponse(observationSchema));
      const response = data as WbResponse<unknown>;
      if (isApiMessage(response)) {
        return { ok: false, endpointCode: DATA_ENDPOINT, url, httpStatus: info.status, contentType: info.contentType, latencyMs: info.latencyMs, outcome: 'fail_format', detail: 'La API devolvió un mensaje de error' };
      }
      const total = response[0].total;
      return {
        ok: total > 0,
        endpointCode: DATA_ENDPOINT,
        url,
        httpStatus: info.status,
        contentType: info.contentType,
        latencyMs: info.latencyMs,
        outcome: total > 0 ? 'pass' : 'fail_format',
        detail: `total declarado: ${total}`,
      };
    } catch (error) {
      return availabilityFromError(DATA_ENDPOINT, url, error);
    }
  },

  async fetchGeography(ctx) {
    const english = await collect(ctx, countrySchema, '/country', { per_page: 400 });
    const spanish = await optionalSpanish(ctx, 'los países', () => collect(ctx, countrySchema, '/country', { per_page: 400 }, 'es'));
    return buildGeography(english, spanish);
  },

  async discoverIndicators(ctx, config) {
    const found: IndicatorRecord[] = [];
    for (const code of config.indicators) {
      const english = await collect(ctx, indicatorSchema, `/indicator/${seg(code)}`, {}).catch((error: unknown) => {
        if (error instanceof ConnectorError && error.code === 'api_message') return [];
        throw error;
      });
      const indicator = english.find((i) => i.id === code);
      if (!indicator) continue;
      const spanish = await optionalSpanish(ctx, `el indicador ${code}`, () => collect(ctx, indicatorSchema, `/indicator/${seg(code)}`, {}, 'es'));
      found.push({
        externalCode: indicator.id,
        nameEn: indicator.name.trim(),
        nameEs: spanish?.find((i) => i.id === code)?.name.trim() ?? null,
        description: indicator.sourceNote?.trim() || null,
        unitLabel: indicator.unit?.trim() || null,
        sourceOrganization: indicator.sourceOrganization?.trim() || null,
        providerLastUpdated: null,
      });
    }
    return found;
  },

  fetchIndicator(ctx, config, indicatorCode): IndicatorFetch {
    async function* pages(): AsyncGenerator<ObservationPage> {
      const path = `/country/all/indicator/${seg(indicatorCode)}`;
      for await (const page of allPages(ctx, observationSchema, path, { per_page: config.per_page, source: config.wb_source_id })) {
        const { observations, rejected, nulls } = normalizeObservations(indicatorCode, page.items);
        yield {
          observations,
          rejected,
          nulls,
          received: page.items.length,
          providerLastUpdated: page.meta.lastupdated ?? null,
          info: page.info,
        };
      }
    }
    // Sin filtro de fechas: se recibe la serie completa, así que se pueden detectar datos retirados.
    return { pages: pages(), fullSnapshot: true };
  },
};
