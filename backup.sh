#!/usr/bin/env bash
# Sichert Datenbank, Telefoniekonfiguration, Voicemail, Ansagen, Zertifikats-CA und .env in EINE Datei.
# Aufruf:  ./backup.sh [Zielverzeichnis]      (Standard: ./backups)
# ACHTUNG: Das Archiv enthaelt Geheimnisse (.env, Zugangsdaten). Sicher aufbewahren (Rechte 600).
set -euo pipefail
source "$(dirname "$0")/scripts/lib.sh"
require_docker; check_env_complete

DEST="${1:-$ROOT/backups}"; mkdir -p "$DEST"; chmod 700 "$DEST"
STAMP="$(date +%Y%m%d-%H%M%S)"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
OUT="$DEST/mosi-backup-$STAMP.tar.gz"

dc ps --status running --services | grep -qx db || die "Die Datenbank laeuft nicht - Backup nicht moeglich. Starten Sie zuerst: docker compose up -d"

info "Datenbank sichern (pg_dump)"
dc exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > "$WORK/db.dump"
[ -s "$WORK/db.dump" ] || die "pg_dump hat keine Daten geliefert."
ok "db.dump ($(du -h "$WORK/db.dump" | cut -f1))"

info "Telefoniekonfiguration, Voicemail und Ansagen sichern"
APP_IMAGE="$(dc images app --format '{{.Repository}}:{{.Tag}}' 2>/dev/null | head -n1)"; APP_IMAGE="${APP_IMAGE:-mosi/app:1.0.0}"
PROJECT="$(dc config --format json 2>/dev/null | sed -n 's/.*"name": *"\([^"]*\)".*/\1/p' | head -n1)"; PROJECT="${PROJECT:-mosi}"
vol_tar() { # vol_tar <volume-suffix> <outfile>
  docker run --rm --user root -v "${PROJECT}_$1:/data:ro" --entrypoint tar "$APP_IMAGE" -C /data -cf - . > "$2"
}
vol_tar asterisk_generated "$WORK/asterisk_generated.tar"
vol_tar voicemail "$WORK/voicemail.tar"
vol_tar sounds "$WORK/sounds.tar"
vol_tar caddy_data "$WORK/caddy_data.tar"
cp .env "$WORK/env.backup"
[ -d certs ] && tar -cf "$WORK/certs.tar" certs 2>/dev/null || true
ok "Volumes gesichert"

cat > "$WORK/MANIFEST" <<M
mosi-backup 1
created=$(date -Is)
version=$(grep -m1 '"version"' backend/package.json | sed 's/[^0-9.]//g')
host=$(hostname)
M
( cd "$WORK" && sha256sum * > SHA256SUMS )
umask 077
tar -C "$WORK" -czf "$OUT" .
chmod 600 "$OUT"
ok "Backup erstellt: $OUT ($(du -h "$OUT" | cut -f1))"
echo "Wiederherstellung: ./restore.sh \"$OUT\""
# Alte Backups: nichts wird automatisch geloescht. Aufbewahrung siehe docs/operations.md.
