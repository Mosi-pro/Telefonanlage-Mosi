#!/bin/sh
# Rendert die statischen Basiskonfigurationen aus Templates + Umgebungsvariablen
# und startet Asterisk. Die dynamische Konfiguration (Nebenstellen, Trunks,
# Dialplan) liefert das Backend in /etc/asterisk/mosi/ (Volume).
set -eu

: "${HOST_IP:?HOST_IP muss gesetzt sein (siehe .env)}"
: "${AMI_SECRET:?AMI_SECRET muss gesetzt sein (siehe .env)}"
export SIP_PORT="${SIP_PORT:-5060}"
export SIP_TLS_PORT="${SIP_TLS_PORT:-5061}"
export RTP_START="${RTP_START:-10000}"
export RTP_END="${RTP_END:-10099}"
export DOCKER_SUBNET="${DOCKER_SUBNET:-172.29.0.0/24}"
export SIP_ALLOWED_NETS="${SIP_ALLOWED_NETS:-192.168.0.0/16,10.0.0.0/8,172.16.0.0/12}"
export AMI_PERMIT="${AMI_PERMIT:-$DOCKER_SUBNET}"
export TZ="${TZ:-Europe/Berlin}"
export SIP_TLS_ENABLED="${SIP_TLS_ENABLED:-false}"

# Pfade sind fuer lokale Tests ueberschreibbar (tests/integration/local-env.sh)
D="${AST_ETC:-/etc/asterisk}"
T="${AST_TEMPLATES:-$D/templates}"
export AST_ETC="$D" AST_LIB="${AST_LIB:-/var/lib/asterisk}" AST_SPOOL="${AST_SPOOL:-/var/spool/asterisk}" \
       AST_RUN="${AST_RUN:-/var/run/asterisk}" AST_LOG="${AST_LOG:-/var/log/asterisk}" AST_CACHE="${AST_CACHE:-/var/cache/asterisk}"

# Mehrwertige Optionen als Konfigurationszeilen
SIP_ACL_LINES=""
OLDIFS="$IFS"; IFS=','
for n in $SIP_ALLOWED_NETS; do SIP_ACL_LINES="${SIP_ACL_LINES}permit=${n}
"; done
IFS="$OLDIFS"
export SIP_ACL_LINES

TLS_TRANSPORT=""
if [ "$SIP_TLS_ENABLED" = "true" ]; then
  if [ -r /certs/sip-cert.pem ] && [ -r /certs/sip-key.pem ]; then
    TLS_TRANSPORT="[transport-tls]
type=transport
protocol=tls
bind=0.0.0.0:${SIP_TLS_PORT}
cert_file=/certs/sip-cert.pem
priv_key_file=/certs/sip-key.pem
method=tlsv1_2
external_media_address=${HOST_IP}
external_signaling_address=${HOST_IP}
local_net=${DOCKER_SUBNET}
"
  else
    echo "WARNUNG: SIP_TLS_ENABLED=true, aber /certs/sip-cert.pem bzw. sip-key.pem fehlen - TLS-Transport wird NICHT aktiviert." >&2
  fi
fi
export TLS_TRANSPORT

# nur diese Variablen ersetzen - Dialplan-Ausdruecke wie ${EXTEN} bleiben unberuehrt
export ASTERISK_IP="${ASTERISK_IP:-172.29.0.10}"
VARS='${AST_ETC} ${AST_LIB} ${AST_SPOOL} ${AST_RUN} ${AST_LOG} ${AST_CACHE} ${HOST_IP} ${AMI_SECRET} ${AMI_PERMIT} ${SIP_PORT} ${SIP_TLS_PORT} ${RTP_START} ${RTP_END} ${DOCKER_SUBNET} ${SIP_ACL_LINES} ${TLS_TRANSPORT} ${ASTERISK_IP}'

for f in asterisk.conf acl.conf modules.conf logger.conf http.conf pjsip.conf rtp.conf manager.conf \
         extensions.conf voicemail.conf queues.conf cdr.conf cdr_custom.conf musiconhold.conf; do
  envsubst "$VARS" < "$T/$f.tmpl" > "$D/$f"
done

# Leere Dateien fuer optionale Module, damit Asterisk beim (Neu-)Laden keine Fehlermeldungen ueber fehlende Konfiguration schreibt
for f in stir_shaken.conf pjsip_wizard.conf geolocation.conf pjproject.conf aeap.conf smdi.conf res_fax.conf cel_custom.conf \
         cli_aliases.conf resolver_unbound.conf statsd.conf udptl.conf features.conf indications.conf res_odbc.conf \
         res_pgsql.conf res_config_sqlite3.conf res_ldap.conf cel.conf ccss.conf xmpp.conf phoneprov.conf hep.conf; do
  [ -e "$D/$f" ] || : > "$D/$f"
done

# Platzhalter fuer generierte Dateien (Backend ueberschreibt sie atomar).
for f in pjsip_mosi.conf extensions_mosi.conf voicemail_mosi.conf queues_mosi.conf; do
  mkdir -p "$D/mosi"; [ -e "$D/mosi/$f" ] || printf '; noch nicht vom Backend generiert\n' > "$D/mosi/$f"
done

# Sounds-Verzeichnis fuer IVR-Ansagen (Volume)
mkdir -p "${SOUNDS_DIR:-/var/lib/mosi/sounds}" "$AST_LOG/cdr-custom"

if [ "${MOSI_RENDER_ONLY:-0}" = "1" ]; then exit 0; fi
echo "Mosi Telefonie-Engine startet (HOST_IP=${HOST_IP}, SIP ${SIP_PORT}, RTP ${RTP_START}-${RTP_END})"
exec "$@"
