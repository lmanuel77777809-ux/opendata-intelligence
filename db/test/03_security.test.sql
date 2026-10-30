-- Permisos: lectura pública solo de lo aprobado; el worker no puede saltarse la fusión.
begin;
\ir fixtures.sql

do $$
declare v_run bigint;
begin
  v_run := ops.start_run('test:fixture', 'test', 'test');
  perform pg_temp.stage(v_run, 'ZZA', 2000, 10);
  perform pg_temp.stage(v_run, 'ZZA', 2001, 11);
  perform pg_temp.stage(v_run, 'ZZB', 2000, 20);
  perform ops.merge_observations(v_run);
  perform ops.finish_run(v_run, 'success');
end
$$;

-- 1. Fuente candidata y dataset privado: anon no ve nada.
set role anon;
do $$
begin
  assert (select count(*) from api.v_observation) = 0, 'anon no debía ver observaciones de datasets privados';
  assert (select count(*) from api.v_indicator) = 0, 'anon no debía ver indicadores privados';
  assert (select count(*) from api.v_source where source_code in ('test_source', 'worldbank')) = 0,
    'anon no debía ver fuentes candidatas';
  raise notice 'PASS anon no ve fuentes candidatas ni datasets privados';
end
$$;
reset role;

-- 2. Fuente aprobada pero dataset privado: sigue sin verse.
update meta.source set status = 'approved' where code = 'test_source';
set role anon;
do $$
begin
  assert (select count(*) from api.v_observation) = 0, 'dataset privado visible';
  assert (select count(*) from api.v_source where source_code = 'test_source') = 1, 'fuente aprobada invisible';
  raise notice 'PASS fuente aprobada visible; su dataset privado sigue oculto';
end
$$;
reset role;

-- 3. Dataset público: anon lee la serie, con licencia en cada fila.
update meta.dataset set is_public = true where code = 'test:fixture';
set role anon;
do $$
declare r record; n integer;
begin
  assert (select count(*) from api.v_observation) = 3, 'se esperaban 3 observaciones públicas';
  assert (select count(*) from api.v_observation where license_code = 'TEST-LICENSE') = 3, 'licencia ausente';
  select count(*) into n from api.get_series('test_source:TEST.IND', array['ZZA'], 2000, 2001);
  assert n = 2, format('get_series devolvió %s filas', n);
  select * into r from api.get_series('test_source:TEST.IND', array['ZZA', 'ZZB'], null, null) limit 1;
  assert r.geo_code = 'ZZA' and r.year = 2000, 'get_series debe ordenar por geografía y período';
  assert (select count(*) from api.v_dataset where dataset_code = 'test:fixture' and last_run_status = 'success') = 1;
  raise notice 'PASS anon lee datasets públicos; get_series filtra y ordena; estado de actualización visible';
end
$$;

-- 4. anon no escribe ni ejecuta funciones de ingesta ni ve datos internos.
do $$
begin
  insert into core.observation (series_id, period_start, period_end, period_label, value, first_run_id, last_run_id)
  values (1, '1999-01-01', '1999-12-31', '1999', 1, 1, 1);
  raise exception 'debía fallar';
exception when insufficient_privilege then
  raise notice 'PASS anon no puede insertar observaciones';
end
$$;
do $$
begin
  perform ops.merge_observations(1);
  raise exception 'debía fallar';
exception when insufficient_privilege then
  raise notice 'PASS anon no puede ejecutar la fusión';
end
$$;
do $$
begin
  perform count(*) from ops.ingestion_error;
  raise exception 'debía fallar';
exception when insufficient_privilege then
  raise notice 'PASS anon no ve los errores de ingesta';
end
$$;
do $$
begin
  perform count(*) from staging.observation_load;
  raise exception 'debía fallar';
exception when insufficient_privilege then
  raise notice 'PASS anon no accede a staging';
end
$$;
do $$
begin
  perform count(*) from ref.geo_code_map;
  raise exception 'debía fallar';
exception when insufficient_privilege then
  raise notice 'PASS anon no ve las equivalencias internas de códigos';
end
$$;
reset role;

-- 5. Un dato retirado desaparece de la API pública pero su historial sigue visible.
do $$
declare v_run bigint;
begin
  v_run := ops.start_run('test:fixture', 'test', 'test');
  perform pg_temp.stage(v_run, 'ZZA', 2000, 10);
  perform pg_temp.stage(v_run, 'ZZA', 2001, 11);
  perform ops.merge_observations(v_run, true);
  perform ops.finish_run(v_run, 'success');
end
$$;
set role anon;
do $$
begin
  assert (select count(*) from api.v_observation) = 2, 'el dato retirado no debía verse';
  assert (select count(*) from api.v_observation_revision where change_kind = 'withdrawn' and geo_code = 'ZZB') = 1;
  raise notice 'PASS dato retirado oculto en la API y visible en el historial de revisiones';
end
$$;
reset role;

-- 6. El worker no puede saltarse la fusión ni tocar el catálogo.
set role ingest_writer;
do $$
begin
  insert into core.observation (series_id, period_start, period_end, period_label, value, first_run_id, last_run_id)
  values (1, '1999-01-01', '1999-12-31', '1999', 1, 1, 1);
  raise exception 'debía fallar';
exception when insufficient_privilege then
  raise notice 'PASS ingest_writer no inserta observaciones directamente';
end
$$;
do $$
begin
  update core.observation set value = 0;
  raise exception 'debía fallar';
exception when insufficient_privilege then
  raise notice 'PASS ingest_writer no modifica observaciones directamente';
end
$$;
do $$
begin
  update meta.source set status = 'approved';
  raise exception 'debía fallar';
exception when insufficient_privilege then
  raise notice 'PASS ingest_writer no puede aprobar fuentes';
end
$$;
do $$
declare v_run bigint; r record;
begin
  v_run := ops.start_run('test:fixture', 'test', 'test');
  insert into staging.observation_load (run_id, indicator_id, country_id, frequency, period_start, period_end, period_label, value)
  select v_run, i.id, c.id, 'A', '2003-01-01', '2003-12-31', '2003', 30
  from core.indicator i, ref.country c where i.external_code = 'TEST.IND' and c.iso3 = 'ZZA';
  select * into r from ops.merge_observations(v_run);
  assert r.inserted = 1, format('fusión como ingest_writer: %s', r);
  perform ops.finish_run(v_run, 'success');
  raise notice 'PASS ingest_writer carga por staging y fusión';
end
$$;
reset role;

rollback;
