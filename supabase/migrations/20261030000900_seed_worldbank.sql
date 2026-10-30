-- Configuración de la primera fuente: Banco Mundial (Indicators API v2).
-- Solo configuración del catálogo; los datos (países, indicadores, observaciones)
-- se obtienen de la API. La fuente nace como 'candidate' y el dataset como no público:
-- pasan a aprobados solo tras una prueba de admisión real y la revisión de licencia.

insert into meta.license (code, name, url, allows_commercial, requires_attribution, share_alike, notes)
values ('CC-BY-4.0', 'Creative Commons Attribution 4.0 International',
        'https://creativecommons.org/licenses/by/4.0/', true, true, false, null);

insert into meta.source (code, name, provider, homepage_url, docs_url, terms_url, license_id, status, restrictions)
select 'worldbank', 'World Bank Indicators API v2', 'Banco Mundial',
       'https://data.worldbank.org',
       'https://datahelpdesk.worldbank.org/knowledgebase/articles/889392-about-the-indicators-api',
       'https://www.worldbank.org/en/about/legal/terms-of-use-for-datasets',
       l.id, 'candidate',
       'Ingerir solo bases con CC BY 4.0 (WDI); atribución obligatoria'
from meta.license l where l.code = 'CC-BY-4.0';

insert into meta.source_host (source_id, host)
select id, 'api.worldbank.org' from meta.source where code = 'worldbank';

insert into meta.endpoint (source_id, code, name, base_url, path_template, response_format, timeout_ms)
select s.id, e.code, e.name, 'https://api.worldbank.org', e.path_template, 'json', 60000
from meta.source s
cross join (values
  ('catalog_v2', 'Catálogo v2: fuentes, indicadores y países', '/v2/{resource}'),
  ('indicator_data_v2', 'Observaciones de un indicador por país', '/v2/country/{geo}/indicator/{indicator}')
) as e (code, name, path_template)
where s.code = 'worldbank';

-- Indicadores del Sprint 1 (World Development Indicators, base 2 del Banco Mundial).
insert into meta.dataset (source_id, endpoint_id, code, name, category_id, update_frequency, config)
select s.id, e.id, d.code, d.name, c.id, 'monthly', d.config::jsonb
from meta.source s
join meta.endpoint e on e.source_id = s.id and e.code = 'indicator_data_v2'
cross join (values
  ('worldbank:wdi-economy', 'WDI: indicadores económicos básicos', 'economy',
   '{"wb_source_id": 2, "per_page": 1000, "indicators": ["NY.GDP.MKTP.CD", "NY.GDP.MKTP.KD.ZG", "NY.GDP.PCAP.CD", "FP.CPI.TOTL.ZG", "SL.UEM.TOTL.ZS", "GC.DOD.TOTL.GD.ZS", "NE.EXP.GNFS.ZS"]}'),
  ('worldbank:wdi-demography', 'WDI: indicadores demográficos básicos', 'demography',
   '{"wb_source_id": 2, "per_page": 1000, "indicators": ["SP.POP.TOTL", "SP.DYN.LE00.IN", "SP.DYN.CBRT.IN", "SP.DYN.CDRT.IN", "SP.URB.TOTL.IN.ZS"]}')
) as d (code, name, category, config)
join meta.category c on c.code = d.category
where s.code = 'worldbank';

insert into ops.dataset_schedule (dataset_id)
select id from meta.dataset where source_id = (select id from meta.source where code = 'worldbank');
