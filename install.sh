#!/usr/bin/env bash
# Mosi Cloud PBX - Installation (in einer VM oder einem LXC-Container, NICHT auf dem Proxmox-Host)
#
# Was dieses Skript tut (und nur das):
#   1. Umgebung pruefen (kein Proxmox-Host, Docker + Compose vorhanden, Ports frei, curl/openssl)
#   2. .env aus .env.example erzeugen und starke Zufallsgeheimnisse einsetzen (nur wenn .env fehlt)
#   3. Images bauen bzw. herunterladen, Dienste starten
#   4. Gesundheit von Datenbank, Telefonie-Engine, API und HTTPS-Proxy pruefen
#   5. Adresse und naechste Schritte anzeigen
# Es werden keine Fremdskripte ausgefuehrt. Mit --install-docker richtet es (nur Debian/Ubuntu, nur nach
# ausdruecklicher Aufforderung) Docker aus dem offiziellen Docker-APT-Repository ein - Schritte siehe unten.
#
# Optionen:  --host-ip IP   --hostname NAME   --install-docker   --yes   --no-start   --skip-build   --help
#   --skip-build  ueberspringt das Bauen der Images (z. B. Offline-Installation mit vorab geladenen/gebauten Images)
set -euo pipefail
source "$(dirname "$0")/scripts/lib.sh"

HOST_IP_OPT=""; HOSTNAME_OPT=""; INSTALL_DOCKER=0; NO_START=0; ASSUME_YES=0; SKIP_BUILD=0
while [ $# -gt 0 ]; do
  case "$1" in
    --host-ip) HOST_IP_OPT="${2:?}"; shift 2 ;;
    --hostname) HOSTNAME_OPT="${2:?}"; shift 2 ;;
    --install-docker) INSTALL_DOCKER=1; shift ;;
    --yes|-y) ASSUME_YES=1; shift ;;
    --no-start) NO_START=1; shift ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    --help|-h) sed -n '2,18p' "$0"; exit 0 ;;
    *) die "Unbekannte Option: $1 (siehe --help)" ;;
  esac
done
export ASSUME_YES

install_docker() {
  [ "$(id -u)" = 0 ] || die "--install-docker benoetigt root."
  . /etc/os-release
  case "${ID:-}" in debian|ubuntu) ;; *) die "--install-docker unterstuetzt nur Debian/Ubuntu. Installieren Sie Docker laut https://docs.docker.com/engine/install/ manuell." ;; esac
  info "Docker aus dem offiziellen Docker-APT-Repository installieren (https://docs.docker.com/engine/install/${ID}/)"
  confirm "Folgende Pakete werden installiert: ca-certificates curl docker-ce docker-ce-cli containerd.io docker-compose-plugin. Fortfahren?" || die "Abgebrochen."
  apt-get update
  apt-get install -y ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL "https://download.docker.com/linux/${ID}/gpg" -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/${ID} ${VERSION_CODENAME} stable" > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
  systemctl enable --now docker
}

info "1/5 Umgebung pruefen"
refuse_proxmox_host
VIRT="$(systemd-detect-virt 2>/dev/null || true)"; CONT="$(systemd-detect-virt -c 2>/dev/null || true)"
case "$CONT" in
  lxc|lxc-libvirt) ok "Laeuft in einem LXC-Container. Docker benoetigt dort 'nesting=1' (und meist 'keyctl=1'); siehe docs/proxmox.md"; IN_LXC=1 ;;
  none|"") [ -n "$VIRT" ] && [ "$VIRT" != none ] && ok "Laeuft in einer virtuellen Maschine ($VIRT)" || warn "Keine Virtualisierung erkannt - laeuft dies auf physischer Hardware? Pruefen Sie, dass es NICHT der Proxmox-Host ist."; IN_LXC=0 ;;
  *) ok "Container-Umgebung: $CONT"; IN_LXC=0 ;;
esac
for t in curl openssl; do command -v "$t" >/dev/null 2>&1 || die "'$t' fehlt. Installieren Sie es (Debian/Ubuntu: apt install $t) und starten Sie die Installation erneut."; done
if ! command -v docker >/dev/null 2>&1; then
  if [ "$INSTALL_DOCKER" = 1 ]; then install_docker; else die "Docker ist nicht installiert. Entweder laut https://docs.docker.com/engine/install/ installieren oder dieses Skript mit --install-docker starten."; fi
fi
require_docker
ok "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null) mit Compose $(docker compose version --short 2>/dev/null)"
if [ "${IN_LXC:-0}" = 1 ]; then
  if ! docker info 2>/dev/null | grep -q "Cgroup Version"; then warn "Cgroup-Informationen von Docker fehlen - in LXC ggf. 'nesting=1' setzen."; fi
fi
free_mb=$(df -Pm "$ROOT" | awk 'NR==2{print $4}')
[ "${free_mb:-0}" -ge 3000 ] || die "Zu wenig freier Speicher (${free_mb} MB frei, mindestens 3000 MB empfohlen)."
ok "Freier Speicher: ${free_mb} MB"

# Ports pruefen (nur wenn noch kein Mosi laeuft)
port_in_use() { ss -H -ltn "sport = :$1" 2>/dev/null | grep -q . || ss -H -lun "sport = :$1" 2>/dev/null | grep -q .; }
if ! dc ps -q 2>/dev/null | grep -q .; then
  for p in 443 80 5060; do
    if command -v ss >/dev/null 2>&1 && port_in_use "$p"; then die "Port $p ist bereits belegt. Beenden Sie den anderen Dienst oder aendern Sie HTTPS_PORT/HTTP_PORT/SIP_PORT in der .env."; fi
  done
  ok "Ports 443, 80 und 5060 sind frei"
fi

info "2/5 Konfiguration (.env)"
detect_ip() {
  local a
  a="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}')" || true
  [ -n "$a" ] || a="$(hostname -I 2>/dev/null | awk '{print $1}')" || true
  echo "$a"
}
FRESH_ADMIN_PW=""
if [ -f .env ]; then
  ok ".env existiert bereits und wird nicht veraendert"
else
  HOST_IP_VAL="${HOST_IP_OPT:-$(detect_ip)}"
  [ -n "$HOST_IP_VAL" ] || die "Die LAN-Adresse konnte nicht ermittelt werden. Geben Sie sie mit --host-ip an."
  [[ "$HOST_IP_VAL" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || die "Ungueltige IP-Adresse: $HOST_IP_VAL"
  HOSTNAME_VAL="${HOSTNAME_OPT:-$HOST_IP_VAL}"
  [[ "$HOSTNAME_VAL" =~ ^[A-Za-z0-9.-]+$ ]] || die "Ungueltiger Hostname: $HOSTNAME_VAL"
  case "$HOST_IP_VAL" in
    10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[0-1].*) ;;
    *) warn "HOST_IP ${HOST_IP_VAL} liegt nicht in einem privaten Adressbereich. SIP_ALLOWED_NETS und ADMIN_ALLOWED_NETS in der .env erlauben standardmaessig NUR private Netze - tragen Sie Ihr Netz dort ein, sonst koennen sich Geraete nicht registrieren." ;;
  esac
  rnd() { openssl rand -base64 192 | tr -d '\n' | tr -dc 'A-Za-z0-9' | cut -c1-"$1"; }
  FRESH_ADMIN_PW="$(rnd 20)A9!"
  umask 077
  sed -e "s|^HOST_IP=.*|HOST_IP=${HOST_IP_VAL}|" \
      -e "s|^MOSI_HOSTNAME=.*|MOSI_HOSTNAME=${HOSTNAME_VAL}|" \
      -e "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(rnd 32)|" \
      -e "s|^APP_SECRET=.*|APP_SECRET=$(rnd 64)|" \
      -e "s|^AMI_SECRET=.*|AMI_SECRET=$(rnd 32)|" \
      -e "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=${FRESH_ADMIN_PW}|" .env.example > .env
  chmod 600 .env
  ok ".env erzeugt (Rechte 600) mit HOST_IP=${HOST_IP_VAL} und neuen Zufallsgeheimnissen"
fi
check_env_complete
dc config -q || die "Die Compose-Konfiguration ist ungueltig (siehe Meldung oben)."
ok "Compose-Konfiguration ist gueltig"
if [ "$(env_get SIP_TLS_ENABLED)" = "true" ]; then
  [ -r certs/sip-cert.pem ] && [ -r certs/sip-key.pem ] || die "SIP_TLS_ENABLED=true, aber certs/sip-cert.pem bzw. certs/sip-key.pem fehlen."
fi
mkdir -p certs

[ "$NO_START" = 1 ] && { info "--no-start: Installation hier beendet."; exit 0; }

info "3/5 Images bauen/herunterladen und Dienste starten (beim ersten Mal einige Minuten)"
[ "$SKIP_BUILD" = 1 ] || dc build || die "Der Build ist fehlgeschlagen. Haeufige Ursachen: kein Internetzugang (Paketquellen deb.debian.org, registry.npmjs.org, Docker Hub) oder DNS-Probleme im Container."
dc pull --ignore-buildable --quiet || die "Herunterladen der Images fehlgeschlagen (Docker Hub erreichbar? Rate-Limit?)."
dc up -d || die "Start fehlgeschlagen. In LXC: 'nesting=1' aktiv? Siehe 'docker compose logs'."

info "4/5 Gesundheitspruefung (bis zu 3 Minuten)"
if ! ./healthcheck.sh --wait 180; then
  echo; dc ps; die "Die Installation ist nicht gesund. Logs: docker compose logs --tail=100   Hilfe: docs/troubleshooting.md"
fi

info "5/5 Fertig"
PORT_VAL="$(env_get HTTPS_PORT)"; PORT_SUFFIX=""
if [ -n "$PORT_VAL" ] && [ "$PORT_VAL" != "443" ]; then PORT_SUFFIX=":$PORT_VAL"; fi
URL="https://$(env_get MOSI_HOSTNAME)${PORT_SUFFIX}"
echo
echo "${C_B}Mosi Cloud PBX laeuft.${C_0}"
echo "  Dashboard:   ${URL}   (nur aus dem lokalen Netz; Browser-Zertifikatswarnung beim ersten Aufruf: siehe docs/network.md)"
if [ -n "$FRESH_ADMIN_PW" ]; then
  echo "  Benutzer:    $(env_get ADMIN_USER)"
  echo "  Passwort:    ${FRESH_ADMIN_PW}   <- wird nur jetzt angezeigt (steht auch in .env; nach dem ersten Login dort entfernen)"
else
  echo "  Anmeldung:   mit dem bereits angelegten Administrator (bei Verlust siehe docs/troubleshooting.md)"
fi
echo
echo "Naechste Schritte:"
echo "  1. Im Dashboard anmelden und das Passwort aendern."
echo "  2. Nebenstellen anlegen -> Verbindungsdaten in Telefon/App eintragen (docs/phones.md)."
echo "  3. Optional: SIP-Trunk eines Anbieters einrichten (docs/trunk.md) - ohne Trunk sind nur interne Gespraeche moeglich."
echo "  4. Firewall/Netzwerk pruefen (docs/network.md) und ein erstes Backup anlegen: ./backup.sh"
