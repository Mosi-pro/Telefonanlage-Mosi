#!/usr/bin/env bash
# Stellt ein mit backup.sh erzeugtes Archiv wieder her. ERSETZT Datenbank und Telefoniekonfiguration.
# Aufruf:  ./restore.sh <backup.tar.gz> [--with-env] [--yes]
#   --with-env   ueberschreibt auch die aktuelle .env (noetig auf einem neuen Server, damit die Geheimnisse zu den Daten passen)
set -euo pipefail
source "$(dirname "$0")/scripts/lib.sh"
FILE=""; WITH_ENV=0; ASSUME_YES=0
for a in "$@"; do case "$a" in --with-env) WITH_ENV=1 ;; --yes|-y) ASSUME_YES=1 ;; -*) die "Unbekannte Option: $a" ;; *) FILE="$a" ;; esac; done
[ -n "$FILE" ] && [ -f "$FILE" ] || die "Aufruf: ./restore.sh <backup.tar.gz> [--with-env] [--yes]"
export ASSUME_YES
require_docker

WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
tar -xzf "$FILE" -C "$WORK" || die "Archiv nicht lesbar."
( cd "$WORK" && sha256sum -c SHA256SUMS --quiet ) || die "Pruefsummen stimmen nicht - das Backup ist beschaedigt. Es wird nichts veraendert."
grep -q '^mosi-backup 1' "$WORK/MANIFEST" || die "Unbekanntes Backup-Format."
ok "Archiv ist unversehrt ($(grep '^created=' "$WORK/MANIFEST"))"

if [ "$WITH_ENV" = 1 ]; then cp "$WORK/env.backup" .env && chmod 600 .env && ok ".env aus dem Backup uebernommen"; fi
check_env_complete
if ! cmp -s "$WORK/env.backup" .env && [ "$WITH_ENV" = 0 ]; then
  warn "Die aktuelle .env weicht von der im Backup ab. Auf einem NEUEN Server muss --with-env verwendet werden, sonst passen Geheimnisse (z. B. APP_SECRET) nicht zu den gespeicherten SIP-Passwoertern."
fi

echo "${C_WARN}Dies ersetzt die aktuelle Datenbank, Telefoniekonfiguration, Voicemail und Ansagen durch den Stand vom Backup.${C_0}"
confirm "Wiederherstellung wirklich durchfuehren?" || die "Abgebrochen. Es wurde nichts veraendert."

info "Sicherheitskopie des aktuellen Stands"
if dc ps --status running --services | grep -qx db; then ./backup.sh "$ROOT/backups/pre-restore" || warn "Sicherheitskopie fehlgeschlagen"; fi

info "Dienste anhalten (Datenbank bleibt)"
dc up -d db >/dev/null
dc stop proxy app asterisk >/dev/null 2>&1 || true
for _ in $(seq 1 30); do dc exec -T db pg_isready -q >/dev/null 2>&1 && break; sleep 1; done

info "Datenbank wiederherstellen"
DBU="$(env_get POSTGRES_USER)"; DBN="$(env_get POSTGRES_DB)"
dc exec -T db psql -U "${DBU:-mosi}" -d postgres -qc "DROP DATABASE IF EXISTS \"${DBN:-mosi}\" WITH (FORCE)" >/dev/null
dc exec -T db psql -U "${DBU:-mosi}" -d postgres -qc "CREATE DATABASE \"${DBN:-mosi}\" OWNER \"${DBU:-mosi}\"" >/dev/null
dc exec -T db pg_restore -U "${DBU:-mosi}" -d "${DBN:-mosi}" --no-owner --exit-on-error < "$WORK/db.dump" || die "pg_restore ist fehlgeschlagen. Die Sicherheitskopie liegt in backups/pre-restore."
ok "Datenbank wiederhergestellt"

info "Volumes wiederherstellen"
APP_IMAGE="$(dc config --images | grep '^mosi/app:' | head -n1)"; APP_IMAGE="${APP_IMAGE:-mosi/app:1.0.0}"
PROJECT="${COMPOSE_PROJECT_NAME:-mosi}"   # entspricht "name:" in compose.yaml
vol_untar() { # vol_untar <volume-suffix> <tarfile> <owner uid:gid oder leer>
  docker volume create "${PROJECT}_$1" >/dev/null
  docker run --rm --user root -i -v "${PROJECT}_$1:/data" --entrypoint sh "$APP_IMAGE" -c 'find /data -mindepth 1 -delete && tar -C /data -xf - && if [ -n "$0" ]; then chown -R "$0" /data; fi' "$3" < "$2"
}
vol_untar asterisk_generated "$WORK/asterisk_generated.tar" 10001:10001
vol_untar voicemail "$WORK/voicemail.tar" 10001:10001
vol_untar sounds "$WORK/sounds.tar" 10001:10001
vol_untar caddy_data "$WORK/caddy_data.tar" ""
[ -f "$WORK/certs.tar" ] && [ "$WITH_ENV" = 1 ] && [ ! -e certs/sip-key.pem ] && tar -xf "$WORK/certs.tar" && ok "certs/ wiederhergestellt"
ok "Volumes wiederhergestellt"

info "Dienste starten und pruefen"
dc up -d
./healthcheck.sh --wait 150 || die "Nach der Wiederherstellung sind nicht alle Pruefungen bestanden. Logs: docker compose logs --tail=100"
ok "Wiederherstellung abgeschlossen."
