-- Permisos y RLS.
--   anon / authenticated: solo lectura de fuentes aprobadas y datasets públicos (vía esquema api).
--   ingest_writer: escribe referencia, indicadores y staging; las observaciones solo vía ops.merge_observations.
-- PostgREST debe exponer únicamente el esquema api.

-- Funciones: nadie las ejecuta salvo concesión explícita.
revoke execute on all functions in schema meta, ref, ops, core, staging, api from public;

-- ---------- RLS en todas las tablas de meta, ref, core y ops ----------
do $$
declare
  t record;
begin
  for t in
    select schemaname, tablename from pg_tables where schemaname in ('meta', 'ref', 'core', 'ops')
  loop
    execute format('alter table %I.%I enable row level security', t.schemaname, t.tablename);
  end loop;
end
$$;

-- ---------- Lectura pública ----------
grant usage on schema api, meta, ref, core, ops to anon, authenticated;

grant select on meta.license, meta.category, meta.source, meta.endpoint, meta.admission_check, meta.dataset
  to anon, authenticated;
grant select on ref.country, ref.region, ref.region_member, ref.unit to anon, authenticated;
grant select on core.indicator, core.series, core.observation, core.observation_revision to anon, authenticated;
grant select on ops.dataset_schedule, ops.ingestion_run to anon, authenticated;
grant select on all tables in schema api to anon, authenticated;
grant execute on function api.get_series(text, text[], integer, integer) to anon, authenticated;

create policy public_read on meta.license for select to anon, authenticated using (true);
create policy public_read on meta.category for select to anon, authenticated using (true);
create policy public_read on meta.source for select to anon, authenticated
  using (status in ('approved', 'approved_restricted', 'quarantined'));
create policy public_read on meta.endpoint for select to anon, authenticated
  using (exists (select 1 from meta.source s where s.id = source_id));
create policy public_read on meta.admission_check for select to anon, authenticated
  using (exists (select 1 from meta.endpoint e where e.id = endpoint_id));
create policy public_read on meta.dataset for select to anon, authenticated
  using (is_public and exists (select 1 from meta.source s where s.id = source_id));

create policy public_read on ref.country for select to anon, authenticated using (true);
create policy public_read on ref.region for select to anon, authenticated using (true);
create policy public_read on ref.region_member for select to anon, authenticated using (true);
create policy public_read on ref.unit for select to anon, authenticated using (true);

create policy public_read on core.indicator for select to anon, authenticated
  using (exists (select 1 from meta.dataset d where d.id = dataset_id));
create policy public_read on core.series for select to anon, authenticated
  using (exists (select 1 from core.indicator i where i.id = indicator_id));
create policy public_read on core.observation for select to anon, authenticated
  using (exists (select 1 from core.series s where s.id = series_id));
create policy public_read on core.observation_revision for select to anon, authenticated
  using (exists (select 1 from core.series s where s.id = series_id));

create policy public_read on ops.dataset_schedule for select to anon, authenticated
  using (exists (select 1 from meta.dataset d where d.id = dataset_id));
create policy public_read on ops.ingestion_run for select to anon, authenticated
  using (exists (select 1 from meta.dataset d where d.id = dataset_id));

-- ---------- Worker de ingesta ----------
grant usage on schema meta, ref, core, ops, staging to ingest_writer;
grant usage on all sequences in schema ref, core to ingest_writer;

grant select on all tables in schema meta to ingest_writer;
grant select, insert, update on ref.country, ref.region, ref.region_member, ref.geo_code_map to ingest_writer;
grant select on ref.unit to ingest_writer;
grant select, insert, update on core.indicator to ingest_writer;
grant select on core.series, core.observation, core.observation_revision to ingest_writer;
grant select on ops.ingestion_run, ops.dataset_schedule to ingest_writer;
grant select, insert on ops.ingestion_error, ops.rejected_record to ingest_writer;
grant select, insert on staging.observation_load to ingest_writer;

grant execute on function
  ops.record_admission_check(text, text, text, integer, text, integer, text, text),
  ops.start_run(text, text, text, jsonb, interval),
  ops.add_run_counters(bigint, integer, integer, integer, integer),
  ops.merge_observations(bigint, boolean),
  ops.finish_run(bigint, text, text),
  ops.due_datasets()
  to ingest_writer;

do $$
declare
  t record;
begin
  for t in select schemaname, tablename from pg_tables where schemaname = 'meta' loop
    execute format('create policy worker_read on %I.%I for select to ingest_writer using (true)', t.schemaname, t.tablename);
  end loop;
end
$$;

create policy worker_all on ref.country for all to ingest_writer using (true) with check (true);
create policy worker_all on ref.region for all to ingest_writer using (true) with check (true);
create policy worker_all on ref.region_member for all to ingest_writer using (true) with check (true);
create policy worker_all on ref.geo_code_map for all to ingest_writer using (true) with check (true);
create policy worker_read on ref.unit for select to ingest_writer using (true);
create policy worker_all on core.indicator for all to ingest_writer using (true) with check (true);
create policy worker_read on core.series for select to ingest_writer using (true);
create policy worker_read on core.observation for select to ingest_writer using (true);
create policy worker_read on core.observation_revision for select to ingest_writer using (true);
create policy worker_read on ops.ingestion_run for select to ingest_writer using (true);
create policy worker_read on ops.dataset_schedule for select to ingest_writer using (true);
create policy worker_write on ops.ingestion_error for all to ingest_writer using (true) with check (true);
create policy worker_write on ops.rejected_record for all to ingest_writer using (true) with check (true);
