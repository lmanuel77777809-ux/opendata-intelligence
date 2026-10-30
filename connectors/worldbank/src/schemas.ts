import { z } from 'zod';

/**
 * Esquemas de respuesta de la World Bank Indicators API v2 (format=json).
 * Toda respuesta es un array: [metadatos de página, elementos] o, ante un parámetro
 * inválido, [{ message: [...] }] con HTTP 200.
 */

export const pageMetaSchema = z.object({
  page: z.coerce.number().int().positive(),
  pages: z.coerce.number().int().nonnegative(),
  per_page: z.coerce.number().int().positive(),
  total: z.coerce.number().int().nonnegative(),
  sourceid: z.string().nullish(),
  lastupdated: z.string().nullish(),
});
export type PageMeta = z.infer<typeof pageMetaSchema>;

const apiMessageSchema = z.tuple([
  z.object({ message: z.array(z.object({ id: z.string(), key: z.string(), value: z.string() })) }),
]);

const refSchema = z.object({ id: z.string(), iso2code: z.string().optional(), value: z.string() });

export const countrySchema = z.object({
  id: z.string(),
  iso2Code: z.string(),
  name: z.string(),
  region: refSchema,
  adminregion: refSchema.optional(),
  incomeLevel: refSchema,
  lendingType: refSchema,
});
export type WbCountry = z.infer<typeof countrySchema>;

export const indicatorSchema = z.object({
  id: z.string(),
  name: z.string(),
  unit: z.string().nullish(),
  source: z.object({ id: z.string(), value: z.string() }),
  sourceNote: z.string().nullish(),
  sourceOrganization: z.string().nullish(),
});
export type WbIndicator = z.infer<typeof indicatorSchema>;

export const observationSchema = z.object({
  indicator: z.object({ id: z.string(), value: z.string() }),
  country: z.object({ id: z.string(), value: z.string() }),
  countryiso3code: z.string(),
  date: z.string(),
  value: z.number().nullable(),
  unit: z.string().nullish(),
  obs_status: z.string().nullish(),
  decimal: z.number().nullish(),
});
export type WbObservation = z.infer<typeof observationSchema>;

/** Respuesta paginada de elementos del tipo dado, o mensaje de error de la API. */
export function wbResponse<T extends z.ZodType>(item: T) {
  return z.union([z.tuple([pageMetaSchema, z.array(item).nullable()]), apiMessageSchema]);
}

export type WbResponse<T> = [PageMeta, T[] | null] | [{ message: { id: string; key: string; value: string }[] }];

export function isApiMessage<T>(r: WbResponse<T>): r is [{ message: { id: string; key: string; value: string }[] }] {
  return r.length === 1;
}
