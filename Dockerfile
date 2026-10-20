# Mosi Cloud PBX - Verwaltungs-API und Dashboard (eigene Komponente)
# Basis: offizielles Node.js-Image (Docker Official Image, Debian 12 bookworm). Version fest gepinnt.
ARG NODE_IMAGE=node:22.23.3-bookworm-slim

# --- 1) Browser-Telefonbibliothek (JsSIP, MIT) fuer das Dashboard bauen -------------------------
FROM ${NODE_IMAGE} AS frontend-build
WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
RUN npm run build

# --- 2) Backend-Abhaengigkeiten (nur Produktion) --------------------------------------------
FROM ${NODE_IMAGE} AS backend-deps
WORKDIR /app
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

# --- 3) Laufzeit-Image -----------------------------------------------------------------------
FROM ${NODE_IMAGE}
ENV NODE_ENV=production
# Feste UID/GID 10001 (identisch zur Telefonie-Engine) fuer gemeinsam genutzte Volumes
RUN groupadd -g 10001 mosi && useradd -u 10001 -g 10001 -M -s /usr/sbin/nologin mosi \
 && mkdir -p /etc/asterisk/mosi /var/spool/asterisk/voicemail /var/lib/mosi/sounds /var/log/asterisk/cdr-custom \
 && chown -R mosi:mosi /etc/asterisk /var/spool/asterisk /var/lib/mosi /var/log/asterisk
WORKDIR /app
COPY --from=backend-deps /app/node_modules ./node_modules
COPY backend/package.json ./package.json
COPY backend/src ./src
COPY backend/migrations ./migrations
COPY frontend/index.html ./public/index.html
COPY frontend/css ./public/css
COPY frontend/js ./public/js
COPY --from=frontend-build /build/vendor/jssip.min.js ./public/vendor/jssip.min.js
RUN chown -R mosi:mosi /app
USER mosi
EXPOSE 3000
HEALTHCHECK --interval=20s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "src/index.js"]
