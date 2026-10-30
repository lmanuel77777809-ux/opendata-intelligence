#!/usr/bin/env bash
# Aplica en orden las migraciones pendientes de supabase/migrations, cada una en su propia
# transacción. Registra lo aplicado en supabase_migrations.schema_migrations, la misma tabla que
# usa el CLI de Supabase, para que ambos sean compatibles.
#   bash scripts/migrate.sh <url_postgres> [--dry-run]
set -euo pipefail

DB_URL="${1:?Uso: migrate.sh <url_postgres> [--dry-run]}"
DRY_RUN="${2:-}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PSQL=(psql -X -q -v ON_ERROR_STOP=1 "$DB_URL")

"${PSQL[@]}" -c "set client_min_messages = warning" -c "create schema if not exists supabase_migrations" \
  -c "create table if not exists supabase_migrations.schema_migrations (version text not null primary key, statements text[], name text)"
applied="$("${PSQL[@]}" -At -c "select version from supabase_migrations.schema_migrations")"

pending=0
for f in "$ROOT"/supabase/migrations/*.sql; do
  base="$(basename "$f" .sql)"
  version="${base%%_*}"
  name="${base#*_}"
  [[ "$version" =~ ^[0-9]{14}$ ]] || { echo "Nombre de migración no válido: $base" >&2; exit 1; }
  if grep -qx "$version" <<<"$applied"; then continue; fi
  pending=$((pending + 1))
  echo "   $base"
  [ "$DRY_RUN" = "--dry-run" ] && continue
  "${PSQL[@]}" --single-transaction -c "set client_min_messages = warning" -f "$f" \
    -c "insert into supabase_migrations.schema_migrations (version, name) values ('$version', '$name')"
done
echo "Migraciones pendientes aplicadas: $pending${DRY_RUN:+ (simulación)}"
