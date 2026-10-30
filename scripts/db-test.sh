#!/usr/bin/env bash
# Crea una base de pruebas desde cero, aplica todas las migraciones y ejecuta las
# aserciones SQL de db/test. Sin Docker:
#   - Local: levanta un clúster PostgreSQL temporal en .tmp/pg (puerto 54329).
#   - CI: usa un servidor existente si se define DATABASE_URL_ADMIN.
# Al terminar deja exportable DATABASE_URL_TEST para las pruebas de integración (vitest --project db).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DB_NAME="${DB_NAME:-odi_test}"
PORT="${PGPORT_TEST:-54329}"
TMP="$ROOT/.tmp"
PGDATA_DIR="$TMP/pg"
STARTED_LOCAL=0

run_as_pg() {
  if [ "$(id -u)" = "0" ]; then runuser -u postgres -- "$@"; else "$@"; fi
}

if [ -z "${DATABASE_URL_ADMIN:-}" ]; then
  PGBIN="${PGBIN:-$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1)}"
  [ -x "$PGBIN/initdb" ] || { echo "No se encontró initdb; define PGBIN o DATABASE_URL_ADMIN" >&2; exit 1; }
  mkdir -p "$TMP"
  if [ "$(id -u)" = "0" ]; then chown postgres "$TMP"; fi
  if [ ! -f "$PGDATA_DIR/PG_VERSION" ]; then
    run_as_pg "$PGBIN/initdb" -D "$PGDATA_DIR" -U postgres --auth=trust --encoding=UTF8 --locale=C.UTF-8 >/dev/null
  fi
  if ! run_as_pg "$PGBIN/pg_ctl" -D "$PGDATA_DIR" status >/dev/null 2>&1; then
    run_as_pg "$PGBIN/pg_ctl" -D "$PGDATA_DIR" -l "$PGDATA_DIR/server.log" -w \
      -o "-p $PORT -k $PGDATA_DIR -c listen_addresses=127.0.0.1" start >/dev/null
    STARTED_LOCAL=1
  fi
  DATABASE_URL_ADMIN="postgres://postgres@127.0.0.1:$PORT/postgres"
fi

cleanup() {
  if [ "$STARTED_LOCAL" = "1" ] && [ "${KEEP_DB:-0}" != "1" ]; then
    run_as_pg "$PGBIN/pg_ctl" -D "$PGDATA_DIR" -m fast stop >/dev/null
  fi
}
trap cleanup EXIT

PSQL=(psql -X -q -v ON_ERROR_STOP=1)
"${PSQL[@]}" "$DATABASE_URL_ADMIN" -c "drop database if exists $DB_NAME with (force)" -c "create database $DB_NAME"
DATABASE_URL_TEST="${DATABASE_URL_ADMIN%/*}/$DB_NAME"
export DATABASE_URL_TEST

echo "== Emulación de roles de Supabase"
"${PSQL[@]}" "$DATABASE_URL_TEST" -f "$ROOT/db/test/bootstrap.sql"

echo "== Migraciones"
for f in "$ROOT"/supabase/migrations/*.sql; do
  echo "   $(basename "$f")"
  "${PSQL[@]}" "$DATABASE_URL_TEST" -f "$f"
done

echo "== Pruebas SQL"
LOG="$TMP/db-test.log"
mkdir -p "$TMP"
for f in "$ROOT"/db/test/[0-9]*.test.sql; do
  echo "-- $(basename "$f")"
  if ! "${PSQL[@]}" "$DATABASE_URL_TEST" -f "$f" >"$LOG" 2>&1; then
    cat "$LOG" >&2
    echo "FALLO en $(basename "$f")" >&2
    exit 1
  fi
  sed -n 's/.*NOTICE:  /   /p' "$LOG"
done

if [ "${WITH_INTEGRATION:-0}" = "1" ]; then
  echo "== Pruebas de integración (vitest --project db)"
  (cd "$ROOT" && DATABASE_URL_TEST="$DATABASE_URL_TEST" pnpm exec vitest run --project db)
fi

echo "OK: migraciones y pruebas SQL superadas"
