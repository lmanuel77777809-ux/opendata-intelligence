-- Superficie pública de solo lectura. Las vistas usan security_invoker para que la
-- RLS de las tablas se aplique al usuario que consulta (anon, authenticated).

create view api.v_source with (security_invoker = true) as
select
  s.code as source_code,
  s.name,
  s.provider,
  s.status,
  s.status_reason,
  s.restrictions,
  s.homepage_url,
  s.docs_url,
  l.code as license_code,
  l.name as license_name,
  l.url as license_url,
  l.allows_commercial,
  l.share_alike,
  ac.checked_at as last_admission_at,
  ac.outcome as last_admission_outcome,
  ac.http_status as last_admission_http_status
from meta.source s
join meta.license l on l.id = s.license_id
left join lateral (
  select a.checked_at, a.outcome, a.http_status
  from meta.admission_check a
  join meta.endpoint e on e.id = a.endpoint_id
  where e.source_id = s.id
  order by a.checked_at desc
  limit 1
) ac on true;
comment on view api.v_source is 'Catálogo de fuentes con licencia y última prueba de disponibilidad';

create view api.v_dataset with (security_invoker = true) as
select
  d.code as dataset_code,
  d.name,
  s.code as source_code,
  c.code as category_code,
  d.update_frequency,
  l.code as license_code,
  sch.last_success_at,
  sch.next_run_at,
  lr.status as last_run_status,
  lr.finished_at as last_run_finished_at
from meta.dataset d
join meta.source s on s.id = d.source_id
join meta.category c on c.id = d.category_id
join meta.license l on l.id = coalesce(d.license_id, s.license_id)
left join ops.dataset_schedule sch on sch.dataset_id = d.id
left join ops.ingestion_run lr on lr.id = sch.last_run_id;
comment on view api.v_dataset is 'Datasets publicados con su estado de actualización';

create view api.v_indicator with (security_invoker = true) as
select
  s.code || ':' || i.external_code as indicator_key,
  s.code as source_code,
  i.external_code as indicator_code,
  i.name_en,
  i.name_es,
  i.description,
  i.unit_label,
  c.code as category_code,
  d.code as dataset_code,
  l.code as license_code,
  i.source_organization,
  i.provider_last_updated
from core.indicator i
join meta.source s on s.id = i.source_id
join meta.dataset d on d.id = i.dataset_id
join meta.category c on c.id = i.category_id
join meta.license l on l.id = coalesce(i.license_id, d.license_id, s.license_id);
comment on view api.v_indicator is 'Indicadores disponibles; indicator_key = fuente:código';

create view api.v_geo with (security_invoker = true) as
select 'country'::text as geo_kind, c.iso3::text as geo_code, c.iso2::text as iso2, c.name_en, c.name_es,
       null::text as defined_by_source
from ref.country c
union all
select 'region', r.code, null, r.name_en, r.name_es, s.code
from ref.region r
left join meta.source s on s.id = r.defined_by_source_id;
comment on view api.v_geo is 'Países y agregados; geo_kind distingue ambos';

create view api.v_observation with (security_invoker = true) as
select
  s.code || ':' || i.external_code as indicator_key,
  s.code as source_code,
  i.external_code as indicator_code,
  coalesce(i.name_es, i.name_en) as indicator_name,
  i.unit_label,
  case when se.country_id is not null then 'country' else 'region' end as geo_kind,
  coalesce(c.iso3::text, r.code) as geo_code,
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
where o.withdrawn_at is null;
comment on view api.v_observation is 'Observaciones vigentes en formato largo, con fuente y licencia en cada fila';

create view api.v_observation_revision with (security_invoker = true) as
select
  s.code || ':' || i.external_code as indicator_key,
  coalesce(c.iso3::text, r.code) as geo_code,
  rv.period_start,
  rv.change_kind,
  rv.old_value,
  rv.new_value,
  rv.revised_at
from core.observation_revision rv
join core.series se on se.id = rv.series_id
join core.indicator i on i.id = se.indicator_id
join meta.source s on s.id = i.source_id
left join ref.country c on c.id = se.country_id
left join ref.region r on r.id = se.region_id;
comment on view api.v_observation_revision is 'Historial público de revisiones';

-- Serie de un indicador para varias geografías y un rango de años.
create function api.get_series(
  p_indicator_key text,
  p_geo_codes text[] default null,
  p_year_from integer default null,
  p_year_to integer default null
) returns setof api.v_observation
language sql
stable
security invoker
set search_path = ''
as $$
  select *
  from api.v_observation v
  where v.indicator_key = p_indicator_key
    and (p_geo_codes is null or v.geo_code = any (p_geo_codes))
    and (p_year_from is null or v.period_start >= make_date(p_year_from, 1, 1))
    and (p_year_to is null or v.period_start < make_date(p_year_to + 1, 1, 1))
  order by v.geo_code, v.period_start
$$;
comment on function api.get_series is 'Serie histórica: indicador (fuente:código), geografías y años opcionales';
