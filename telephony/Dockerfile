# Mosi Cloud PBX - Telefonie-Engine (Asterisk aus den offiziellen Debian-Paketen)
# Herkunft: Debian 12 "bookworm" Paketarchiv (deb.debian.org), Asterisk-Lizenz: GPL-2.0
ARG DEBIAN_IMAGE=debian:12-slim
FROM ${DEBIAN_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      asterisk asterisk-modules asterisk-config \
      asterisk-core-sounds-en-gsm asterisk-moh-opsound-gsm \
      gettext-base ca-certificates tzdata netcat-openbsd \
 && rm -rf /var/lib/apt/lists/* \
 # feste UID/GID, damit Backend und Asterisk sich Volumes teilen koennen
 && groupmod -g 10001 asterisk && usermod -u 10001 -g 10001 asterisk \
 && rm -rf /etc/asterisk/* \
 && mkdir -p /etc/asterisk/mosi /var/lib/mosi/sounds /var/spool/asterisk/voicemail /var/log/asterisk/cdr-custom /var/run/asterisk /etc/asterisk/templates \
 && chown -R asterisk:asterisk /etc/asterisk /var/lib/mosi /var/spool/asterisk /var/log/asterisk /var/run/asterisk /var/lib/asterisk

COPY templates/ /etc/asterisk/templates/
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/entrypoint.sh

USER asterisk
WORKDIR /var/lib/asterisk
EXPOSE 5060/udp 5060/tcp 5061/tcp 10000-10199/udp
HEALTHCHECK --interval=20s --timeout=5s --start-period=20s --retries=3 \
  CMD asterisk -rx "pjsip show transports" 2>/dev/null | grep -q "Transport:" || exit 1
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["asterisk", "-f", "-U", "asterisk", "-G", "asterisk"]
