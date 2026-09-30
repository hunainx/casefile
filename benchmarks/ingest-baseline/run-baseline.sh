#!/usr/bin/env bash
#
# BIGDATA-1 ingest baseline on the LOCAL Docker stack only.
#
#   bash benchmarks/ingest-baseline/run-baseline.sh <fake-corpus folder> <results folder> <label> [limit minutes, default 120]
#
# Wipes the stack (docker compose down -v), starts it again with pg_stat_statements loaded,
# migrates the local database, runs today's ingestDirectory() on <corpus>/corpus through
# ingest-baseline.bench-run.ts, and summarises the CPU profile. Nothing here reaches a
# Supabase project, a GCP project or a live matter: every URL below is 127.0.0.1.

set -uo pipefail
CORPUS="${1:?fake-corpus folder}"
OUT="${2:?results folder}"
LABEL="${3:?label}"
LIMIT="${4:-120}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
mkdir -p "$OUT"
COMPOSE=(docker compose -f infra/compose.yml -f benchmarks/ingest-baseline/compose.pgss.yml)
# The local fake-gcs emulator's sandbox buckets (the ones the integration tests use).
SANDBOX=casefile-localtest

echo "\$ ${COMPOSE[*]} down -v"
"${COMPOSE[@]}" down -v 2>&1
echo "\$ ${COMPOSE[*]} up -d"
"${COMPOSE[@]}" up -d 2>&1
for _ in $(seq 1 90); do
  s=$(docker inspect -f '{{.State.Health.Status}}' casefile-postgres-1 2>/dev/null)
  [ "$s" = healthy ] && break
  sleep 2
done
echo "postgres health: $s"
echo "\$ DATABASE_URL_MIGRATIONS=postgres://casefile:***@127.0.0.1:55432/casefile npx tsx packages/db/migrate/index.ts --project-ref local"
DATABASE_URL_MIGRATIONS=postgres://casefile:casefile@127.0.0.1:55432/casefile npx tsx packages/db/migrate/index.ts --project-ref local 2>&1 | tail -3
docker exec casefile-postgres-1 psql -U casefile -d casefile -c "CREATE EXTENSION IF NOT EXISTS pg_stat_statements" 2>&1

echo "\$ vitest run --config benchmarks/ingest-baseline/vitest.config.ts   (BENCH_LABEL=$LABEL, limit $LIMIT min)"
BENCH_CORPUS="$CORPUS" BENCH_OUT="$OUT" BENCH_LABEL="$LABEL" BENCH_LIMIT_MINUTES="$LIMIT" \
  DATABASE_URL=postgres://casefile_app:casefile_app@127.0.0.1:55432/casefile \
  DATABASE_URL_OWNER=postgres://casefile:casefile@127.0.0.1:55432/casefile \
  STORAGE_DRIVER=gcs STORAGE_EMULATOR_HOST=http://127.0.0.1:4443 \
  GCS_BUCKET_SOURCES="${SANDBOX}-sources" GCS_BUCKET_ARTIFACTS="${SANDBOX}-artifacts" GCS_BUCKET_EXPORTS="${SANDBOX}-exports" \
  JWT_SECRET=bench_jwt_secret_at_least_32_bytes_long_0000 \
  NO_COLOR=1 FORCE_COLOR=0 npx vitest run --config benchmarks/ingest-baseline/vitest.config.ts 2>&1 | grep -v "Indexing all PDF objects"
echo "exit ${PIPESTATUS[0]}"

echo "--- object storage used in the fake-gcs container"
MSYS_NO_PATHCONV=1 docker exec casefile-fake-gcs-1 du -sh /storage 2>&1
PROFILE="$OUT/cpuprofile-$LABEL.cpuprofile"
if [ -f "$PROFILE" ]; then
  npx tsx benchmarks/ingest-baseline/summarize-cpuprofile.ts "$PROFILE" 30 > "$OUT/cpuprofile-$LABEL-summary.txt" 2>&1
  echo "CPU profile summary: $OUT/cpuprofile-$LABEL-summary.txt"
fi
