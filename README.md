# OpenData Intelligence

Plataforma que centraliza datos históricos y actualizados procedentes **exclusivamente de API
públicas, gratuitas y sin autenticación**, los guarda en PostgreSQL (Supabase) con historial de
revisiones y los sirve a una aplicación web, Excel y Power BI a través de una API propia.

Estado: **Sprint 1 en curso**. Ver [evidencia del Sprint 1](docs/sprint-1-evidencia.md) y
[ADR-001](docs/adr/ADR-001-stack.md).

## Regla fundamental

Solo API públicas documentadas, con acceso anónimo comprobado. Nada de scraping, ficheros
estáticos descargados, claves de proveedor, registro ni datos inventados. Una fuente no se
publica hasta que una prueba HTTP anónima real (`meta.admission_check`) la admite y se revisa su
licencia.

## Estructura

| Ruta | Contenido |
| --- | --- |
| `supabase/migrations/` | Migraciones SQL versionadas (PostgreSQL 15+) |
| `db/test/` | Aserciones SQL y emulación de roles de Supabase |
| `packages/connector-sdk/` | Cliente HTTP (lista blanca, timeouts, reintentos, límites), contrato de conector, períodos |
| `connectors/worldbank/` | Conector del Banco Mundial (Indicators API v2) |
| `apps/worker/` | Worker de ingesta y CLI `ingest` |
| `scripts/` | Pruebas de BD y prueba de admisión de las API |

## Requisitos

Node 22, pnpm 10 y PostgreSQL 15 o superior (binarios locales o servidor). No hace falta Docker.

## Comandos

```bash
pnpm install
pnpm typecheck                         # tipos
pnpm test:unit                         # pruebas unitarias
pnpm db:test                           # base nueva + migraciones + aserciones SQL
WITH_INTEGRATION=1 pnpm db:test        # además, worker completo contra PostgreSQL (API simulada)
pnpm admission                         # prueba HTTP anónima real de las 17 fuentes candidatas
```

`pnpm db:test` levanta un clúster temporal en `.tmp/pg` (puerto 54329) si encuentra los binarios de
PostgreSQL, o usa `DATABASE_URL_ADMIN` si se define (así funciona en CI).

### Ejecutar una ingesta

```bash
DATABASE_URL=postgres://ingest_writer:...@host:5432/postgres pnpm ingest run worldbank:wdi-economy
pnpm ingest due     # todos los datasets vencidos según su frecuencia
```

Detrás de un proxy HTTPS, añade `NODE_USE_ENV_PROXY=1`. `ODI_CONTACT` añade un contacto al
User-Agent (Wikidata, SEC y MusicBrainz lo exigen).

## Ciclo de admisión de una fuente

1. Se registra en `meta.source` como `candidate`, con sus hosts permitidos y endpoints.
2. Cada ejecución hace primero una petición anónima real y la guarda en `meta.admission_check`.
   Sin una prueba superada en los últimos 7 días, `ops.start_run` no abre la ejecución.
3. Tras revisar licencia y evidencia, un administrador cambia la fuente a `approved` o
   `approved_restricted` y marca sus datasets como públicos. Solo entonces los ve la API.

## Seguridad

- PostgREST debe exponer **solo** el esquema `api` (vistas `security_invoker` + RLS).
- El worker usa el rol `ingest_writer`: escribe en staging y llama a funciones de fusión; no puede
  insertar, modificar ni borrar observaciones directamente. Su contraseña se fija fuera de las
  migraciones: `alter role ingest_writer login password '...'`.
- Las observaciones y su historial no se pueden borrar ni editar.
