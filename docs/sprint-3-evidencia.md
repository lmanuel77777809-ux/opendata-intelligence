# Sprint 3 — Evidencia (producción en Supabase)

Fecha: 2026-10-30. Proyecto Supabase `opendata-intelligence` (East US, plan gratuito). Todo se
ejecutó desde GitHub Actions con la configuración por token (`scripts/supabase-config.mjs`).

**Resultado:** la base está desplegada en Supabase, cargada con los 163.525 datos reales del
Banco Mundial y verificada contra la API del proveedor. La API pública responde con la clave
publicable. Excel lee los datos desde Supabase. **Falta** el modelo completo en Excel/Power BI y comprobar
la primera ejecución programada.

## Ejecuciones

| Paso | Resultado | Ejecución |
| --- | --- | --- |
| S3-4 Despliegue | 13 migraciones aplicadas; esquema `api` expuesto en la Data API (`public, graphql_public, api`); `ingest_writer` habilitado; `GET /rest/v1/v_source` → HTTP 200 (`worldbank`, `approved`) | [41090005541](https://github.com/lmanuel77777809-ux/opendata-intelligence/actions/runs/41090005541) |
| S3-5 Primera carga | `wdi-demography`: 86.531 nuevas (102 peticiones, 44,5 s); `wdi-economy`: 76.994 nuevas (142 peticiones, 53,8 s); 0 rechazadas | [41090112222](https://github.com/lmanuel77777809-ux/opendata-intelligence/actions/runs/41090112222) |
| S3-6 Verificación de datos | Conteo por indicador: 12 de 12 iguales a la API; muestra al azar: 20 de 20 iguales | [41091004238](https://github.com/lmanuel77777809-ux/opendata-intelligence/actions/runs/41091004238) |
| S3-7 Segunda carga | `wdi-economy`: 0 nuevas, 0 modificadas, 76.994 iguales; `wdi-demography`: 0 nuevas, 0 modificadas, 86.531 iguales | [41091123125](https://github.com/lmanuel77777809-ux/opendata-intelligence/actions/runs/41091123125) · [41091140937](https://github.com/lmanuel77777809-ux/opendata-intelligence/actions/runs/41091140937) |
| S3-8 Contrato REST en Supabase | 8 superadas, 0 fallidas, 2 omitidas por diseño (una solo para datos sintéticos; otra solo para PostgREST local) | [41091004238](https://github.com/lmanuel77777809-ux/opendata-intelligence/actions/runs/41091004238) |
| S3-9 Excel / Power BI | Excel (Microsoft 365, Windows), consulta `PruebaRapida.pq` contra Supabase con la clave publicable y acceso anónimo: 250 filas, 6 columnas (PIB y población de ARG, COL, ESP, MEX y USA, 2000–2024). Pendientes: el modelo completo, la actualización y Power BI | Captura del usuario, 2026-10-30 |
| S3-10 Ejecución programada | **Pendiente**: primera a las 05:17 UTC del 2026-10-31 | — |

## Rendimiento en Supabase

PIB de ESP, FRA y DEU, 2000–2024 (75 filas), como `anon`, mediana de 5 ejecuciones.

| Consulta | CI (PostgreSQL 16) | Supabase |
| --- | --- | --- |
| `api.get_series` (RPC) | 1,4–2,6 ms | 4,5–4,8 ms |
| `v_observation` filtrada (lo que pide Power Query) | 0,16–0,28 ms | 0,46–0,50 ms |

## Incidencia: descripción OpenAPI

La primera verificación ([41090469393](https://github.com/lmanuel77777809-ux/opendata-intelligence/actions/runs/41090469393))
dio 7 superadas y 1 fallida: `GET /rest/v1/` (descripción OpenAPI) devolvía HTTP 401 con la clave
publicable. Es una restricción deliberada de Supabase desde 2026: la descripción del esquema solo
se sirve con claves secretas
([changelog](https://supabase.com/changelog/42949-breaking-change-removing-access-to-openapi-spec-via-the-anon-key)).
No afecta a Excel/Power BI, que consultan las vistas directamente. Cambio (commit `a3a28a2`): en
Supabase el contrato comprueba que la clave publicable **no** puede leer el esquema (401); en
PostgREST local sigue exigiendo la descripción completa (CI:
[41090851369](https://github.com/lmanuel77777809-ux/opendata-intelligence/actions/runs/41090851369), 9 superadas y 1 omitida).

## Configuración en GitHub

Secretos `SUPABASE_ACCESS_TOKEN`, `SUPABASE_DB_PASSWORD` e `INGEST_WRITER_PASSWORD`. El
despliegue informa de qué secretos existen (sin mostrar valores) y de si alguno está por error
en Variables.
