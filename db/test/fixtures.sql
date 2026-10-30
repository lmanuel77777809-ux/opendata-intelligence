-- Datos sintéticos SOLO para pruebas: fuente, host y países de prueba con códigos
-- reservados (ZZA, ZZB) que no existen en ningún proveedor. Se cargan dentro de una
-- transacción que cada prueba revierte; nunca llegan a una base real.
insert into meta.license (code, name, url, allows_commercial, requires_attribution, share_alike)
values ('TEST-LICENSE', 'Licencia de pruebas', 'https://example.test/license', true, true, false);

insert into meta.source (code, name, provider, homepage_url, docs_url, license_id)
select 'test_source', 'Fuente de pruebas', 'Pruebas', 'https://example.test', 'https://example.test/docs', id
from meta.license where code = 'TEST-LICENSE';

insert into meta.source_host (source_id, host) select id, 'example.test' from meta.source where code = 'test_source';

insert into meta.endpoint (source_id, code, name, base_url, path_template, response_format)
select id, 'data', 'Datos de prueba', 'https://example.test', '/data', 'json' from meta.source where code = 'test_source';

insert into meta.dataset (source_id, endpoint_id, code, name, category_id, update_frequency)
select s.id, e.id, 'test:fixture', 'Dataset de pruebas', c.id, 'monthly'
from meta.source s join meta.endpoint e on e.source_id = s.id, meta.category c
where s.code = 'test_source' and c.code = 'economy';

insert into ref.country (iso3, iso2, name_en, name_es, is_iso_official) values
  ('ZZA', 'XA', 'Test country A', 'País de prueba A', false),
  ('ZZB', 'XB', 'Test country B', 'País de prueba B', false);

insert into core.indicator (source_id, dataset_id, external_code, name_en, category_id)
select s.id, d.id, 'TEST.IND', 'Test indicator', d.category_id
from meta.source s join meta.dataset d on d.source_id = s.id
where s.code = 'test_source';

select ops.record_admission_check('test_source', 'data', 'https://example.test/data', 200, 'application/json', 10, 'pass');

-- Ayudante: deja en staging una fila del indicador de prueba.
create function pg_temp.stage(p_run bigint, p_iso3 text, p_year int, p_value numeric) returns void
language sql as $$
  insert into staging.observation_load (run_id, indicator_id, country_id, frequency, period_start, period_end, period_label, value)
  select p_run, i.id, c.id, 'A', make_date(p_year, 1, 1), make_date(p_year, 12, 31), p_year::text, p_value
  from core.indicator i, ref.country c
  where i.external_code = 'TEST.IND' and c.iso3 = p_iso3;
$$;
