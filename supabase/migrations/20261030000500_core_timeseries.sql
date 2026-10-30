-- Series temporales: indicador → serie (geografía, frecuencia, dimensiones) → observación.
-- La observación guarda el valor vigente; cada cambio deja una fila en observation_revision.
-- Nada se borra: un dato que el proveedor retira se marca con withdrawn_at.

create table core.indicator (
  id integer generated always as identity primary key,
  source_id smallint not null references meta.source (id),
  dataset_id smallint not null references meta.dataset (id),
  external_code text not null,
  name_en text not null,
  name_es text,
  description text,
  unit_label text,
  unit_id smallint references ref.unit (id),
  category_id smallint not null references meta.category (id),
  source_organization text,
  license_id smallint references meta.license (id),
  provider_last_updated date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_id, external_code)
);
comment on table core.indicator is 'Indicadores tal como los publica cada proveedor';
comment on column core.indicator.unit_label is 'Unidad tal como la publica el proveedor';

create index indicator_dataset_idx on core.indicator (dataset_id);

create table core.series (
  id bigint generated always as identity primary key,
  indicator_id integer not null references core.indicator (id),
  country_id smallint references ref.country (id),
  region_id integer references ref.region (id),
  frequency char(1) not null check (frequency in ('A', 'Q', 'M', 'W', 'D')),
  dimensions jsonb not null default '{}'::jsonb check (jsonb_typeof(dimensions) = 'object'),
  -- jsonb::text es canónico (claves ordenadas), así que el hash es estable.
  dimensions_key text generated always as (md5(dimensions::text)) stored,
  first_run_id bigint not null references ops.ingestion_run (id),
  last_seen_run_id bigint not null references ops.ingestion_run (id),
  created_at timestamptz not null default now(),
  check (num_nonnulls(country_id, region_id) = 1),
  constraint series_natural_key unique nulls not distinct (indicator_id, country_id, region_id, frequency, dimensions_key)
);
comment on table core.series is 'Una serie = indicador + geografía + frecuencia + dimensiones';

create index series_country_idx on core.series (country_id) where country_id is not null;
create index series_region_idx on core.series (region_id) where region_id is not null;

create table core.observation (
  series_id bigint not null references core.series (id),
  period_start date not null,
  period_end date not null,
  period_label text not null,
  value numeric not null,
  obs_status text,
  first_run_id bigint not null references ops.ingestion_run (id),
  last_run_id bigint not null references ops.ingestion_run (id),
  first_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  withdrawn_at timestamptz,
  primary key (series_id, period_start),
  check (period_end >= period_start)
);
comment on table core.observation is 'Valor vigente por serie y período; los nulos del proveedor no se almacenan';
comment on column core.observation.obs_status is 'Marca del proveedor (estimación, provisional, proyección)';
comment on column core.observation.withdrawn_at is 'Fecha en que el proveedor dejó de publicar el dato; el valor se conserva';

create table core.observation_revision (
  id bigint generated always as identity primary key,
  series_id bigint not null,
  period_start date not null,
  change_kind text not null check (change_kind in ('revised', 'withdrawn', 'restored')),
  old_value numeric,
  new_value numeric,
  old_obs_status text,
  new_obs_status text,
  run_id bigint not null references ops.ingestion_run (id),
  revised_at timestamptz not null default now(),
  foreign key (series_id, period_start) references core.observation (series_id, period_start)
);
comment on table core.observation_revision is 'Historial append-only de cambios de cada observación';

create index observation_revision_obs_idx on core.observation_revision (series_id, period_start, revised_at);
create index observation_revision_run_idx on core.observation_revision (run_id);

create function core.log_observation_revision() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  insert into core.observation_revision
    (series_id, period_start, change_kind, old_value, new_value, old_obs_status, new_obs_status, run_id)
  values (
    old.series_id,
    old.period_start,
    case
      when old.withdrawn_at is null and new.withdrawn_at is not null then 'withdrawn'
      when old.withdrawn_at is not null and new.withdrawn_at is null then 'restored'
      else 'revised'
    end,
    case when old.withdrawn_at is null then old.value end,
    case when new.withdrawn_at is null then new.value end,
    old.obs_status,
    new.obs_status,
    new.last_run_id
  );
  return null;
end
$$;

create trigger observation_revision_log
  after update on core.observation
  for each row
  when (old.value is distinct from new.value
        or old.obs_status is distinct from new.obs_status
        or old.withdrawn_at is distinct from new.withdrawn_at)
  execute function core.log_observation_revision();

-- El historial se conserva: ni observaciones ni revisiones se borran, y las revisiones no se editan.
create function core.forbid_history_change() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception '% sobre %.% no está permitido: el historial es inmutable', tg_op, tg_table_schema, tg_table_name
    using errcode = 'insufficient_privilege';
end
$$;

create trigger observation_no_delete
  before delete on core.observation
  for each row execute function core.forbid_history_change();

create trigger observation_revision_append_only
  before update or delete on core.observation_revision
  for each row execute function core.forbid_history_change();
