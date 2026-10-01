#!/usr/bin/env bash
# Runs the DB integration tests. Uses TEST_DATABASE_URL if set; otherwise boots a throwaway local Postgres cluster.
set -euo pipefail
cd "$(dirname "$0")/.."
run() { node --test test/db/*.test.ts; }
if [ -n "${TEST_DATABASE_URL:-}" ]; then run; exit $?; fi

BIN=$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | tail -1 || true)
[ -n "$BIN" ] || { echo "No Postgres found. Set TEST_DATABASE_URL or install postgresql." >&2; exit 1; }
DIR=$(mktemp -d /tmp/strpg.XXXXXX); PORT=$((20000 + RANDOM % 20000))
AS=""; if [ "$(id -u)" = "0" ]; then chown postgres "$DIR"; AS="su postgres -c"; fi
exec_pg() { if [ -n "$AS" ]; then su postgres -c "$*"; else bash -c "$*"; fi; }
cleanup() { exec_pg "$BIN/pg_ctl -D $DIR/data stop -m immediate" >/dev/null 2>&1 || true; rm -rf "$DIR"; }
trap cleanup EXIT
exec_pg "$BIN/initdb -D $DIR/data -A trust" >/dev/null
exec_pg "$BIN/pg_ctl -D $DIR/data -o '-p $PORT -k $DIR -c listen_addresses=127.0.0.1 -c fsync=off' -l $DIR/log start -w" >/dev/null
TEST_DATABASE_URL="postgres://postgres@127.0.0.1:$PORT/postgres" run
