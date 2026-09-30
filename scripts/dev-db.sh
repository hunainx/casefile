#!/usr/bin/env bash
#
# Local Postgres 16 + pgvector + pg_trgm for Casefile development and integration tests.
#
# D36 specifies Docker Compose. DEV-001 records why this script exists alongside it:
# Docker is unavailable in some development environments (including the cloud workspace
# this repository was bootstrapped in), and integration tests CANNOT run against a mock
# database — tenancy, RLS, and the assertion CHECK constraints are the product's central
# guarantees and are properties of a real Postgres (D35, I2, I7).
#
# So: `infra/compose.yml` remains the documented default where Docker is available, and
# this script brings up a byte-identical schema on a native cluster where it is not.
# Both produce the same DATABASE_URL, so nothing downstream knows the difference.
#
#   scripts/dev-db.sh up       start the cluster, create roles, databases, extensions
#   scripts/dev-db.sh down     stop the cluster (data preserved)
#   scripts/dev-db.sh reset    destroy and recreate from scratch
#   scripts/dev-db.sh status   report whether it is running and reachable
#   scripts/dev-db.sh psql     open a shell on the dev database

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGDATA="${PGDATA:-$ROOT/.pgdata}"
PGLOG="${PGLOG:-$ROOT/.pglogs/postgres.log}"
PGPORT="${PGPORT:-55432}"
PGBIN="${PGBIN:-/usr/lib/postgresql/16/bin}"

DB_USER="casefile"
DB_PASS="casefile"
DB_NAME="casefile"
DB_TEST="casefile_test"

# The application role is deliberately NOT the owner and NOT a superuser. I7 requires
# that RLS actually applies to it; a superuser or table owner bypasses RLS by default
# and would make every tenancy guardrail pass vacuously.
APP_USER="casefile_app"
APP_PASS="casefile_app"

export PATH="$PGBIN:$PATH"
# Client auth over TCP is scram-sha-256. Supply the password non-interactively and use
# psql -w everywhere: a script that blocks on a hidden password prompt in CI looks
# exactly like a hung test suite.
export PGPASSWORD="${PGPASSWORD:-casefile}"

log()  { printf '  %s\n' "$*"; }
fail() { printf '  ERROR: %s\n' "$*" >&2; exit 1; }

# Postgres refuses to run its server process as root. Some development environments
# (containers, CI runners, the cloud workspace this repo was bootstrapped in) are root
# by default, so drop to an unprivileged owner for initdb and pg_ctl only. Client
# connections go over TCP and are unaffected.
SERVER_OWNER="${SERVER_OWNER:-postgres}"

as_owner() {
  if [ "$(id -u)" -eq 0 ]; then
    runuser -u "$SERVER_OWNER" -- env PATH="$PATH" PGDATA="$PGDATA" "$@"
  else
    "$@"
  fi
}

ensure_owner() {
  [ "$(id -u)" -eq 0 ] || return 0
  id -u "$SERVER_OWNER" >/dev/null 2>&1 \
    || fail "running as root and system user '$SERVER_OWNER' does not exist. Set SERVER_OWNER."
  mkdir -p "$PGDATA" "$(dirname "$PGLOG")"
  chown -R "$SERVER_OWNER" "$PGDATA" "$(dirname "$PGLOG")"
  chmod 700 "$PGDATA"
}

require_binaries() {
  for b in initdb pg_ctl psql createdb; do
    command -v "$b" >/dev/null 2>&1 || fail "'$b' not found. Set PGBIN, or install postgresql-16."
  done
}

is_running() {
  [ -d "$PGDATA" ] && as_owner pg_ctl -D "$PGDATA" status >/dev/null 2>&1
}

init_cluster() {
  [ -d "$PGDATA/base" ] && return 0
  log "initdb → $PGDATA"
  ensure_owner
  mkdir -p "$PGDATA" "$(dirname "$PGLOG")"
  local pwfile; pwfile="$(mktemp)"
  printf '%s' "$DB_PASS" > "$pwfile"
  chmod 644 "$pwfile"
  local LOCALE="C.UTF-8"
  if ! as_owner initdb --help 2>&1 | grep -q "C.UTF-8"; then
    LOCALE="C"
  fi
  as_owner initdb -D "$PGDATA" -U "$DB_USER" --auth-local=trust --auth-host=scram-sha-256 \
         --pwfile="$pwfile" --encoding=UTF8 --locale="$LOCALE" >/dev/null
  rm -f "$pwfile"

  cat >> "$PGDATA/postgresql.conf" <<CONF

# ---- Casefile development settings ----
port = $PGPORT
listen_addresses = '127.0.0.1'
max_connections = 100
shared_buffers = 256MB
# Integration tests assert on plan shape for the §49 targets; keep planning honest.
random_page_cost = 1.1
# Every statement over 200ms in development is worth seeing.
log_min_duration_statement = 200
log_line_prefix = '%m [%p] %q%u@%d '
CONF

  cat >> "$PGDATA/pg_hba.conf" <<CONF
host    all             all             127.0.0.1/32            scram-sha-256
CONF
}

start() {
  is_running && { log "already running on port $PGPORT"; return 0; }
  ensure_owner
  mkdir -p "$(dirname "$PGLOG")"
  log "starting cluster on port $PGPORT"
  as_owner pg_ctl -D "$PGDATA" -l "$PGLOG" -w -t 30 start >/dev/null \
    || { tail -30 "$PGLOG" >&2; fail "cluster failed to start"; }
}

provision() {
  local conn="-h 127.0.0.1 -p $PGPORT -U $DB_USER -d postgres"

  for db in "$DB_NAME" "$DB_TEST"; do
    if ! psql -w $conn -tAc "SELECT 1 FROM pg_database WHERE datname='$db'" | grep -q 1; then
      log "creating database $db"
      createdb -w -h 127.0.0.1 -p "$PGPORT" -U "$DB_USER" "$db"
    fi
  done

  if ! psql -w $conn -tAc "SELECT 1 FROM pg_roles WHERE rolname='$APP_USER'" | grep -q 1; then
    log "creating application role $APP_USER (NOSUPERUSER, NOBYPASSRLS)"
    psql -w $conn -q -c \
      "CREATE ROLE $APP_USER LOGIN PASSWORD '$APP_PASS' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;"
  fi

  for db in "$DB_NAME" "$DB_TEST"; do
    log "extensions in $db: vector, pg_trgm, pgcrypto, uuid-ossp"
    psql -w -h 127.0.0.1 -p "$PGPORT" -U "$DB_USER" -d "$db" -q <<SQL
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
GRANT CONNECT ON DATABASE $db TO $APP_USER;
GRANT USAGE ON SCHEMA public TO $APP_USER;
REVOKE CREATE ON SCHEMA public FROM $APP_USER;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
SQL
  done

  for db in "$DB_NAME" "$DB_TEST"; do
    log "applying migrations to $db..."
    DATABASE_URL_MIGRATIONS="postgres://$DB_USER:$DB_PASS@127.0.0.1:$PGPORT/$db" \
      npx tsx "$ROOT/packages/db/migrate/index.ts" --project-ref local
  done
}

verify() {
  local v; v=$(psql -w -h 127.0.0.1 -p "$PGPORT" -U "$DB_USER" -d "$DB_NAME" -tAc "SHOW server_version;")
  local ext; ext=$(psql -w -h 127.0.0.1 -p "$PGPORT" -U "$DB_USER" -d "$DB_NAME" -tAc \
    "SELECT string_agg(extname, ' ' ORDER BY extname) FROM pg_extension;")
  # I7 depends on this: if the app role can bypass RLS, every tenancy test is vacuous.
  local bypass; bypass=$(psql -w -h 127.0.0.1 -p "$PGPORT" -U "$DB_USER" -d "$DB_NAME" -tAc \
    "SELECT rolbypassrls OR rolsuper FROM pg_roles WHERE rolname='$APP_USER';")
  log "postgres $v"
  log "extensions: $ext"
  if [ "$bypass" = "t" ]; then
    fail "$APP_USER can bypass RLS. Invariant I7 cannot be enforced. Refusing."
  fi
  log "$APP_USER cannot bypass RLS ✓  (I7 enforceable)"
  log ""
  log "DATABASE_URL=postgres://$APP_USER:$APP_PASS@127.0.0.1:$PGPORT/$DB_NAME"
  log "DATABASE_URL_TEST=postgres://$APP_USER:$APP_PASS@127.0.0.1:$PGPORT/$DB_TEST"
}

# If Docker is available and running, use Docker Compose (the documented default per D36)
if command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; then
  PGPORT="55432"
  case "${1:-up}" in
    up)
      log "Docker detected — starting postgres via infra/compose.yml"
      docker compose -f "$ROOT/infra/compose.yml" up -d postgres
      log "waiting for postgres to accept connections..."
      until docker compose -f "$ROOT/infra/compose.yml" exec -T postgres pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; do
        sleep 1
      done
      verify
      exit 0
      ;;
    down)
      log "Docker detected — stopping postgres via infra/compose.yml"
      docker compose -f "$ROOT/infra/compose.yml" down
      exit 0
      ;;
    reset)
      log "Docker detected — recreating postgres container via infra/compose.yml"
      docker compose -f "$ROOT/infra/compose.yml" down -v
      docker compose -f "$ROOT/infra/compose.yml" up -d postgres
      log "waiting for postgres to accept connections..."
      until docker compose -f "$ROOT/infra/compose.yml" exec -T postgres pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; do
        sleep 1
      done
      for db in "$DB_NAME" "$DB_TEST"; do
        log "applying migrations to $db..."
        DATABASE_URL_MIGRATIONS="postgres://$DB_USER:$DB_PASS@127.0.0.1:$PGPORT/$db" \
          npx tsx "$ROOT/packages/db/migrate/index.ts" --project-ref local
      done
      verify
      exit 0
      ;;
    status)
      if docker compose -f "$ROOT/infra/compose.yml" exec -T postgres pg_isready -U "$DB_USER" -d "$DB_NAME" >/dev/null 2>&1; then
        log "running in docker on port $PGPORT"
        exit 0
      else
        log "not running"; exit 1
      fi
      ;;
    psql)
      exec docker compose -f "$ROOT/infra/compose.yml" exec postgres psql -U "$DB_USER" -d "$DB_NAME"
      ;;
  esac
fi

case "${1:-up}" in
  up)
    require_binaries; ensure_owner; init_cluster; start; provision; verify ;;
  down)
    is_running && { as_owner pg_ctl -D "$PGDATA" -m fast -w stop >/dev/null; log "stopped"; } || log "not running" ;;
  reset)
    is_running && as_owner pg_ctl -D "$PGDATA" -m immediate -w stop >/dev/null || true
    log "destroying $PGDATA"
    rm -rf "$PGDATA"
    require_binaries; init_cluster; start; provision; verify ;;
  status)
    if is_running; then
      log "running on port $PGPORT"
      psql -w -h 127.0.0.1 -p "$PGPORT" -U "$DB_USER" -d "$DB_NAME" -tAc "SELECT 'reachable';" || fail "unreachable"
    else
      log "not running"; exit 1
    fi ;;
  psql)
    exec psql -h 127.0.0.1 -p "$PGPORT" -U "$DB_USER" -d "$DB_NAME" ;;
  *)
    fail "unknown command '${1}'. Use: up | down | reset | status | psql" ;;
esac
