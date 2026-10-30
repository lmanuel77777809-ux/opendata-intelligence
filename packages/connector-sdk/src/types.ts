import type { HttpClient, ResponseInfo } from './http.ts';
import type { Frequency } from './period.ts';

/**
 * Contrato que cumple cada conector. El worker orquesta las etapas:
 * disponibilidad → geografía → descubrimiento → consulta paginada → validación →
 * normalización → staging → fusión → registro.
 */

export interface Logger {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

export interface ConnectorContext {
  http: HttpClient;
  log: Logger;
}

export interface AvailabilityResult {
  ok: boolean;
  /** Código del endpoint en meta.endpoint que se probó. */
  endpointCode: string;
  url: string;
  httpStatus: number | null;
  contentType: string | null;
  latencyMs: number | null;
  outcome: 'pass' | 'fail_http' | 'fail_auth_required' | 'fail_network' | 'fail_format';
  detail?: string;
}

export interface CountryRecord {
  iso3: string;
  iso2: string | null;
  nameEn: string;
  nameEs: string | null;
  /** Códigos que usa el proveedor para este país (p. ej. ISO2 e ISO3). */
  providerCodes: string[];
  /** Agregados del proveedor a los que pertenece. */
  memberOf: string[];
}

export interface RegionRecord {
  code: string;
  nameEn: string;
  nameEs: string | null;
  kind: 'world' | 'geographic' | 'income_group' | 'lending_group' | 'economic_union' | 'other';
  providerCodes: string[];
}

export interface GeographySnapshot {
  countries: CountryRecord[];
  regions: RegionRecord[];
}

export interface IndicatorRecord {
  externalCode: string;
  nameEn: string;
  nameEs: string | null;
  description: string | null;
  unitLabel: string | null;
  sourceOrganization: string | null;
  providerLastUpdated: string | null;
}

export interface NormalizedObservation {
  indicatorCode: string;
  /** Código geográfico del proveedor; el worker lo traduce con ref.geo_code_map. */
  geoCode: string;
  frequency: Frequency;
  dimensions: Record<string, string>;
  periodStart: string;
  periodEnd: string;
  periodLabel: string;
  value: number;
  obsStatus: string | null;
}

export interface RejectedRecord {
  reason: string;
  raw: unknown;
}

export interface ObservationPage {
  observations: NormalizedObservation[];
  rejected: RejectedRecord[];
  /** Filas recibidas en esta página, incluidas las de valor nulo. */
  received: number;
  /** Filas con valor nulo: el proveedor no publica dato; no se almacenan. */
  nulls: number;
  /** Fecha de última actualización que declara el proveedor, si la da. */
  providerLastUpdated: string | null;
  info: ResponseInfo;
}

export interface IndicatorFetch {
  pages: AsyncIterable<ObservationPage>;
  /** true si el conector garantiza haber recibido todos los períodos publicados (permite marcar retiradas). */
  fullSnapshot: boolean;
}

export interface Connector<Config> {
  readonly sourceCode: string;
  readonly version: string;
  parseConfig(raw: unknown): Config;
  /** Prueba de admisión: petición anónima real al endpoint de datos del dataset. */
  checkAvailability(ctx: ConnectorContext, config: Config): Promise<AvailabilityResult>;
  fetchGeography?(ctx: ConnectorContext): Promise<GeographySnapshot>;
  discoverIndicators(ctx: ConnectorContext, config: Config): Promise<IndicatorRecord[]>;
  fetchIndicator(ctx: ConnectorContext, config: Config, indicatorCode: string): IndicatorFetch;
}
