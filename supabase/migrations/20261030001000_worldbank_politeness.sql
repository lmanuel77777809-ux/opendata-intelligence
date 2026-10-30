-- El Banco Mundial no publica límite de peticiones. Nos imponemos uno de cortesía
-- (4 peticiones por segundo) para no cargar su servicio.
update meta.endpoint e
set rate_limit_per_second = 4
from meta.source s
where s.id = e.source_id and s.code = 'worldbank';

comment on column meta.endpoint.rate_limit_per_second is 'Límite documentado por el proveedor o, si no publica ninguno, límite propio de cortesía';
