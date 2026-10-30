#!/usr/bin/env bash
# Arranca PostgREST (la misma pieza que usa Supabase para su API REST) contra una base de
# pruebas, exponiendo solo el esquema api, y espera a que responda. Requiere Docker (CI).
#   DB_URI=postgres://authenticator:...@localhost:5432/odi_test bash scripts/start-postgrest.sh
set -euo pipefail

IMAGE="${POSTGREST_IMAGE:-postgrest/postgrest:v12.2.3}"
PORT="${POSTGREST_PORT:-3000}"
: "${DB_URI:?Define DB_URI}"

docker rm -f odi-postgrest >/dev/null 2>&1 || true
docker run -d --name odi-postgrest --network host \
  -e PGRST_DB_URI="$DB_URI" \
  -e PGRST_DB_SCHEMAS=api \
  -e PGRST_DB_ANON_ROLE=anon \
  -e PGRST_DB_MAX_ROWS=1000 \
  -e PGRST_SERVER_PORT="$PORT" \
  "$IMAGE" >/dev/null

for _ in $(seq 1 60); do
  if curl -fsS -o /dev/null "http://localhost:$PORT/"; then
    echo "PostgREST listo en http://localhost:$PORT ($IMAGE)"
    exit 0
  fi
  sleep 1
done
docker logs odi-postgrest >&2 || true
echo "PostgREST no arrancó" >&2
exit 1
