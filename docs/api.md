# API de consulta

API REST de solo lectura sobre los datos consolidados. La sirve PostgREST (la API de datos de
Supabase) desde el esquema `api`. No hace falta conectarse a ningún proveedor.

## Acceso

| Elemento | Valor |
| --- | --- |
| URL base | `https://<proyecto>.supabase.co/rest/v1` |
| Cabecera `apikey` | Clave **publicable** de Supabase (solo lectura) |
| Cabecera `Accept-Profile` | `api` |
| Formato | JSON (por defecto) o CSV con `Accept: text/csv` |
| Máximo de filas por petición | 1000; para más, paginar |
| Descripción OpenAPI | `GET /` con `Accept: application/openapi+json`. En Supabase no está disponible con la clave publicable (restricción de la plataforma desde 2026); sí en PostgREST local |

Solo se publican datos de fuentes **aprobadas** y datasets **públicos**. Cada fila de
observaciones lleva su licencia (`license_code`).

## Recursos

| Recurso | Contenido | Clave |
| --- | --- | --- |
| `v_source` | Fuentes aprobadas: licencia, restricciones y última prueba de disponibilidad | `source_code` |
| `v_dataset` | Datasets publicados: frecuencia, última carga correcta y próxima ejecución | `dataset_code` |
| `v_indicator` | Indicadores: nombre (es/en), unidad, categoría, licencia, última actualización del proveedor | `indicator_key` (`fuente:código`) |
| `v_geo` | Países (ISO3) y agregados del proveedor | `geo_kind` + `geo_code` |
| `v_observation` | Observaciones vigentes, formato largo | `indicator_key` + `geo_kind` + `geo_code` + `frequency` + `period_start` |
| `v_observation_revision` | Historial de revisiones, retiradas y restauraciones | — |
| `rpc/get_series` | Serie de un indicador para varias geografías y años | parámetros |

Columnas de `v_observation`: `indicator_key`, `source_code`, `indicator_code`, `indicator_name`,
`unit_label`, `geo_kind`, `geo_code`, `geo_name`, `frequency` (A, Q, M, W, D), `period_label`,
`period_start`, `period_end`, `year`, `value`, `obs_status`, `license_code`, `updated_at`.

## Ejemplos

```bash
BASE=https://<proyecto>.supabase.co/rest/v1
H=(-H "apikey: $CLAVE_PUBLICABLE" -H "Accept-Profile: api")

# Indicadores disponibles
curl "${H[@]}" "$BASE/v_indicator?select=indicator_key,name_es,unit_label&order=indicator_key"

# PIB de España, Francia y Alemania, 2000–2024
curl "${H[@]}" "$BASE/v_observation?select=geo_code,year,value&indicator_key=eq.worldbank:NY.GDP.MKTP.CD&geo_code=in.(ESP,FRA,DEU)&and=(year.gte.2000,year.lte.2024)&order=geo_code,year"

# Lo mismo con la función
curl "${H[@]}" "$BASE/rpc/get_series?p_indicator_key=worldbank:NY.GDP.MKTP.CD&p_geo_codes={ESP,FRA,DEU}&p_year_from=2000&p_year_to=2024"

# Paginación con total: devuelve Content-Range: 0-999/14811
curl "${H[@]}" -H "Prefer: count=exact" "$BASE/v_observation?indicator_key=eq.worldbank:NY.GDP.MKTP.CD&order=geo_code,period_start&limit=1000&offset=0"

# CSV
curl "${H[@]}" -H "Accept: text/csv" "$BASE/v_observation?indicator_key=eq.worldbank:SP.POP.TOTL&geo_code=eq.ESP&order=year"
```

Operadores de filtro de PostgREST: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in.(…)`, `like`,
`is.null`, y combinaciones con `and=(…)` y `or=(…)`.

## Paginación estable

Ordena siempre por la clave completa (`indicator_key,geo_kind,geo_code,frequency,period_start`)
y avanza `offset` de 1000 en 1000 hasta recibir menos de 1000 filas. Así lo hacen las consultas
de Power Query.

## Errores habituales

| HTTP | Causa |
| --- | --- |
| 401 | Falta la cabecera `apikey` o la clave no es válida, o se intentó escribir |
| 404 | Recurso inexistente o no publicado (solo existe el esquema `api`) |
| 406 | `Accept-Profile` distinto de `api`, o el esquema `api` no está expuesto en Supabase |
| 400 | Filtro mal formado |

## Rendimiento medido

Con 163.525 observaciones reales del Banco Mundial (CI, PostgreSQL 16): consulta filtrada de
`v_observation` 0,16 ms y `get_series` 1,4 ms (mediana de 5, 75 filas). Ver
[evidencia del Sprint 2](sprint-2-evidencia.md).
