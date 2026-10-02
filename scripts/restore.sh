#!/usr/bin/env bash
# Restores a backup made by scripts/backup.sh. DESTRUCTIVE: replaces the contents of the target database.
#
#   scripts/restore.sh --db backups/db-20261002T020000Z.dump [--files backups/files-20261002T020000Z.tgz] --yes
#
# Target comes from PGHOST/PGUSER/PGPASSWORD/PGDATABASE; files go to FILES_DIR. Stop the app and worker first.
# Encrypted (.gpg) backups need BACKUP_PASSPHRASE. The matching manifest-<ts>.sha256 next to the files is verified when present.
# The database restore is a single transaction: it either fully succeeds or leaves the database as it was.
set -euo pipefail
umask 077
db=""; files=""; yes=0
while [ $# -gt 0 ]; do case "$1" in --db) db="$2"; shift 2;; --files) files="$2"; shift 2;; --yes) yes=1; shift;; *) echo "unknown argument: $1" >&2; exit 2;; esac; done
[ -n "$db" ] || { echo "usage: restore.sh --db <dump> [--files <tgz>] --yes" >&2; exit 2; }
: "${PGDATABASE:?PGDATABASE is required}"
[ "$yes" = 1 ] || { echo "This REPLACES the contents of database '$PGDATABASE' on '${PGHOST:-local socket}'. Re-run with --yes to proceed." >&2; exit 1; }

work="$(mktemp -d)"; trap 'rm -rf "$work"' EXIT
verify() { local f="$1" dir base; dir="$(dirname "$f")"; base="$(basename "$f")"
  for m in "$dir"/manifest-*.sha256; do [ -f "$m" ] || continue
    if grep -q " $base\$" "$m"; then ( cd "$dir" && grep " $base\$" "$m" | sha256sum -c --quiet - ) && echo "[restore] checksum OK: $base" || { echo "[restore] CHECKSUM MISMATCH for $base" >&2; exit 1; }; return; fi
  done; echo "[restore] no manifest found for $base (skipping checksum)"; }
plain() { local f="$1" out="$2"
  case "$f" in *.gpg) : "${BACKUP_PASSPHRASE:?BACKUP_PASSPHRASE is required for encrypted backups}"
      gpg --batch --yes --quiet --pinentry-mode loopback --passphrase "$BACKUP_PASSPHRASE" -o "$out" --decrypt "$f";;
    *) cp "$f" "$out";; esac; }

verify "$db"; plain "$db" "$work/db.dump"
echo "[restore] restoring database '$PGDATABASE' (single transaction)"
pg_restore --clean --if-exists --no-owner --no-privileges --exit-on-error --single-transaction -d "$PGDATABASE" "$work/db.dump"

if [ -n "$files" ]; then
  : "${FILES_DIR:?FILES_DIR is required to restore files}"
  verify "$files"; plain "$files" "$work/files.tgz"
  mkdir -p "$FILES_DIR"; tar -C "$FILES_DIR" -xzf "$work/files.tgz"
  echo "[restore] files extracted to $FILES_DIR"
fi
echo "[restore] done. Next: node src/cli/preflight.ts && node src/cli/verify-data.ts"
