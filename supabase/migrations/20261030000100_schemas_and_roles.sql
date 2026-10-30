-- Esquemas y roles base de OpenData Intelligence.
-- Compatible con PostgreSQL 15+ (Supabase). Los roles anon, authenticated y
-- service_role los crea Supabase; en pruebas locales los emula db/test/bootstrap.sql.

create schema if not exists meta;     -- catálogo: fuentes, licencias, endpoints, datasets, admisión
create schema if not exists ref;      -- referencia: países, regiones, unidades, equivalencias de códigos
create schema if not exists ops;      -- operación: ejecuciones, errores, rechazos, horarios
create schema if not exists core;     -- datos: indicadores, series, observaciones, revisiones
create schema if not exists staging;  -- área de carga temporal del worker
create schema if not exists api;      -- única superficie expuesta por PostgREST (solo lectura)

comment on schema meta is 'Catálogo de fuentes API, licencias, endpoints, datasets y pruebas de admisión';
comment on schema ref is 'Datos de referencia: países, regiones y equivalencias de códigos por proveedor';
comment on schema ops is 'Operación de la ingesta: ejecuciones, errores, rechazos y programación';
comment on schema core is 'Series temporales, observaciones vigentes e historial de revisiones';
comment on schema staging is 'Tablas de carga temporal; nunca expuestas';
comment on schema api is 'Vistas y funciones de solo lectura publicadas por PostgREST';

-- Nadie fuera del propietario usa estos esquemas salvo que se conceda explícitamente.
revoke all on schema meta, ref, ops, core, staging, api from public;

-- Las funciones nacen ejecutables por PUBLIC. Un ALTER DEFAULT PRIVILEGES por esquema no puede
-- quitar ese permiso global, así que cada migración que crea funciones lo revoca explícitamente
-- (y db/test/01_schema.test.sql comprueba que ninguna queda ejecutable por PUBLIC).

-- Rol de escritura del worker. Nace sin LOGIN: la contraseña se fija fuera de las
-- migraciones (secreto) con: alter role ingest_writer login password '...';
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'ingest_writer') then
    create role ingest_writer nologin noinherit;
  end if;
end
$$;

comment on role ingest_writer is 'Worker de ingesta: escribe en staging y ejecuta funciones de fusión; nunca borra observaciones';
