# ADR-001: Arquitectura base y decisiones del Sprint 1

- Estado: aceptada (aprobación del usuario, 2026-10-30)
- Contexto: informe de la Fase 0 (auditoría de API, arquitectura y plan)

## Decisiones

### 1. Ingesta con un worker Node/TypeScript, ejecutado por GitHub Actions

Supabase Edge Functions tienen límites de tiempo y CPU por invocación que no encajan con cargas
históricas largas. Un worker Node se ejecuta igual en local, en CI y en producción, sin límite
corto de duración, y se prueba con herramientas estándar. Las Edge Functions quedan para tareas
ligeras.

### 2. API propia = PostgREST sobre un esquema `api`

Vistas y funciones RPC de solo lectura, publicadas por el PostgREST de Supabase. Da filtros,
orden y paginación sin servidores adicionales y es consumible desde Power Query. Las vistas usan
`security_invoker` para que la RLS se aplique a quien consulta.

### 3. Rol `ingest_writer` en lugar de la clave `service_role`

`service_role` salta la RLS. El worker usa un rol propio con permisos mínimos: lee el catálogo,
mantiene referencia e indicadores, escribe en staging y ejecuta funciones `security definer` de
`ops`. No puede tocar `core.observation` directamente.

### 4. Observación vigente + historial de revisiones

`core.observation` guarda el valor vigente con clave `(series_id, period_start)`. Un disparador
copia cada cambio en `core.observation_revision` (append-only). La fusión usa
`INSERT … ON CONFLICT … DO UPDATE WHERE … IS DISTINCT FROM`, que la hace idempotente y permite
contar nuevas, modificadas e iguales.

### 5. Nada se borra

Si el proveedor deja de publicar un dato que tenía, en una descarga completa, se marca
`withdrawn_at` y se registra la revisión. Las observaciones y revisiones no se pueden borrar ni
editar (disparadores). Los valores nulos del proveedor no se almacenan; se cuentan en
`records_null`.

### 6. Geografía desde la API del proveedor

Países y agregados se cargan desde la API (p. ej. `/v2/country` del Banco Mundial), no a mano.
Las regiones se asocian al proveedor que las define, porque un mismo código puede significar
cosas distintas según la fuente. `ref.geo_code_map` traduce los códigos de cada proveedor.

### 7. Pruebas SQL sin Docker

El entorno no tiene daemon de Docker, así que no se usa el stack local de Supabase. Las
migraciones se prueban en PostgreSQL 16 nativo (y en CI con el servicio `postgres:16`),
emulando los roles `anon`, `authenticated` y `service_role`. Las aserciones son bloques
PL/pgSQL con `ASSERT`; cada fichero se revierte al terminar.

### 8. Admisión obligatoria en la base de datos

`ops.start_run` exige una prueba de admisión superada en los últimos 7 días para el endpoint del
dataset, y rechaza fuentes en estado `rejected`, `quarantined` o `retired`. La regla no depende
solo del código del worker.

## Consecuencias

- Hay que exponer solo el esquema `api` en la configuración de PostgREST de Supabase.
- La contraseña de `ingest_writer` y la cadena de conexión viven en secretos, nunca en el repo.
- Las pruebas de formato real del proveedor dependen de tener red hacia sus API.
