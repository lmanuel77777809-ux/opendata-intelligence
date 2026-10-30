# Sprint 1 — Evidencia

Fecha: 2026-10-30. Pruebas reales ejecutadas en GitHub Actions (`ubuntu-24.04`, PostgreSQL 16),
porque la red del contenedor de desarrollo bloquea las API de los proveedores.

**Resultado:** el flujo API real → extracción → PostgreSQL → consulta funciona con el Banco
Mundial. Se cargaron **163.525 observaciones reales** de 12 indicadores; los conteos coinciden con
la API en 12 de 12 indicadores, 20 de 20 valores al azar coinciden exactamente y la segunda carga
no añade ni modifica nada. Los datos se cargaron en una base efímera de CI: aún no hay Supabase
(Sprint 2) y ninguna fuente está aprobada en producción.

Ejecuciones de referencia:
[CI](https://github.com/lmanuel77777809-ux/opendata-intelligence/actions/runs/40989439555) ·
[Validación con API reales](https://github.com/lmanuel77777809-ux/opendata-intelligence/actions/runs/40989439467) ·
[primera validación, con el fallo pasajero](https://github.com/lmanuel77777809-ux/opendata-intelligence/actions/runs/40988633615)

## Criterios de aceptación

| Criterio | Resultado |
| --- | --- |
| Filas cargadas = valores no nulos que publica la API, por indicador | Cumplido: 12 de 12 |
| Segunda ejecución: 0 nuevas, 0 modificadas, 0 duplicados | Cumplido: 163.525 iguales |
| 20 de 20 muestras coinciden con el proveedor | Cumplido: 20 de 20, igualdad exacta |
| Pruebas unitarias, SQL e integración en verde, también en CI | Cumplido: 29 + 35 + 9 |
| `get_series` devuelve series ordenadas con fuente, unidad, licencia y fecha | Cumplido (pruebas SQL e integración; 75 filas reales en la medición) |
| Cada ejecución registra recibidos, nuevos, modificados, rechazados, duración y errores | Cumplido (tabla siguiente) |

## Ejecuciones reales

| Ejecución | Dataset | Estado | Recibidas | Nuevas | Modificadas | Iguales | Rechazadas | Sin valor | Peticiones | Duración |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1ª | `worldbank:wdi-economy` | success | 122.892 | 76.994 | 0 | 0 | 0 | 45.898 | 142 | 41,6 s |
| 1ª | `worldbank:wdi-demography` | success | 87.780 | 86.531 | 0 | 0 | 0 | 1.249 | 102 | 34,6 s |
| 2ª | `worldbank:wdi-economy` | success | 122.892 | 0 | 0 | 76.994 | 0 | 45.898 | 142 | 37,3 s |
| 2ª | `worldbank:wdi-demography` | success | 87.780 | 0 | 0 | 86.531 | 0 | 1.249 | 102 | 27,7 s |

Cuadre en todas: recibidas = nuevas + modificadas + iguales + rechazadas + sin valor.

## Conteo por indicador frente a la API

Verificación con una descarga independiente del conector. La API devuelve 17.556 filas por
indicador (266 economías y agregados × 66 años, 1960–2025), incluidas las vacías.

| Indicador | Observaciones en base | Valores no nulos en la API |
| --- | --- | --- |
| `FP.CPI.TOTL.ZG` | 11.547 | 11.547 |
| `GC.DOD.TOTL.GD.ZS` | 1.799 | 1.799 |
| `NE.EXP.GNFS.ZS` | 11.427 | 11.427 |
| `NY.GDP.MKTP.CD` | 14.811 | 14.811 |
| `NY.GDP.MKTP.KD.ZG` | 14.388 | 14.388 |
| `NY.GDP.PCAP.CD` | 14.811 | 14.811 |
| `SL.UEM.TOTL.ZS` | 8.211 | 8.211 |
| `SP.DYN.CBRT.IN` | 17.195 | 17.195 |
| `SP.DYN.CDRT.IN` | 17.195 | 17.195 |
| `SP.DYN.LE00.IN` | 17.191 | 17.191 |
| `SP.POP.TOTL` | 17.460 | 17.460 |
| `SP.URB.TOTL.IN.ZS` | 17.490 | 17.490 |

## Incidencia corregida

En la primera validación, el Banco Mundial devolvió un **HTTP 400 puntual** en la página 18 de
`SP.DYN.LE00.IN`; esa ejecución quedó `partial` sin escribir nada de ese indicador, y en la
repetición la misma página respondió bien. Desde el commit `d872cec` la descarga completa de un
indicador se repite una vez tras 30 s ante fallos pasajeros, y el intento fallido queda registrado.
En la validación siguiente no hubo errores.

## Rendimiento

`api.get_series('worldbank:NY.GDP.MKTP.CD', ESP/FRA/DEU, 2000–2024)` como `anon`: 75 filas,
mediana **101 ms** en 5 ejecuciones, con 163.525 observaciones en base. Cumple el objetivo inicial
(200 ms), pero el tiempo crece con el volumen porque la RLS se evalúa fila a fila. Queda
como tarea del Sprint 2 antes de exponer la API.

## Admisión real de las 17 fuentes

GET anónimo desde GitHub Actions, sin cabeceras de autenticación ni correo en el User-Agent.

| Fuente | Endpoints | HTTP | Lectura |
| --- | --- | --- | --- |
| Banco Mundial | 5 | 200 JSON | Acceso anónimo confirmado |
| Our World in Data | CSV + metadatos | 200 | Acceso anónimo confirmado |
| GLEIF | 2 | 200 JSON:API | Acceso anónimo confirmado |
| Wikidata | SPARQL, Action API, REST | 200 | Confirmado; SPARQL tardó 6,9 s |
| Jolpica F1 | 2 | 200 | Confirmado; licencia no comercial |
| FMI | DataMapper ×2, SDMX `api.imf.org` | 200 | Confirmado, también el SDMX nuevo |
| OCDE | estructura y datos | 200 | Confirmado; cuota baja documentada |
| BCE | 1 | 200 | Confirmado |
| Eurostat | 1 | 200 | Confirmado |
| DBpedia | 1 | 200 | Confirmado |
| WorldPop | catálogo ×2 / `stats` | 200 / 200 HTML | `stats` no devolvió JSON: no admitida |
| ONU Data Portal | indicadores / datos | 200 / **401** | Los datos exigen token: **rechazada** |
| SEC EDGAR | 2 | **403** | Esperado sin correo en el User-Agent; repetir con contacto |
| OpenLigaDB | 2 | 200 | Confirmado; licencia sin verificar |
| MusicBrainz | 2 | 200 | Confirmado |
| OMS GHO | 1 | **500** | Error del servidor; retirada anunciada |
| ONU SDG API | 1 | 200 | Confirmado; servicio declarado de prueba |

## Pruebas locales y de CI

| Suite | Resultado |
| --- | --- |
| Tipos (`pnpm typecheck`) | Sin errores |
| Unitarias (`pnpm test:unit`) | 29 de 29 |
| SQL (`pnpm db:test`) | 35 de 35 aserciones |
| Integración worker + PostgreSQL (`WITH_INTEGRATION=1 pnpm db:test`) | 9 de 9 |

Las pruebas unitarias y de integración usan datos **sintéticos** y una API del Banco Mundial
simulada; las cifras reales de este documento salen solo de la validación con API reales.

## Pendiente

- Sprint 2: proyecto Supabase, exposición del esquema `api`, optimización de la consulta pública,
  ingesta programada y consulta de Power Query.
- SEC: repetir la admisión con un correo de contacto en el User-Agent (decisión pendiente).
- El contenedor de desarrollo sigue sin red hacia los proveedores; no bloquea porque las pruebas
  reales corren en GitHub Actions.

## Cómo reproducir

```bash
pnpm install
pnpm typecheck && pnpm test:unit
WITH_INTEGRATION=1 pnpm db:test
```

Validación con API reales: workflow **Validación con API reales** (`workflow_dispatch`).
