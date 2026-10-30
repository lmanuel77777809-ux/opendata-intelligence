-- DATOS SINTÉTICOS para las pruebas de contrato de la API REST (no se revierten: la base de
-- pruebas se recrea en cada ejecución). Fuente de prueba aprobada y dataset público.
\ir fixtures.sql
update meta.source set status = 'approved' where code = 'test_source';
update meta.dataset set is_public = true where code = 'test:fixture';
-- Fuente candidata: no debe aparecer en la API.
insert into meta.source (code, name, provider, homepage_url, docs_url, license_id)
select 'test_candidate', 'Fuente candidata de pruebas', 'Pruebas', 'https://example.test', 'https://example.test/docs', id
from meta.license where code = 'TEST-LICENSE';

select ops.start_run('test:fixture', 'test', 'api-fixture') as run \gset
select pg_temp.stage(:run, iso3, y, (y - 1990) * 1.5 + case iso3 when 'ZZA' then 0 else 100 end)
from unnest(array['ZZA', 'ZZB']) as iso3, generate_series(1991, 2010) as y;
select * from ops.merge_observations(:run);
select ops.finish_run(:run, 'success');
