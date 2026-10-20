# Drittanbieter-Software und Lizenzen

Mosi Cloud PBX selbst steht unter der MIT-Lizenz (siehe `LICENSE`). Die folgenden Komponenten werden **nicht** in
dieses Repository kopiert, sondern beim Installieren aus den genannten offiziellen Quellen bezogen. Ihre Lizenzen
gelten unabhängig von der MIT-Lizenz dieses Projekts.

| Komponente | Version / Quelle | Lizenz | Verwendung |
|---|---|---|---|
| Asterisk | Pakete `asterisk`, `asterisk-modules`, `asterisk-config` aus Debian 12 „bookworm“ (deb.debian.org, 20.x-Serie) | GPL-2.0 (mit Zusatzausnahmen, siehe `/usr/share/doc/asterisk/copyright` im Image) | Telefonie-Engine, läuft als eigener Container; es wird nicht in Mosi-Code eingebunden (Kommunikation über das AMI-Netzwerkprotokoll) |
| Asterisk Core-/MOH-Sounds (en) | Debian-Pakete `asterisk-core-sounds-en-gsm`, `asterisk-moh-opsound-gsm` | CC-BY-SA-3.0 bzw. Herstellerangaben im Paket | Standardansagen der Voicemail, Wartemusik |
| Debian GNU/Linux | Image `debian:12.15-slim` (Docker Official Image) | verschiedene (DFSG) | Basis des Telefonie-Containers |
| Node.js | Image `node:22.23.3-bookworm-slim` (Docker Official Image) | MIT u. a. | Laufzeit für Backend |
| PostgreSQL | Image `postgres:16.15-alpine` (Docker Official Image) | PostgreSQL License | Datenbank |
| Caddy | Image `caddy:2.8.4-alpine` (Docker Official Image) | Apache-2.0 | HTTPS-Reverse-Proxy |
| express, express-rate-limit, helmet, pg, bcryptjs | npm, feste Versionen in `backend/package-lock.json` | MIT (bcryptjs: MIT/BSD-3, pg: MIT) | Backend |
| JsSIP | npm `jssip@3.10.1`, beim Build zu `jssip.min.js` gebündelt (esbuild, MIT) | MIT | SIP-über-WebSocket-Client für die Browsertelefonie |
| esbuild | npm, nur zur Build-Zeit | MIT | Bündelung von JsSIP |

Playwright/Chromium werden nur für die optionalen Browser-Tests (`tests/integration`) verwendet und sind kein Teil der Laufzeit.

Hinweis zu Asterisk: Asterisk ist ein eingetragenes Warenzeichen von Sangoma Technologies. Dieses Projekt ist weder
mit Sangoma noch mit Debian, Proxmox oder den genannten Projekten verbunden oder von ihnen unterstützt.
