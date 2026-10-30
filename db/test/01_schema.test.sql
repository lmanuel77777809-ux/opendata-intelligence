-- Estructura, restricciones y endurecimiento del esquema.
begin;

do $$
declare n integer;
begin
  select count(*) into n
  from pg_tables t join pg_class c on c.relname = t.tablename
  join pg_namespace ns on ns.oid = c.relnamespace and ns.nspname = t.schemaname
  where t.schemaname in ('meta', 'ref', 'core', 'ops') and not c.relrowsecurity;
  assert n = 0, format('%s tablas sin RLS', n);
  raise notice 'PASS RLS activada en todas las tablas de meta, ref, core y ops';

  select count(*) into n
  from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname in ('meta', 'ref', 'core', 'ops', 'staging', 'api')
    and (p.proacl is null
         or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 and a.privilege_type = 'EXECUTE'));
  assert n = 0, format('%s funciones ejecutables por PUBLIC', n);
  raise notice 'PASS ninguna función es ejecutable por PUBLIC';

  select count(*) into n from pg_proc p join pg_namespace ns on ns.oid = p.pronamespace
  where ns.nspname in ('ops', 'meta', 'core', 'api')
    and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) cfg where cfg like 'search_path=%');
  assert n = 0, format('%s funciones sin search_path fijo', n);
  raise notice 'PASS todas las funciones fijan search_path';
end
$$;

do $$
declare n integer;
begin
  select count(*) into n from meta.source where code = 'worldbank' and status = 'candidate';
  assert n = 1, 'falta la fuente worldbank en estado candidate';
  select count(*) into n from meta.dataset where code like 'worldbank:%' and not is_public;
  assert n = 2, 'se esperaban 2 datasets no públicos del Banco Mundial';
  select sum(jsonb_array_length(config -> 'indicators')) into n from meta.dataset where code like 'worldbank:%';
  assert n = 12, format('se esperaban 12 indicadores configurados, hay %s', n);
  raise notice 'PASS semilla del Banco Mundial: fuente candidata, 2 datasets privados, 12 indicadores';
end
$$;

\ir fixtures.sql

-- Endpoint con host fuera de la lista blanca.
do $$
begin
  insert into meta.endpoint (source_id, code, name, base_url, path_template, response_format)
  select id, 'evil', 'x', 'https://evil.example.com', '/x', 'json' from meta.source where code = 'test_source';
  raise exception 'debía fallar';
exception when check_violation then
  raise notice 'PASS endpoint con host no permitido rechazado';
end
$$;

-- Dataset que apunta a un endpoint de otra fuente.
do $$
begin
  insert into meta.dataset (source_id, endpoint_id, code, name, category_id, update_frequency)
  select (select id from meta.source where code = 'test_source'),
         (select e.id from meta.endpoint e join meta.source s on s.id = e.source_id
          where s.code = 'worldbank' and e.code = 'indicator_data_v2'),
         'test:cross', 'x', (select id from meta.category where code = 'economy'), 'monthly';
  raise exception 'debía fallar';
exception when foreign_key_violation then
  raise notice 'PASS dataset con endpoint de otra fuente rechazado';
end
$$;

-- Fuente rechazada sin motivo.
do $$
begin
  update meta.source set status = 'rejected' where code = 'test_source';
  raise exception 'debía fallar';
exception when check_violation then
  raise notice 'PASS cambio a rejected sin motivo rechazado';
end
$$;

-- Prueba de admisión 'pass' con HTTP 403.
do $$
begin
  perform ops.record_admission_check('test_source', 'data', 'https://example.test/data', 403, null, 5, 'pass');
  raise exception 'debía fallar';
exception when check_violation then
  raise notice 'PASS admisión pass con HTTP 403 rechazada';
end
$$;

-- Prueba de admisión con URL de otro host.
do $$
begin
  perform ops.record_admission_check('test_source', 'data', 'https://evil.example.com/data', 200, null, 5, 'pass');
  raise exception 'debía fallar';
exception when check_violation then
  raise notice 'PASS admisión con URL fuera de lista blanca rechazada';
end
$$;

-- Serie sin geografía o con dos.
do $$
begin
  insert into staging.observation_load (run_id, indicator_id, frequency, period_start, period_end, period_label, value)
  values (1, 1, 'A', '2000-01-01', '2000-12-31', '2000', 1);
  raise exception 'debía fallar';
exception when check_violation or foreign_key_violation then
  raise notice 'PASS fila sin geografía rechazada';
end
$$;

rollback;
