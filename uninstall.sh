#!/usr/bin/env bash
# Entfernt Mosi. Standard: Dienste und Container stoppen/entfernen, DATEN BLEIBEN erhalten (Volumes, .env, backups).
# Aufruf:  ./uninstall.sh [--purge] [--yes]
#   --purge  loescht zusaetzlich ALLE Daten (Datenbank, Voicemail, Konfiguration, Zertifikats-CA) und die selbst gebauten Images.
#            Die Datei .env und backups/ bleiben als Sicherheitsnetz liegen und muessen von Hand geloescht werden.
set -euo pipefail
source "$(dirname "$0")/scripts/lib.sh"
PURGE=0; ASSUME_YES=0
for a in "$@"; do case "$a" in --purge) PURGE=1 ;; --yes|-y) ASSUME_YES=1 ;; *) die "Unbekannte Option: $a" ;; esac; done
export ASSUME_YES
refuse_proxmox_host; require_docker

if [ "$PURGE" = 0 ]; then
  confirm "Alle Mosi-Dienste stoppen und die Container entfernen (Daten bleiben erhalten)?" || die "Abgebrochen."
  dc down
  ok "Dienste entfernt. Daten (Docker-Volumes), .env und backups/ sind erhalten. Neu starten: ./install.sh"
  exit 0
fi

echo "${C_ERR}ACHTUNG: --purge loescht unwiderruflich Datenbank, Rufnummern-/Nebenstellenkonfiguration, Voicemail und Ansagen.${C_0}"
if dc ps --status running --services 2>/dev/null | grep -qx db && confirm "Zuerst ein Backup erstellen (empfohlen)?"; then ./backup.sh; fi
if [ "${ASSUME_YES:-0}" != 1 ]; then
  read -r -p "Zur Bestaetigung bitte LOESCHEN eintippen: " a; [ "$a" = "LOESCHEN" ] || die "Abgebrochen."
fi
dc down --volumes --rmi local
ok "Dienste, Volumes und lokal gebaute Images wurden entfernt."
echo "Uebrig geblieben (bei Bedarf von Hand loeschen): .env (Geheimnisse), backups/, certs/, dieses Repository."
