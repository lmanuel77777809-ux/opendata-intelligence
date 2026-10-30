-- Operación de la ingesta: ejecuciones, errores, rechazos y programación por dataset.

create table ops.ingestion_run (
  id bigint generated always as identity primary key,
  dataset_id smallint not null references meta.dataset (id),
  trigger text not null check (trigger in ('schedule', 'manual', 'test')),
  status text not null default 'running' check (status in ('running', 'success', 'partial', 'failed')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  duration_ms integer check (duration_ms >= 0),
  connector_version text not null,
  parameters jsonb not null default '{}'::jsonb,
  http_requests integer not null default 0 check (http_requests >= 0),
  records_received integer not null default 0 check (records_received >= 0),
  records_inserted integer not null default 0 check (records_inserted >= 0),
  records_updated integer not null default 0 check (records_updated >= 0),
  records_unchanged integer not null default 0 check (records_unchanged >= 0),
  records_rejected integer not null default 0 check (records_rejected >= 0),
  records_withdrawn integer not null default 0 check (records_withdrawn >= 0),
  records_null integer not null default 0 check (records_null >= 0),
  error_summary text,
  check ((status = 'running') = (finished_at is null)),
  check (finished_at is null or finished_at >= started_at)
);
comment on table ops.ingestion_run is 'Una fila por ejecución, con sus métricas';
comment on column ops.ingestion_run.records_null is 'Filas recibidas sin valor publicado; no se almacenan';
comment on column ops.ingestion_run.records_withdrawn is 'Observaciones que el proveedor dejó de publicar (se conservan, marcadas)';

create index ingestion_run_dataset_idx on ops.ingestion_run (dataset_id, started_at desc);
-- Nunca dos ejecuciones simultáneas del mismo dataset.
create unique index ingestion_run_one_running on ops.ingestion_run (dataset_id) where status = 'running';

create table ops.ingestion_error (
  id bigint generated always as identity primary key,
  run_id bigint not null references ops.ingestion_run (id),
  occurred_at timestamptz not null default now(),
  phase text not null check (phase in ('availability', 'discovery', 'fetch', 'validate', 'normalize', 'store')),
  http_status smallint check (http_status between 100 and 599),
  url text,
  error_code text not null,
  message text not null,
  detail jsonb
);
create index ingestion_error_run_idx on ops.ingestion_error (run_id);

create table ops.rejected_record (
  id bigint generated always as identity primary key,
  run_id bigint not null references ops.ingestion_run (id),
  reason text not null,
  raw jsonb not null,
  created_at timestamptz not null default now()
);
create index rejected_record_run_idx on ops.rejected_record (run_id);
comment on table ops.rejected_record is 'Registros recibidos y descartados, con su motivo';

create table ops.dataset_schedule (
  dataset_id smallint primary key references meta.dataset (id),
  enabled boolean not null default true,
  next_run_at timestamptz not null default now(),
  last_run_id bigint references ops.ingestion_run (id),
  last_run_at timestamptz,
  last_success_run_id bigint references ops.ingestion_run (id),
  last_success_at timestamptz
);
comment on table ops.dataset_schedule is 'Próxima y últimas ejecuciones por dataset';

create function ops.next_run_after(p_frequency text, p_from timestamptz) returns timestamptz
language sql immutable
set search_path = ''
as $$
  select p_from + case p_frequency
    when 'daily' then interval '1 day'
    when 'weekly' then interval '7 days'
    when 'monthly' then interval '1 month'
    when 'quarterly' then interval '3 months'
    when 'annual' then interval '1 year'
  end
$$;
