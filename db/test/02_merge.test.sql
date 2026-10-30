-- Fusión: idempotencia, revisiones, duplicados, retirada y restauración.
begin;
\ir fixtures.sql

create temp table result_log (step text primary key, ins int, upd int, unch int, rej int, wd int);

-- Sin admisión superada no hay ejecución.
do $$
begin
  update meta.admission_check set checked_at = now() - interval '30 days'
  where endpoint_id = (select e.id from meta.endpoint e join meta.source s on s.id = e.source_id where s.code = 'test_source');
  perform ops.start_run('test:fixture', 'test', 'test');
  raise exception 'debía fallar';
exception when object_not_in_prerequisite_state then
  raise notice 'PASS sin admisión reciente no se abre ejecución';
end
$$;
select ops.record_admission_check('test_source', 'data', 'https://example.test/data', 200, 'application/json', 10, 'pass');

-- Ejecución 1: carga inicial de 3 observaciones.
do $$
declare r record; v_run bigint;
begin
  v_run := ops.start_run('test:fixture', 'test', 'test');
  perform pg_temp.stage(v_run, 'ZZA', 2000, 10);
  perform pg_temp.stage(v_run, 'ZZA', 2001, 11);
  perform pg_temp.stage(v_run, 'ZZB', 2000, 20);
  select * into r from ops.merge_observations(v_run);
  assert (r.inserted, r.updated, r.unchanged, r.rejected, r.withdrawn) = (3, 0, 0, 0, 0), format('carga inicial: %s', r);
  perform ops.finish_run(v_run, 'success');
  assert (select count(*) from core.series) = 2, 'se esperaban 2 series';
  assert (select count(*) from staging.observation_load) = 0, 'staging debía quedar vacío';
  raise notice 'PASS carga inicial: 3 nuevas, 2 series, staging vacío';
end
$$;

-- Ejecución 2: mismo lote, nada cambia.
do $$
declare r record; v_run bigint;
begin
  v_run := ops.start_run('test:fixture', 'test', 'test');
  perform pg_temp.stage(v_run, 'ZZA', 2000, 10);
  perform pg_temp.stage(v_run, 'ZZA', 2001, 11);
  perform pg_temp.stage(v_run, 'ZZB', 2000, 20);
  select * into r from ops.merge_observations(v_run);
  assert (r.inserted, r.updated, r.unchanged, r.rejected, r.withdrawn) = (0, 0, 3, 0, 0), format('repetición: %s', r);
  perform ops.finish_run(v_run, 'success');
  assert (select count(*) from core.observation) = 3, 'no debía haber duplicados';
  assert (select count(*) from core.observation_revision) = 0, 'no debía haber revisiones';
  raise notice 'PASS repetición idempotente: 0 nuevas, 0 modificadas, 3 iguales, 0 revisiones';
end
$$;

-- Ejecución 3: un valor revisado por el proveedor.
do $$
declare r record; v_run bigint; rv core.observation_revision;
begin
  v_run := ops.start_run('test:fixture', 'test', 'test');
  perform pg_temp.stage(v_run, 'ZZA', 2000, 10);
  perform pg_temp.stage(v_run, 'ZZA', 2001, 11.5);
  perform pg_temp.stage(v_run, 'ZZB', 2000, 20);
  select * into r from ops.merge_observations(v_run);
  assert (r.inserted, r.updated, r.unchanged) = (0, 1, 2), format('revisión: %s', r);
  select * into rv from core.observation_revision;
  assert rv.change_kind = 'revised' and rv.old_value = 11 and rv.new_value = 11.5 and rv.run_id = v_run,
    format('revisión registrada mal: %s', rv);
  assert (select value from core.observation o join ref.country c on true
          join core.series s on s.id = o.series_id and s.country_id = c.id
          where c.iso3 = 'ZZA' and o.period_start = '2001-01-01') = 11.5, 'valor vigente no actualizado';
  perform ops.finish_run(v_run, 'success');
  raise notice 'PASS valor revisado: 1 modificada, revisión 11 -> 11.5 con su ejecución';
end
$$;

-- Ejecución 4: claves duplicadas en el lote se rechazan.
do $$
declare r record; v_run bigint;
begin
  v_run := ops.start_run('test:fixture', 'test', 'test');
  perform pg_temp.stage(v_run, 'ZZB', 2001, 21);
  perform pg_temp.stage(v_run, 'ZZB', 2001, 22);
  perform pg_temp.stage(v_run, 'ZZB', 2002, 23);
  select * into r from ops.merge_observations(v_run);
  assert (r.inserted, r.rejected) = (1, 2), format('duplicados: %s', r);
  assert (select count(*) from ops.rejected_record where run_id = v_run and reason = 'duplicate_key_in_batch') = 2;
  assert (select records_rejected from ops.ingestion_run where id = v_run) = 2, 'contador de rechazados';
  perform ops.finish_run(v_run, 'partial');
  raise notice 'PASS claves duplicadas: 2 rechazadas con motivo, 1 nueva';
end
$$;

-- Ejecución 5: instantánea completa sin ZZB-2002 → se marca retirada, no se borra.
do $$
declare r record; v_run bigint;
begin
  v_run := ops.start_run('test:fixture', 'test', 'test');
  perform pg_temp.stage(v_run, 'ZZA', 2000, 10);
  perform pg_temp.stage(v_run, 'ZZA', 2001, 11.5);
  perform pg_temp.stage(v_run, 'ZZB', 2000, 20);
  select * into r from ops.merge_observations(v_run, true);
  assert (r.inserted, r.updated, r.unchanged, r.withdrawn) = (0, 0, 3, 1), format('retirada: %s', r);
  assert (select count(*) from core.observation) = 4, 'la observación retirada debe conservarse';
  assert (select count(*) from core.observation where withdrawn_at is not null) = 1;
  assert exists (select 1 from core.observation_revision where change_kind = 'withdrawn' and old_value = 23 and new_value is null);
  perform ops.finish_run(v_run, 'success');
  raise notice 'PASS dato retirado por el proveedor: marcado, conservado y con revisión';
end
$$;

-- Ejecución 6: el dato vuelve a publicarse.
do $$
declare r record; v_run bigint;
begin
  v_run := ops.start_run('test:fixture', 'test', 'test');
  perform pg_temp.stage(v_run, 'ZZB', 2002, 23);
  select * into r from ops.merge_observations(v_run);
  assert (r.inserted, r.updated) = (0, 1), format('restauración: %s', r);
  assert (select count(*) from core.observation where withdrawn_at is not null) = 0;
  assert exists (select 1 from core.observation_revision where change_kind = 'restored' and new_value = 23);
  perform ops.finish_run(v_run, 'success');
  raise notice 'PASS dato restaurado: vuelve a vigente con revisión restored';
end
$$;

-- Historial inmutable.
do $$
begin
  delete from core.observation;
  raise exception 'debía fallar';
exception when insufficient_privilege then
  raise notice 'PASS borrar observaciones está prohibido';
end
$$;
do $$
begin
  update core.observation_revision set new_value = 0;
  raise exception 'debía fallar';
exception when insufficient_privilege then
  raise notice 'PASS editar revisiones está prohibido';
end
$$;

-- Ejecuciones: métricas, unicidad y programación.
do $$
declare v_run bigint; v_next timestamptz;
begin
  v_run := ops.start_run('test:fixture', 'test', 'test');
  begin
    perform ops.start_run('test:fixture', 'test', 'test');
    raise exception 'debía fallar';
  exception when unique_violation then
    raise notice 'PASS no se permiten dos ejecuciones simultáneas del mismo dataset';
  end;
  perform ops.add_run_counters(v_run, 4, 100, 3);
  perform ops.finish_run(v_run, 'success');
  assert (select (http_requests, records_received, records_rejected) = (4, 100, 3) and duration_ms >= 0
          from ops.ingestion_run where id = v_run), 'métricas de la ejecución';
  select next_run_at into v_next from ops.dataset_schedule sch join meta.dataset d on d.id = sch.dataset_id
  where d.code = 'test:fixture';
  assert v_next > now() + interval '27 days', format('próxima ejecución mensual mal calculada: %s', v_next);
  assert (select last_success_run_id from ops.dataset_schedule sch join meta.dataset d on d.id = sch.dataset_id
          where d.code = 'test:fixture') = v_run;
  raise notice 'PASS métricas, duración y próxima ejecución mensual registradas';
end
$$;

do $$
begin
  assert (select count(*) from ops.due_datasets() where dataset_code = 'test:fixture') = 0,
    'el dataset recién ejecutado no debía estar vencido';
  assert (select count(*) from ops.due_datasets() where dataset_code like 'worldbank:%') = 2,
    'los datasets del Banco Mundial nunca ejecutados debían estar vencidos';
  raise notice 'PASS el programador distingue datasets vencidos y al día';
end
$$;

rollback;
