#!/usr/bin/env bash
# Prueft alle Dienste mit ECHTEN Abfragen (nicht nur "Container laeuft").
# Aufruf:  ./healthcheck.sh [--wait SEKUNDEN] [--quiet]     Exit-Code 0 = alles in Ordnung
set -uo pipefail
source "$(dirname "$0")/scripts/lib.sh"

WAIT=0; QUIET=0
while [ $# -gt 0 ]; do case "$1" in --wait) WAIT="${2:-60}"; shift 2 ;; --quiet) QUIET=1; shift ;; *) die "Unbekannte Option: $1" ;; esac; done
require_docker
check_env_complete

check_once() {
  local bad=0
  say() { [ "$QUIET" = 1 ] || echo "$*"; }
  res() { if [ "$1" = 0 ]; then say "  ${C_OK}OK${C_0}      $2"; else say "  ${C_ERR}FEHLER${C_0}  $2"; bad=1; fi; }

  local db_user db_name; db_user="$(env_get POSTGRES_USER)"; db_name="$(env_get POSTGRES_DB)"
  dc exec -T db pg_isready -U "${db_user:-mosi}" -d "${db_name:-mosi}" >/dev/null 2>&1; res $? "Datenbank (pg_isready)"
  dc exec -T db psql -U "${db_user:-mosi}" -d "${db_name:-mosi}" -tAc "SELECT count(*) FROM extensions" >/dev/null 2>&1; res $? "Datenbank-Schema vorhanden (Tabelle extensions)"
  dc exec -T asterisk asterisk -rx "core show uptime" >/dev/null 2>&1; res $? "Telefonie-Engine (Asterisk antwortet auf Konsolenbefehl)"
  dc exec -T asterisk asterisk -rx "pjsip show transports" 2>/dev/null | grep -q "Transport:"; res $? "SIP-Transporte geladen (UDP/TCP/WS)"
  dc exec -T app node -e "fetch('http://127.0.0.1:3000/api/health').then(async r=>{const j=await r.json();console.log(JSON.stringify(j));process.exit(r.ok&&j.ok?0:1)}).catch(()=>process.exit(1))" >/dev/null 2>&1; res $? "Backend-API (Datenbank und Verbindung zu Asterisk)"
  local port ip name; port="$(env_get HTTPS_PORT)"; ip="$(env_get HOST_IP)"; name="$(env_get MOSI_HOSTNAME)"; name="${name:-$ip}"
  # Das Zertifikat der lokalen CA ist dem Skript unbekannt -> -k; geprueft wird Erreichbarkeit, Proxy-Weg und Backend.
  # --resolve: Host-Header/SNI = MOSI_HOSTNAME (so wie Browser zugreifen), Verbindung zur HOST_IP.
  curl -ks --noproxy '*' --max-time 8 --resolve "${name}:${port:-443}:${ip}" "https://${name}:${port:-443}/api/health" 2>/dev/null | grep -q '"ok":true'; res $? "HTTPS-Reverse-Proxy -> Backend ueber https://${name}:${port:-443}"
  return $bad
}

[ "$QUIET" = 1 ] || info "Gesundheitspruefung"
end=$(( $(date +%s) + WAIT ))
while :; do
  if check_once; then [ "$QUIET" = 1 ] || echo "${C_OK}Alle Pruefungen bestanden.${C_0}"; exit 0; fi
  [ "$(date +%s)" -ge "$end" ] && break
  [ "$QUIET" = 1 ] || echo "  ... warte auf Dienste"; sleep 5
done
[ "$QUIET" = 1 ] || echo "${C_ERR}Mindestens eine Pruefung ist fehlgeschlagen.${C_0} Logs: docker compose logs --tail=100"
exit 1
