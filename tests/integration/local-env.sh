#!/bin/bash
# Startet eine komplett lokale Testumgebung OHNE Docker: echtes Asterisk + PostgreSQL + Backend.
# Voraussetzung (Debian/Ubuntu, root): asterisk, asterisk-modules, postgresql, nodejs>=22.
# Verwendung:  tests/integration/local-env.sh up|down
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
W="${MOSI_TEST_DIR:-/tmp/mosi-it}"
PGPORT="${MOSI_TEST_PGPORT:-5432}"
export SIP_PORT=15060 HTTP_PORT=13000

env_vars() {
  export HOST_IP=127.0.0.1 AMI_SECRET=testami-secret-0123456789 AMI_PERMIT=127.0.0.1/255.255.255.255 \
    DOCKER_SUBNET=127.0.0.0/8 ASTERISK_IP=127.0.0.1 SIP_ALLOWED_NETS=127.0.0.0/8 RTP_START=20000 RTP_END=20099 \
    AST_ETC="$W/etc" AST_LIB="$W/lib" AST_SPOOL="$W/spool" AST_RUN="$W/run" AST_LOG="$W/log" AST_CACHE="$W/cache" \
    AST_TEMPLATES="$ROOT/telephony/templates" SOUNDS_DIR="$W/sounds" TZ=Europe/Berlin
}

case "${1:-}" in
up)
  "$0" down >/dev/null 2>&1 || true
  rm -rf "$W"; mkdir -p "$W"/{etc/mosi,lib,spool/voicemail,run,log,cache,sounds}
  env_vars
  pg_ctlcluster 16 main start 2>/dev/null || true
  for i in $(seq 1 20); do pg_isready -q && break; sleep 1; done
  su postgres -c "psql -qc \"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='mosi_it'\"" >/dev/null 2>&1 || true
  su postgres -c "psql -qc \"DROP DATABASE IF EXISTS mosi_it\"" && su postgres -c "psql -qc \"DROP ROLE IF EXISTS mosi_it\""
  su postgres -c "psql -qc \"CREATE ROLE mosi_it LOGIN PASSWORD 'mosi_it'\"" && su postgres -c "psql -qc \"CREATE DATABASE mosi_it OWNER mosi_it\""
  MOSI_RENDER_ONLY=1 sh "$ROOT/telephony/entrypoint.sh" true
  nohup asterisk -C "$W/etc/asterisk.conf" -f -U root -G root > "$W/asterisk.out" 2>&1 < /dev/null &
  echo $! > "$W/asterisk.pid"
  for i in $(seq 1 30); do grep -q "Asterisk Ready" "$W/asterisk.out" 2>/dev/null && break; sleep 1; done
  grep -q "Asterisk Ready" "$W/asterisk.out" || { echo "Asterisk startet nicht:"; tail -20 "$W/asterisk.out"; exit 1; }
  (cd "$ROOT/backend" && DATABASE_URL="postgres://mosi_it:mosi_it@127.0.0.1:$PGPORT/mosi_it" APP_SECRET=test-secret-test-secret-test-secret \
     ASTERISK_HOST=127.0.0.1 AMI_PORT=5038 SIP_PORT=$SIP_PORT PORT=$HTTP_PORT SECURE_COOKIES=false TRUST_PROXY=false \
     ADMIN_PASSWORD='Test-Admin-Passw0rt!' ASTERISK_GENERATED_DIR="$W/etc/mosi" ASTERISK_LOG_DIR="$W/log" \
     FRONTEND_DIR="$ROOT/frontend" VOICEMAIL_DIR="$W/spool/voicemail" SOUNDS_DIR="$W/sounds" MOSI_HOSTNAME=127.0.0.1 \
     nohup node src/index.js > "$W/backend.out" 2>&1 < /dev/null & echo $! > "$W/backend.pid")
  for i in $(seq 1 30); do curl -sf "http://127.0.0.1:$HTTP_PORT/api/health" >/dev/null && break; sleep 1; done
  curl -s "http://127.0.0.1:$HTTP_PORT/api/health"; echo
  ;;
down)
  for f in backend asterisk; do
    if [ -f "$W/$f.pid" ]; then
      p="$(cat "$W/$f.pid")"; kill "$p" 2>/dev/null || true
      for i in 1 2 3 4 5; do kill -0 "$p" 2>/dev/null || break; sleep 1; done
      kill -9 "$p" 2>/dev/null || true
    fi
  done
  pkill -x asterisk 2>/dev/null || true
  fuser -k "$HTTP_PORT/tcp" >/dev/null 2>&1 || true
  sleep 1
  ;;
restart-asterisk)
  env_vars
  kill "$(cat "$W/asterisk.pid")" 2>/dev/null || true; pkill -x asterisk 2>/dev/null || true; sleep 2
  nohup asterisk -C "$W/etc/asterisk.conf" -f -U root -G root > "$W/asterisk.out" 2>&1 < /dev/null &
  echo $! > "$W/asterisk.pid"
  ;;
*) echo "Verwendung: $0 up|down|restart-asterisk"; exit 2 ;;
esac
