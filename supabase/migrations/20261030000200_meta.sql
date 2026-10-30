-- Catálogo: licencias, categorías, fuentes, hosts permitidos, endpoints, datasets
-- y evidencia de las pruebas de admisión.

create table meta.license (
  id smallint generated always as identity primary key,
  code text not null unique,
  name text not null,
  url text not null check (url ~ '^https://'),
  allows_commercial boolean not null,
  requires_attribution boolean not null,
  share_alike boolean not null,
  notes text
);
comment on table meta.license is 'Licencias de reutilización de los datos';

create table meta.category (
  id smallint generated always as identity primary key,
  code text not null unique check (code ~ '^[a-z_]+$'),
  name_es text not null,
  name_en text not null
);
comment on table meta.category is 'Las cinco áreas de la plataforma';

insert into meta.category (code, name_es, name_en) values
  ('economy', 'Economía y finanzas', 'Economy and finance'),
  ('history', 'Historia mundial', 'World history'),
  ('demography', 'Demografía y sociedad', 'Demography and society'),
  ('business', 'Empresas y sectores', 'Business and sectors'),
  ('sports_entertainment', 'Deportes y entretenimiento', 'Sports and entertainment');

create table meta.source (
  id smallint generated always as identity primary key,
  code text not null unique check (code ~ '^[a-z0-9_]+$'),
  name text not null,
  provider text not null,
  homepage_url text not null check (homepage_url ~ '^https://'),
  docs_url text not null check (docs_url ~ '^https://'),
  terms_url text check (terms_url ~ '^https://'),
  license_id smallint not null references meta.license (id),
  status text not null default 'candidate'
    check (status in ('candidate', 'approved', 'approved_restricted', 'rejected', 'quarantined', 'retired')),
  status_reason text,
  restrictions text,
  terms_reviewed_at date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Una fuente rechazada, en cuarentena o restringida debe explicar por qué.
  check (status not in ('rejected', 'quarantined', 'approved_restricted') or status_reason is not null)
);
comment on table meta.source is 'Proveedores de API públicas y su estado de admisión';
comment on column meta.source.status is 'candidate: en evaluación; approved/approved_restricted: publicable; rejected/quarantined/retired: no se ingiere';

-- Lista blanca de hosts: el worker solo puede llamar a hosts registrados aquí.
create table meta.source_host (
  source_id smallint not null references meta.source (id),
  host text not null unique check (host ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'),
  primary key (source_id, host)
);
comment on table meta.source_host is 'Lista blanca de hosts por fuente; protege contra URLs arbitrarias';

create table meta.endpoint (
  id smallint generated always as identity primary key,
  source_id smallint not null references meta.source (id),
  code text not null check (code ~ '^[a-z0-9_]+$'),
  name text not null,
  base_url text not null check (base_url ~ '^https://[a-z0-9.-]+(/.*)?$'),
  path_template text not null check (path_template ~ '^/'),
  response_format text not null
    check (response_format in ('json', 'xml', 'csv', 'sdmx-json', 'sdmx-ml', 'json-stat', 'sparql-json')),
  page_size_max integer check (page_size_max > 0),
  rate_limit_per_second numeric check (rate_limit_per_second > 0),
  rate_limit_per_hour integer check (rate_limit_per_hour > 0),
  timeout_ms integer not null default 30000 check (timeout_ms between 1000 and 300000),
  unique (source_id, code),
  unique (id, source_id)
);
comment on table meta.endpoint is 'Endpoints documentados de cada fuente, con sus límites';

-- El host del endpoint debe estar en la lista blanca de su fuente.
create function meta.check_endpoint_host() returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_host text := substring(new.base_url from '^https://([^/:]+)');
begin
  if not exists (
    select 1 from meta.source_host h where h.source_id = new.source_id and h.host = v_host
  ) then
    raise exception 'host % no está en la lista blanca de la fuente %', v_host, new.source_id
      using errcode = 'check_violation';
  end if;
  return new;
end
$$;

create trigger endpoint_host_allowlisted
  before insert or update of base_url, source_id on meta.endpoint
  for each row execute function meta.check_endpoint_host();

create table meta.dataset (
  id smallint generated always as identity primary key,
  source_id smallint not null,
  endpoint_id smallint not null,
  code text not null unique check (code ~ '^[a-z0-9_]+:[a-z0-9_.-]+$'),
  name text not null,
  category_id smallint not null references meta.category (id),
  license_id smallint references meta.license (id),
  update_frequency text not null
    check (update_frequency in ('daily', 'weekly', 'monthly', 'quarterly', 'annual')),
  config jsonb not null default '{}'::jsonb check (jsonb_typeof(config) = 'object'),
  is_public boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- El endpoint debe pertenecer a la misma fuente que el dataset.
  foreign key (endpoint_id, source_id) references meta.endpoint (id, source_id)
);
comment on table meta.dataset is 'Unidad de ingesta y de programación; la frecuencia es por dataset, no por proveedor';
comment on column meta.dataset.license_id is 'Licencia propia del dataset si difiere de la de la fuente';
comment on column meta.dataset.is_public is 'Solo visible por la API si es público y la fuente está aprobada';

create index dataset_source_idx on meta.dataset (source_id);

-- Evidencia de cada prueba de admisión (petición anónima real).
create table meta.admission_check (
  id bigint generated always as identity primary key,
  endpoint_id smallint not null references meta.endpoint (id),
  checked_at timestamptz not null default now(),
  request_url text not null check (request_url ~ '^https://'),
  http_status smallint check (http_status between 100 and 599),
  content_type text,
  latency_ms integer check (latency_ms >= 0),
  outcome text not null
    check (outcome in ('pass', 'fail_http', 'fail_auth_required', 'fail_network', 'fail_format')),
  detail text,
  checked_by text not null default current_user,
  check (outcome <> 'pass' or http_status between 200 and 299)
);
comment on table meta.admission_check is 'Pruebas HTTP anónimas reales; sin una prueba superada reciente no se ingiere';

create index admission_check_endpoint_idx on meta.admission_check (endpoint_id, checked_at desc);
