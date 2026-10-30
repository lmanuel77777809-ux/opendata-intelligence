-- Registro de cambios del catálogo: estado de las fuentes y publicación de datasets.
-- Cada decisión de gobierno (aprobar, rechazar, poner en cuarentena, publicar, retirar) queda
-- con su motivo, fecha y autor. El motivo de un cambio de dataset se pasa con
--   set local odi.change_reason = '...';

create table meta.catalog_change (
  id bigint generated always as identity primary key,
  entity text not null check (entity in ('source', 'dataset')),
  entity_code text not null,
  field text not null,
  old_value text,
  new_value text,
  reason text,
  changed_at timestamptz not null default now(),
  changed_by text not null default current_user
);
comment on table meta.catalog_change is 'Historial de decisiones sobre fuentes y datasets (append-only)';
create index catalog_change_entity_idx on meta.catalog_change (entity, entity_code, changed_at);
alter table meta.catalog_change enable row level security;

create function meta.log_source_status() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or old.status is distinct from new.status then
    insert into meta.catalog_change (entity, entity_code, field, old_value, new_value, reason)
    values ('source', new.code, 'status', case when tg_op = 'UPDATE' then old.status end, new.status,
            coalesce(new.status_reason, nullif(current_setting('odi.change_reason', true), '')));
  end if;
  return null;
end
$$;

create function meta.log_dataset_publication() returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' or old.is_public is distinct from new.is_public then
    insert into meta.catalog_change (entity, entity_code, field, old_value, new_value, reason)
    values ('dataset', new.code, 'is_public', case when tg_op = 'UPDATE' then old.is_public::text end, new.is_public::text,
            nullif(current_setting('odi.change_reason', true), ''));
  end if;
  return null;
end
$$;

create trigger source_status_log after insert or update of status on meta.source
  for each row execute function meta.log_source_status();
create trigger dataset_publication_log after insert or update of is_public on meta.dataset
  for each row execute function meta.log_dataset_publication();

-- El historial no se edita ni se borra.
create trigger catalog_change_append_only before update or delete on meta.catalog_change
  for each row execute function core.forbid_history_change();

-- Estado de partida de lo que ya existe.
insert into meta.catalog_change (entity, entity_code, field, old_value, new_value, reason)
select 'source', code, 'status', null, status, 'estado inicial' from meta.source;
insert into meta.catalog_change (entity, entity_code, field, old_value, new_value, reason)
select 'dataset', code, 'is_public', null, is_public::text, 'estado inicial' from meta.dataset;

revoke execute on function meta.log_source_status(), meta.log_dataset_publication() from public;
