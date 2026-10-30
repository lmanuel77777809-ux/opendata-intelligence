-- Área de carga y funciones de ingesta. El worker (rol ingest_writer) solo escribe
-- en staging y llama a estas funciones; nunca toca core.observation directamente.

create unlogged table staging.observation_load (
  run_id bigint not null references ops.ingestion_run (id),
  indicator_id integer not null references core.indicator (id),
  country_id smallint references ref.country (id),
  region_id integer references ref.region (id),
  frequency char(1) not null check (frequency in ('A', 'Q', 'M', 'W', 'D')),
  dimensions jsonb not null default '{}'::jsonb,
  period_start date not null,
  period_end date not null,
  period_label text not null,
  value numeric not null,
  obs_status text,
  check (num_nonnulls(country_id, region_id) = 1),
  check (period_end >= period_start)
);
create index observation_load_run_idx on staging.observation_load (run_id);
comment on table staging.observation_load is 'Lote normalizado y validado por el worker, pendiente de fusión';

-- Registra una prueba de admisión. Rechaza URLs fuera de la lista blanca de la fuente.
create function ops.record_admission_check(
  p_source_code text,
  p_endpoint_code text,
  p_request_url text,
  p_http_status integer,
  p_content_type text,
  p_latency_ms integer,
  p_outcome text,
  p_detail text default null
) returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_endpoint_id smallint;
  v_source_id smallint;
  v_host text := substring(p_request_url from '^https://([^/:?#]+)');
  v_id bigint;
begin
  select e.id, e.source_id into v_endpoint_id, v_source_id
  from meta.endpoint e join meta.source s on s.id = e.source_id
  where s.code = p_source_code and e.code = p_endpoint_code;
  if v_endpoint_id is null then
    raise exception 'endpoint %/% no existe', p_source_code, p_endpoint_code using errcode = 'no_data_found';
  end if;
  if not exists (select 1 from meta.source_host h where h.source_id = v_source_id and h.host = v_host) then
    raise exception 'host % fuera de la lista blanca de %', v_host, p_source_code using errcode = 'check_violation';
  end if;
  insert into meta.admission_check (endpoint_id, request_url, http_status, content_type, latency_ms, outcome, detail)
  values (v_endpoint_id, p_request_url, p_http_status, p_content_type, p_latency_ms, p_outcome, p_detail)
  returning id into v_id;
  return v_id;
end
$$;

-- Abre una ejecución. Exige fuente no rechazada ni en cuarentena y una prueba de
-- admisión superada reciente para el endpoint del dataset.
create function ops.start_run(
  p_dataset_code text,
  p_trigger text,
  p_connector_version text,
  p_parameters jsonb default '{}'::jsonb,
  p_admission_max_age interval default interval '7 days'
) returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_dataset meta.dataset;
  v_source_status text;
  v_run_id bigint;
begin
  select * into v_dataset from meta.dataset where code = p_dataset_code;
  if not found then
    raise exception 'dataset % no existe', p_dataset_code using errcode = 'no_data_found';
  end if;
  if not v_dataset.active then
    raise exception 'dataset % está inactivo', p_dataset_code using errcode = 'object_not_in_prerequisite_state';
  end if;

  select status into v_source_status from meta.source where id = v_dataset.source_id;
  if v_source_status in ('rejected', 'quarantined', 'retired') then
    raise exception 'la fuente del dataset % está en estado %', p_dataset_code, v_source_status
      using errcode = 'object_not_in_prerequisite_state';
  end if;

  if not exists (
    select 1 from meta.admission_check a
    where a.endpoint_id = v_dataset.endpoint_id
      and a.outcome = 'pass'
      and a.checked_at >= now() - p_admission_max_age
  ) then
    raise exception 'admission_required: sin prueba de admisión superada en los últimos % para %',
      p_admission_max_age, p_dataset_code using errcode = 'object_not_in_prerequisite_state';
  end if;

  insert into ops.ingestion_run (dataset_id, trigger, connector_version, parameters)
  values (v_dataset.id, p_trigger, p_connector_version, p_parameters)
  returning id into v_run_id;

  insert into ops.dataset_schedule (dataset_id, last_run_id, last_run_at)
  values (v_dataset.id, v_run_id, now())
  on conflict (dataset_id) do update set last_run_id = excluded.last_run_id, last_run_at = excluded.last_run_at;

  return v_run_id;
end
$$;

-- Suma métricas medidas por el worker: peticiones, filas recibidas, rechazadas antes de
-- staging y filas sin valor publicado.
create function ops.add_run_counters(
  p_run_id bigint,
  p_http_requests integer default 0,
  p_received integer default 0,
  p_rejected integer default 0,
  p_null integer default 0
) returns void
language sql
security definer
set search_path = ''
as $$
  update ops.ingestion_run
  set http_requests = http_requests + p_http_requests,
      records_received = records_received + p_received,
      records_rejected = records_rejected + p_rejected,
      records_null = records_null + p_null
  where id = p_run_id and status = 'running';
$$;

-- Fusiona el lote de staging de una ejecución en core.observation.
-- Idempotente: repetir el mismo lote no inserta ni modifica nada.
-- p_full_snapshot = true indica que el lote trae todos los períodos publicados de
-- sus indicadores; lo que falte se marca como retirado (sin borrarlo).
create function ops.merge_observations(p_run_id bigint, p_full_snapshot boolean default false)
returns table (inserted integer, updated integer, unchanged integer, rejected integer, withdrawn integer)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_total integer;
  v_ins integer := 0;
  v_upd integer := 0;
  v_rej integer := 0;
  v_wd integer := 0;
begin
  if not exists (select 1 from ops.ingestion_run where id = p_run_id and status = 'running') then
    raise exception 'la ejecución % no existe o no está en curso', p_run_id using errcode = 'object_not_in_prerequisite_state';
  end if;

  if to_regclass('pg_temp.merge_batch') is not null then
    drop table pg_temp.merge_batch;
  end if;
  create temp table merge_batch on commit drop as
  select l.*,
         null::bigint as series_id,
         count(*) over (partition by l.indicator_id, coalesce(l.country_id, 0), coalesce(l.region_id, 0),
                                     l.frequency, md5(l.dimensions::text), l.period_start) as dup_count
  from staging.observation_load l
  where l.run_id = p_run_id;

  -- Claves repetidas dentro del mismo lote: no se puede saber cuál es la buena; se rechazan todas.
  insert into ops.rejected_record (run_id, reason, raw)
  select p_run_id, 'duplicate_key_in_batch',
         jsonb_build_object('indicator_id', b.indicator_id, 'country_id', b.country_id, 'region_id', b.region_id,
                            'frequency', b.frequency, 'dimensions', b.dimensions, 'period_label', b.period_label,
                            'value', b.value)
  from merge_batch b where b.dup_count > 1;
  get diagnostics v_rej = row_count;
  delete from merge_batch where dup_count > 1;

  select count(*) into v_total from merge_batch;

  insert into core.series (indicator_id, country_id, region_id, frequency, dimensions, first_run_id, last_seen_run_id)
  select distinct b.indicator_id, b.country_id, b.region_id, b.frequency, b.dimensions, p_run_id, p_run_id
  from merge_batch b
  on conflict on constraint series_natural_key do nothing;

  update merge_batch b set series_id = s.id
  from core.series s
  where s.indicator_id = b.indicator_id
    and coalesce(s.country_id, 0) = coalesce(b.country_id, 0)
    and coalesce(s.region_id, 0) = coalesce(b.region_id, 0)
    and s.frequency = b.frequency
    and s.dimensions_key = md5(b.dimensions::text);

  with up as (
    insert into core.observation as o
      (series_id, period_start, period_end, period_label, value, obs_status, first_run_id, last_run_id)
    select b.series_id, b.period_start, b.period_end, b.period_label, b.value, b.obs_status, p_run_id, p_run_id
    from merge_batch b
    on conflict (series_id, period_start) do update
      set period_end = excluded.period_end,
          period_label = excluded.period_label,
          value = excluded.value,
          obs_status = excluded.obs_status,
          last_run_id = excluded.last_run_id,
          updated_at = now(),
          withdrawn_at = null
      where (o.period_end, o.period_label, o.value, o.obs_status, o.withdrawn_at)
            is distinct from (excluded.period_end, excluded.period_label, excluded.value, excluded.obs_status, null)
    returning (xmax = 0) as is_insert
  )
  select count(*) filter (where is_insert), count(*) filter (where not is_insert)
  into v_ins, v_upd
  from up;

  if p_full_snapshot then
    update core.observation o
    set withdrawn_at = now(), last_run_id = p_run_id, updated_at = now()
    from core.series s
    where s.id = o.series_id
      and o.withdrawn_at is null
      and s.indicator_id in (select distinct indicator_id from merge_batch)
      and not exists (
        select 1 from merge_batch b where b.series_id = o.series_id and b.period_start = o.period_start
      );
    get diagnostics v_wd = row_count;
  end if;

  update core.series s set last_seen_run_id = p_run_id
  where s.id in (select distinct series_id from merge_batch);

  delete from staging.observation_load where run_id = p_run_id;

  update ops.ingestion_run
  set records_inserted = records_inserted + v_ins,
      records_updated = records_updated + v_upd,
      records_unchanged = records_unchanged + (v_total - v_ins - v_upd),
      records_rejected = records_rejected + v_rej,
      records_withdrawn = records_withdrawn + v_wd
  where id = p_run_id;

  return query select v_ins, v_upd, v_total - v_ins - v_upd, v_rej, v_wd;
end
$$;

-- Cierra una ejecución y programa la siguiente.
create function ops.finish_run(p_run_id bigint, p_status text, p_error_summary text default null)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_run ops.ingestion_run;
  v_frequency text;
begin
  if p_status not in ('success', 'partial', 'failed') then
    raise exception 'estado final no válido: %', p_status using errcode = 'invalid_parameter_value';
  end if;

  update ops.ingestion_run
  set status = p_status,
      finished_at = clock_timestamp(),
      duration_ms = (extract(epoch from clock_timestamp() - started_at) * 1000)::integer,
      error_summary = p_error_summary
  where id = p_run_id and status = 'running'
  returning * into v_run;
  if not found then
    raise exception 'la ejecución % no existe o ya terminó', p_run_id using errcode = 'object_not_in_prerequisite_state';
  end if;

  delete from staging.observation_load where run_id = p_run_id;

  select d.update_frequency into v_frequency from meta.dataset d where d.id = v_run.dataset_id;

  update ops.dataset_schedule
  set next_run_at = case when p_status = 'success'
                         then ops.next_run_after(v_frequency, v_run.started_at)
                         else now() + interval '6 hours' end,
      last_success_run_id = case when p_status = 'success' then p_run_id else last_success_run_id end,
      last_success_at = case when p_status = 'success' then v_run.finished_at else last_success_at end
  where dataset_id = v_run.dataset_id;
end
$$;

-- Datasets cuya próxima ejecución ya venció (para el programador).
create function ops.due_datasets() returns table (dataset_code text, next_run_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select d.code, coalesce(sch.next_run_at, '-infinity'::timestamptz)
  from meta.dataset d
  join meta.source s on s.id = d.source_id
  left join ops.dataset_schedule sch on sch.dataset_id = d.id
  where d.active
    and coalesce(sch.enabled, true)
    and s.status not in ('rejected', 'quarantined', 'retired')
    and coalesce(sch.next_run_at, '-infinity'::timestamptz) <= now()
  order by 2, 1
$$;
