-- Modelo de lectura de la API (Sprint 2).
--
-- Medición (Sprint 1, datos reales): api.get_series tardaba ~100 ms para 75 filas porque la RLS
-- se evaluaba fila a fila y bloqueaba el uso de índices (las vistas eran security_invoker).
-- Cambio:
--   1. Las vistas de api pertenecen a un rol de solo lectura, api_reader, y aplican ellas mismas
--      la regla de visibilidad (fuente aprobada + dataset público). security_barrier evita que
--      filtros del usuario se evalúen antes que esa regla.
--   2. anon y authenticated ya no leen tablas: solo las vistas y funciones del esquema api.
--   3. Claves de consulta almacenadas e indexadas: core.series.geo_code y core.indicator.indicator_key.
--      Los códigos de los que salen se vuelven inmutables.

-- ---------- 1. Claves de consulta ----------

alter table core.series add column geo_code text;
update core.series s set geo_code = coalesce(
  (select c.iso3::text from ref.country c where c.id = s.country_id),
  (select r.code from ref.region r where r.id = s.region_id));
alter table core.series alter column geo_code set not null;
comment on column core.series.geo_code is 'ISO3 del país o código de la región; copia inmutable para filtrar con índice';

create function core.set_series_geo_code() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.geo_code := coalesce(
    (select c.iso3::text from ref.country c where c.id = new.country_id),
    (select r.code from ref.region r where r.id = new.region_id));
  return new;
end
$$;

create trigger series_geo_code
  before insert or update of country_id, region_id on core.series
  for each row execute function core.set_series_geo_code();

create index series_indicator_geo_idx on core.series (indicator_id, geo_code);
create index series_geo_idx on core.series (geo_code);

alter table core.indicator add column indicator_key text;
update core.indicator i set indicator_key = s.code || ':' || i.external_code from meta.source s where s.id = i.source_id;
alter table core.indicator alter column indicator_key set not null;
alter table core.indicator add constraint indicator_key_unique unique (indicator_key);
comment on column core.indicator.indicator_key is 'fuente:código, clave pública del indicador';

create function core.set_indicator_key() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.indicator_key := (select s.code from meta.source s where s.id = new.source_id) || ':' || new.external_code;
  return new;
end
$$;

create trigger indicator_key
  before insert or update of source_id, external_code on core.indicator
  for each row execute function core.set_indicator_key();

-- Los códigos de los que salen esas claves no pueden cambiar.
create function meta.forbid_key_change() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'la columna % de %.% es inmutable', tg_argv[0], tg_table_schema, tg_table_name
    using errcode = 'check_violation';
end
$$;

create trigger source_code_immutable before update of code on meta.source
  for each row when (old.code is distinct from new.code) execute function meta.forbid_key_change('code');
create trigger country_iso3_immutable before update of iso3 on ref.country
  for each row when (old.iso3 is distinct from new.iso3) execute function meta.forbid_key_change('iso3');
create trigger region_code_immutable before update of code on ref.region
  for each row when (old.code is distinct from new.code) execute function meta.forbid_key_change('code');
create trigger indicator_code_immutable before update of external_code, source_id on core.indicator
  for each row when (old.external_code is distinct from new.external_code or old.source_id is distinct from new.source_id)
  execute function meta.forbid_key_change('external_code/source_id');

-- ---------- 2. Rol propietario de las vistas ----------

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'api_reader') then
    create role api_reader nologin noinherit;
  end if;
end
$$;
comment on role api_reader is 'Propietario de las vistas de api: solo lectura de las tablas que estas necesitan';
-- Necesario para poder asignarle la propiedad de las vistas (y en Supabase, postgres no es superusuario).
grant api_reader to current_user;
grant usage, create on schema api to api_reader;
grant usage on schema meta, ref, core, ops to api_reader;
grant select on meta.license, meta.category, meta.source, meta.endpoint, meta.admission_check, meta.dataset,
  ref.country, ref.region, ref.unit,
  core.indicator, core.series, core.observation, core.observation_revision,
  ops.dataset_schedule, ops.ingestion_run
  to api_reader;

do $$
declare t text;
begin
  foreach t in array array['meta.license', 'meta.category', 'meta.source', 'meta.endpoint', 'meta.admission_check',
    'meta.dataset', 'ref.country', 'ref.region', 'ref.unit', 'core.indicator', 'core.series', 'core.observation',
    'core.observation_revision', 'ops.dataset_schedule', 'ops.ingestion_run']
  loop
    execute format('create policy api_reader_read on %s for select to api_reader using (true)', t);
  end loop;
end
$$;

-- ---------- 3. Vistas: visibilidad explícita, propietario api_reader ----------
-- Se mantienen nombres, orden y tipos de columnas (get_series depende de v_observation).

create or replace view api.v_source as
select
  s.code as source_code, s.name, s.provider, s.status, s.status_reason, s.restrictions, s.homepage_url, s.docs_url,
  l.code as license_code, l.name as license_name, l.url as license_url, l.allows_commercial, l.share_alike,
  ac.checked_at as last_admission_at, ac.outcome as last_admission_outcome, ac.http_status as last_admission_http_status
from meta.source s
join meta.license l on l.id = s.license_id
left join lateral (
  select a.checked_at, a.outcome, a.http_status
  from meta.admission_check a join meta.endpoint e on e.id = a.endpoint_id
  where e.source_id = s.id
  order by a.checked_at desc
  limit 1
) ac on true
where s.status in ('approved', 'approved_restricted', 'quarantined');

create or replace view api.v_dataset as
select
  d.code as dataset_code, d.name, s.code as source_code, c.code as category_code, d.update_frequency,
  l.code as license_code, sch.last_success_at, sch.next_run_at, lr.status as last_run_status,
  lr.finished_at as last_run_finished_at
from meta.dataset d
join meta.source s on s.id = d.source_id
join meta.category c on c.id = d.category_id
join meta.license l on l.id = coalesce(d.license_id, s.license_id)
left join ops.dataset_schedule sch on sch.dataset_id = d.id
left join ops.ingestion_run lr on lr.id = sch.last_run_id
where d.is_public and s.status in ('approved', 'approved_restricted', 'quarantined');

create or replace view api.v_indicator as
select
  i.indicator_key, s.code as source_code, i.external_code as indicator_code, i.name_en, i.name_es, i.description,
  i.unit_label, c.code as category_code, d.code as dataset_code, l.code as license_code, i.source_organization,
  i.provider_last_updated
from core.indicator i
join meta.source s on s.id = i.source_id
join meta.dataset d on d.id = i.dataset_id
join meta.category c on c.id = i.category_id
join meta.license l on l.id = coalesce(i.license_id, d.license_id, s.license_id)
where d.is_public and s.status in ('approved', 'approved_restricted', 'quarantined');

create or replace view api.v_observation as
select
  i.indicator_key,
  s.code as source_code,
  i.external_code as indicator_code,
  coalesce(i.name_es, i.name_en) as indicator_name,
  i.unit_label,
  case when se.country_id is not null then 'country' else 'region' end as geo_kind,
  se.geo_code,
  coalesce(c.name_es, c.name_en, r.name_es, r.name_en) as geo_name,
  se.frequency::text as frequency,
  o.period_label,
  o.period_start,
  o.period_end,
  extract(year from o.period_start)::integer as year,
  o.value,
  o.obs_status,
  l.code as license_code,
  o.updated_at
from core.observation o
join core.series se on se.id = o.series_id
join core.indicator i on i.id = se.indicator_id
join meta.dataset d on d.id = i.dataset_id
join meta.source s on s.id = i.source_id
join meta.license l on l.id = coalesce(i.license_id, d.license_id, s.license_id)
left join ref.country c on c.id = se.country_id
left join ref.region r on r.id = se.region_id
where o.withdrawn_at is null
  and d.is_public
  and s.status in ('approved', 'approved_restricted', 'quarantined');

create or replace view api.v_observation_revision as
select
  i.indicator_key, se.geo_code, rv.period_start, rv.change_kind, rv.old_value, rv.new_value, rv.revised_at
from core.observation_revision rv
join core.series se on se.id = rv.series_id
join core.indicator i on i.id = se.indicator_id
join meta.dataset d on d.id = i.dataset_id
join meta.source s on s.id = i.source_id
where d.is_public and s.status in ('approved', 'approved_restricted', 'quarantined');

do $$
declare v text;
begin
  foreach v in array array['v_source', 'v_dataset', 'v_indicator', 'v_geo', 'v_observation', 'v_observation_revision'] loop
    execute format('alter view api.%I set (security_invoker = false, security_barrier = true)', v);
    execute format('alter view api.%I owner to api_reader', v);
  end loop;
end
$$;

-- ---------- 4. El público solo ve el esquema api ----------

do $$
declare p record;
begin
  for p in select schemaname, tablename, policyname from pg_policies where policyname = 'public_read' loop
    execute format('drop policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
  end loop;
end
$$;
revoke all on all tables in schema meta, ref, core, ops from anon, authenticated;
revoke usage on schema meta, ref, core, ops from anon, authenticated;
grant usage on schema api to anon, authenticated;
grant select on all tables in schema api to anon, authenticated;

-- Funciones nuevas (disparadores): nadie las ejecuta directamente.
revoke execute on function core.set_series_geo_code(), core.set_indicator_key(), meta.forbid_key_change() from public;
