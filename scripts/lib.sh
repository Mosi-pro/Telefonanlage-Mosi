#!/usr/bin/env bash
# Gemeinsame Hilfsfunktionen fuer install.sh, update.sh, backup.sh, restore.sh, uninstall.sh, healthcheck.sh
# (wird nur per "source" eingebunden)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -t 1 ]; then C_OK=$'\033[32m'; C_ERR=$'\033[31m'; C_WARN=$'\033[33m'; C_B=$'\033[1m'; C_0=$'\033[0m'; else C_OK=; C_ERR=; C_WARN=; C_B=; C_0=; fi
info() { echo "${C_B}==>${C_0} $*"; }
ok()   { echo "  ${C_OK}OK${C_0}     $*"; }
warn() { echo "  ${C_WARN}HINWEIS${C_0} $*" >&2; }
fail() { echo "  ${C_ERR}FEHLER${C_0}  $*" >&2; }
die()  { fail "$*"; exit 1; }

# Wert aus .env lesen (ohne die Datei zu "sourcen" - kein Code wird ausgefuehrt)
env_get() { [ -f "$ROOT/.env" ] && grep -E "^$1=" "$ROOT/.env" | tail -n1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//' || true; }

# docker compose mit den passenden Dateien
dc() {
  local files=(-f compose.yaml)
  [ "$(env_get SIP_TLS_ENABLED)" = "true" ] && files+=(-f compose.tls.yaml)
  docker compose "${files[@]}" "$@"
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "Docker ist nicht installiert. Siehe README (Abschnitt Voraussetzungen) oder: ./install.sh --install-docker"
  docker compose version >/dev/null 2>&1 || die "Das Docker-Compose-Plugin (Version 2) fehlt."
  docker info >/dev/null 2>&1 || die "Der Docker-Dienst ist nicht erreichbar. Laeuft der Daemon? Haben Sie Berechtigung (root oder Gruppe 'docker')?"
}

# Dieses Projekt darf nie auf dem Proxmox-Host selbst laufen.
refuse_proxmox_host() {
  if command -v pveversion >/dev/null 2>&1 || [ -d /etc/pve ]; then
    die "Dies scheint der Proxmox-VE-HOST zu sein. Mosi darf NICHT auf dem Host installiert werden, sondern in einer VM oder einem LXC-Container (siehe docs/proxmox.md)."
  fi
}

confirm() { # confirm "Frage" -> 0 bei ja; mit ASSUME_YES=1 immer ja
  [ "${ASSUME_YES:-0}" = "1" ] && return 0
  local a; read -r -p "$1 [ja/NEIN] " a; [ "$a" = "ja" ] || [ "$a" = "j" ] || [ "$a" = "JA" ]
}

check_env_complete() {
  [ -f "$ROOT/.env" ] || die ".env fehlt. Fuehren Sie zuerst ./install.sh aus."
  local missing=() k
  for k in HOST_IP POSTGRES_PASSWORD APP_SECRET AMI_SECRET; do
    [ -n "$(env_get "$k")" ] || missing+=("$k")
  done
  [ ${#missing[@]} -eq 0 ] || die ".env ist unvollstaendig, es fehlen Werte fuer: ${missing[*]} (Vorlage: .env.example)"
}
