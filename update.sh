#!/usr/bin/env bash
# Geordnetes Update: Backup -> neuen Stand holen -> Images neu bauen -> Dienste ersetzen -> pruefen.
# Persistente Daten (Volumes) werden NIE geloescht. Aufruf:  ./update.sh [--yes] [--no-git] [--skip-build]
set -euo pipefail
source "$(dirname "$0")/scripts/lib.sh"
ASSUME_YES=0; NO_GIT=0; SKIP_BUILD=0
for a in "$@"; do case "$a" in --yes|-y) ASSUME_YES=1 ;; --no-git) NO_GIT=1 ;; --skip-build) SKIP_BUILD=1 ;; *) die "Unbekannte Option: $a" ;; esac; done
export ASSUME_YES
refuse_proxmox_host; require_docker; check_env_complete

info "1/5 Aktuellen Stand pruefen"
./healthcheck.sh --quiet || warn "Das System ist vor dem Update bereits nicht vollstaendig gesund."
if [ "$NO_GIT" = 0 ] && [ -d .git ]; then
  git fetch --quiet origin
  LOCAL="$(git rev-parse HEAD)"; REMOTE="$(git rev-parse '@{u}' 2>/dev/null || echo "$LOCAL")"
  if [ "$LOCAL" = "$REMOTE" ]; then ok "Das Repository ist bereits aktuell"; else
    echo "Neue Aenderungen:"; git --no-pager log --oneline "$LOCAL..$REMOTE" | head -20
  fi
fi
confirm "Update jetzt durchfuehren? (vorher wird automatisch ein Backup erstellt)" || die "Abgebrochen."

info "2/5 Backup vor dem Update"
./backup.sh "$ROOT/backups/pre-update" || die "Backup fehlgeschlagen - Update abgebrochen, es wurde nichts veraendert."
LATEST="$(ls -1t "$ROOT"/backups/pre-update/mosi-backup-*.tar.gz | head -n1)"

info "3/5 Neuen Stand holen"
if [ "$NO_GIT" = 0 ] && [ -d .git ]; then git pull --ff-only || die "git pull ist nicht fuer einen reinen Fast-Forward moeglich (lokale Aenderungen?). Update abgebrochen."; fi
dc config -q || die "Neue Compose-Konfiguration ist ungueltig."

info "4/5 Images bauen und Dienste ersetzen"
[ "$SKIP_BUILD" = 1 ] || dc build --pull || die "Build fehlgeschlagen. Der laufende Stand bleibt unveraendert aktiv."
dc pull --ignore-buildable
dc up -d --remove-orphans

info "5/5 Gesundheitspruefung"
if ./healthcheck.sh --wait 180; then ok "Update erfolgreich."; else
  fail "Nach dem Update ist das System nicht gesund."
  echo "Rueckweg: 1) git checkout <vorherige Version>  2) docker compose up -d --build  3) bei Datenproblemen: ./restore.sh \"$LATEST\""
  exit 1
fi
