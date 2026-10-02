#!/usr/bin/env bash
# Backs up the database (pg_dump, custom format) and, for local file storage, the receipts/statement archive.
#
#   Docker:     docker compose run --rm backup
#   Directly:   PGHOST=... PGUSER=... PGPASSWORD=... PGDATABASE=... BACKUP_DIR=/var/backups/str FILES_DIR=/path/to/files scripts/backup.sh
#
# Env: BACKUP_DIR (default ./backups), FILES_DIR (optional; omit when FILE_STORE=s3), KEEP_DAYS (default 14),
#      BACKUP_PASSPHRASE (optional; encrypts with AES-256 via gpg, store the passphrase somewhere OTHER than this server).
# Output: db-<ts>.dump[.gpg], files-<ts>.tgz[.gpg], manifest-<ts>.sha256. Files are written as .partial and renamed only when complete.
set -euo pipefail
umask 077
BACKUP_DIR="${BACKUP_DIR:-./backups}"; KEEP_DAYS="${KEEP_DAYS:-14}"; FILES_DIR="${FILES_DIR:-}"
: "${PGDATABASE:?PGDATABASE is required (plus PGHOST/PGUSER/PGPASSWORD)}"
mkdir -p "$BACKUP_DIR"
ts="$(date -u +%Y%m%dT%H%M%SZ)"
artifacts=()

echo "[backup] database ${PGDATABASE}@${PGHOST:-local socket}"
pg_dump --format=custom --compress=6 --no-owner --no-privileges --file "$BACKUP_DIR/db-$ts.dump.partial"
pg_restore --list "$BACKUP_DIR/db-$ts.dump.partial" >/dev/null   # unreadable catalog = truncated or corrupt dump
mv "$BACKUP_DIR/db-$ts.dump.partial" "$BACKUP_DIR/db-$ts.dump"
artifacts+=("db-$ts.dump")

if [ -n "$FILES_DIR" ] && [ -d "$FILES_DIR" ]; then
  echo "[backup] files from $FILES_DIR"
  tar -C "$FILES_DIR" -czf "$BACKUP_DIR/files-$ts.tgz.partial" .
  tar -tzf "$BACKUP_DIR/files-$ts.tgz.partial" >/dev/null
  mv "$BACKUP_DIR/files-$ts.tgz.partial" "$BACKUP_DIR/files-$ts.tgz"
  artifacts+=("files-$ts.tgz")
else
  echo "[backup] no FILES_DIR: skipping files (back up your S3 bucket separately, e.g. with versioning + replication)"
fi

if [ -n "${BACKUP_PASSPHRASE:-}" ]; then
  encrypted=()
  for a in "${artifacts[@]}"; do
    gpg --batch --yes --quiet --pinentry-mode loopback --passphrase "$BACKUP_PASSPHRASE" --symmetric --cipher-algo AES256 -o "$BACKUP_DIR/$a.gpg" "$BACKUP_DIR/$a"
    shred -u "$BACKUP_DIR/$a" 2>/dev/null || rm -f "$BACKUP_DIR/$a"
    encrypted+=("$a.gpg")
  done
  artifacts=("${encrypted[@]}")
  echo "[backup] encrypted with AES-256 (gpg symmetric)"
fi

( cd "$BACKUP_DIR" && sha256sum "${artifacts[@]}" > "manifest-$ts.sha256" )

find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'db-*' -o -name 'files-*' -o -name 'manifest-*' \) -mtime +"$KEEP_DAYS" -print -delete | sed 's/^/[backup] pruned /'
for a in "${artifacts[@]}"; do printf '[backup] wrote %s (%s)\n' "$BACKUP_DIR/$a" "$(du -h "$BACKUP_DIR/$a" | cut -f1)"; done
echo "[backup] done $ts"
