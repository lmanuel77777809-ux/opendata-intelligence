-- Datos de referencia. Se cargan desde API (p. ej. /v2/country del Banco Mundial),
-- nunca a mano.

create table ref.country (
  id smallint generated always as identity primary key,
  iso3 char(3) not null unique check (iso3 ~ '^[A-Z]{3}$'),
  iso2 char(2) unique check (iso2 ~ '^[A-Z0-9]{2}$'),
  m49 char(3) unique check (m49 ~ '^[0-9]{3}$'),
  name_en text not null,
  name_es text,
  is_iso_official boolean,
  updated_at timestamptz not null default now()
);
comment on table ref.country is 'Países y economías con código de tres letras';
comment on column ref.country.is_iso_official is 'true/false solo si una fuente lo verifica; null = sin verificar';

-- Agregados definidos por un proveedor (regiones, grupos de ingreso, uniones).
-- Un mismo código puede significar cosas distintas según el proveedor.
create table ref.region (
  id integer generated always as identity primary key,
  defined_by_source_id smallint references meta.source (id),
  code text not null check (code ~ '^[A-Z0-9_]+$'),
  name_en text not null,
  name_es text,
  kind text not null
    check (kind in ('world', 'geographic', 'income_group', 'lending_group', 'economic_union', 'other')),
  updated_at timestamptz not null default now(),
  unique nulls not distinct (defined_by_source_id, code)
);
comment on table ref.region is 'Agregados y regiones, con el proveedor que los define';

create table ref.region_member (
  region_id integer not null references ref.region (id),
  country_id smallint not null references ref.country (id),
  primary key (region_id, country_id)
);
create index region_member_country_idx on ref.region_member (country_id);

-- Equivalencia entre los códigos de cada proveedor y nuestra geografía.
create table ref.geo_code_map (
  source_id smallint not null references meta.source (id),
  code text not null,
  country_id smallint references ref.country (id),
  region_id integer references ref.region (id),
  primary key (source_id, code),
  check (num_nonnulls(country_id, region_id) = 1)
);
comment on table ref.geo_code_map is 'Códigos geográficos de cada proveedor (ISO2, ISO3, propios) hacia país o región';

create table ref.unit (
  id smallint generated always as identity primary key,
  code text not null unique,
  name_es text not null,
  name_en text not null,
  kind text not null check (kind in ('currency', 'percent', 'count', 'rate', 'index', 'ratio', 'years', 'other'))
);
comment on table ref.unit is 'Unidades normalizadas; los indicadores guardan además la unidad tal como la publica el proveedor';
