# Mosi Cloud PBX

Selbst gehostete Telefonanlage mit **echter SIP-Telefonie** (Asterisk), Web-Dashboard, Browsertelefon (WebRTC) und
SIP-Trunk-Anbindung. Läuft per Docker Compose **direkt auf einem Ubuntu-/Debian-Server (auch Ubuntu 26.04)**, in einer **VM oder einem LXC-Container auf Proxmox VE** – oder (mit ausdrücklicher Bestätigung) direkt auf dem Proxmox-Host.

> **Ehrlicher Stand:** Der Funktionsumfang unten ist umgesetzt und getestet (siehe [Teststatus](#teststatus)).
> Was *nicht* getestet werden konnte (echter SIP-Anbieter, echte Tischtelefone/Smartphones, Proxmox selbst, Registrierung über SIP-TLS), ist
> ausdrücklich im Abschnitt [Bekannte Grenzen](#bekannte-grenzen) aufgeführt.

## Inhalt

- [Funktionen](#funktionen) · [Architektur](#architektur) · [Voraussetzungen](#voraussetzungen)
- [Installation auf Proxmox](#installation-auf-proxmox-lxc-oder-vm) · [Erste Schritte](#erste-schritte-nach-der-installation)
- [Netzwerk](#netzwerk-und-sicherheit) · [Geräte einrichten](#handy-und-tischtelefone) · [SIP-Trunk](#externe-telefonie-sip-trunk)
- [Betrieb: Backup, Update, Deinstallation](#betrieb) · [Fehlerdiagnose](#fehlerdiagnose) · [Tests](#teststatus) · [Lizenzen](#lizenz-und-drittanbieter)

## Funktionen

| Bereich | Umsetzung |
|---|---|
| Telefonie-Engine | **Asterisk** (PJSIP) in eigenem Container – keine Simulation. Interne Gespräche, Besetzt/Nicht erreichbar/Timeout, Rufumleitung (sofort/besetzt/keine Antwort/nicht erreichbar), **mehrere Geräte pro Nebenstelle klingeln parallel** (Tischtelefon + App + Browser), Rufgruppen, Warteschlangen, Telefonmenüs (IVR), Zeitpläne/Nachtschaltung, Voicemail, Anrufübernahme (`**100`), Kurzwahlen, Echo-Test `*43` (Signalton, danach hören Sie sich selbst – prüft den Medienpfad) |
| Endgeräte | SIP-Tischtelefone (UDP/TCP), Smartphone-SIP-Apps, **Browsertelefon (WebRTC, WSS + DTLS-SRTP)** |
| Extern | Konfigurierbare **SIP-Trunks** (Registrierung oder IP-Authentifizierung), eingehende Rufnummern mit Zeitplan-Routing, ausgehende Wählregeln, Absenderrufnummer, Kanal-Limits |
| Dashboard | Dunkles, minimalistisches deutsches Web-UI mit 15 Bereichen; alle Werte stammen aus Backend, Datenbank und Asterisk (echte Statusabfragen) |
| Daten | PostgreSQL: Nebenstellen, Benutzer/Rollen, Geräte, Anruflisten, Gruppen, Konfigurationsrevisionen, Audit-Log, Systemereignisse |
| Sicherheit | bcrypt-Passwörter, Sitzungen mit HttpOnly/SameSite-Cookie, CSRF-Token, Rate-Limits, Kontosperre, Rollen (Admin/Operator/Benutzer), strikte Eingabevalidierung, Betrugsschutz bei ausgehenden Anrufen, Admin-UI und SIP nur aus dem LAN/VPN |
| Betrieb | `install.sh`, `update.sh`, `backup.sh`, `restore.sh`, `uninstall.sh`, `healthcheck.sh`; feste Image-Versionen; strukturierte JSON-Logs |

Einschränkung: In **Warteschlangen** wird je Mitglied nur dessen zuletzt registriertes Gerät gerufen (Rufgruppen und Einzelanrufe rufen alle Geräte).

Nicht enthalten (bewusst, nicht vorgetäuscht): Gesprächsaufzeichnung, automatische Telefon-Provisionierung (Autoprovisioning),
Fax, Konferenzräume, dynamisches An-/Abmelden von Queue-Agenten, E-Mail-Versand der Voicemail.

## Architektur

```
                         LAN / VPN
   Browser ──HTTPS/WSS──┐                    SIP/RTP (UDP/TCP)
   (Dashboard,          │                ┌─── Tischtelefone, Smartphone-Apps
    Browsertelefon)     ▼                ▼
 ┌─────────────────────────── VM oder LXC auf Proxmox (Docker Compose) ─────────────────────────┐
 │  proxy (Caddy) :443 ──/──▶ app (Node.js API + Dashboard)  ──SQL──▶ db (PostgreSQL)          │
 │        │                        │  ▲ Konfiguration (Dateien, Volume)                          │
 │        └──/ws (WebSocket)──┐    │  └── AMI (TCP 5038, nur intern) ─┐                          │
 │                            ▼    ▼                                   ▼                         │
 │                        asterisk (PJSIP) :5060 udp/tcp, RTP 10000-10099/udp ◀────── SIP-Trunk  │
 └──────────────────────────────────────────────────────────────────────────────────────────────┘
```

* **Konfigurationsfluss:** Die API erzeugt aus der Datenbank deterministisch die Asterisk-Dateien
  (`pjsip_mosi.conf`, `extensions_mosi.conf`, `voicemail_mosi.conf`, `queues_mosi.conf`), schreibt sie atomar ins gemeinsame Volume,
  lädt Asterisk neu und **verifiziert**, dass alle Endpunkte, Dialplan-Kontexte (inkl. Anzahl der Schritte), Warteschlangen und
  Postfächer tatsächlich geladen wurden. Schlägt etwas fehl, wird die DB-Transaktion zurückgerollt und die alte Konfiguration
  wiederhergestellt – ein Tippfehler legt die Anlage nicht lahm.
* **Anruflisten:** Asterisk schreibt jeden Anruf in eine CSV (`cdr_custom`); das Backend liest sie fortlaufend ein (auch nach
  Ausfällen des Backends, Position wird in der DB gemerkt).
* Details: [`docs/architecture.md`](docs/architecture.md)

## Voraussetzungen

* Proxmox VE (beliebige aktuelle Version) mit Netzwerkzugriff auf Ihr LAN.
* Eine **VM** (empfohlen, Debian 12/Ubuntu 22.04+, 2 vCPU, 2 GB RAM, 16 GB Disk) **oder** ein **unprivilegierter LXC-Container** mit aktivierten Features *Nesting* und *keyctl*.
* Feste IP-Adresse (DHCP-Reservierung) für die VM/den Container.
* Internetzugang **während der Installation** (Docker Hub, `archive.ubuntu.com`, `registry.npmjs.org`).
* Docker Engine + Compose-Plugin (kann `install.sh --install-docker` aus dem offiziellen Docker-APT-Repository einrichten), `curl`, `openssl`, `git`.

## Installation auf Proxmox (LXC oder VM)

Ausführlich mit Screenshots-freien Schritt-für-Schritt-Befehlen: [`docs/proxmox.md`](docs/proxmox.md). Kurzfassung:

1. **VM oder LXC in Proxmox anlegen** (Debian 12). Bei LXC: *Unprivileged* belassen, unter *Optionen → Features* **Nesting** und **keyctl** aktivieren. Der Proxmox-Host bleibt unverändert.
2. **In der VM/dem Container** (nicht auf dem Proxmox-Host!) als root:
   ```bash
   apt-get update && apt-get install -y git curl openssl ca-certificates
   git clone https://github.com/Mosi-pro/Telefonanlage-Mosi.git /opt/mosi
   cd /opt/mosi
   ./install.sh --install-docker        # nur nötig, wenn Docker noch fehlt
   ```
3. `install.sh` prüft die Umgebung (verweigert den Start auf einem Proxmox-Host), erzeugt `.env` mit **zufälligen Geheimnissen**, baut die Images, startet alle Dienste, führt `healthcheck.sh` aus und zeigt Adresse und Erstpasswort an.
   Bei fehlenden Voraussetzungen bricht es mit einer verständlichen Fehlermeldung ab (z. B. kein Docker, Port belegt, zu wenig Speicher, Proxmox-Host).

Optionen: `--host-ip <IP>`, `--hostname <Name>`, `--yes`, `--no-start`, `--skip-build`. Das Skript führt keine Fremdskripte aus.

### Direkt auf einem Server oder dem Proxmox-Host

```bash
apt-get update && apt-get install -y git curl openssl ca-certificates
git clone https://github.com/Mosi-pro/Telefonanlage-Mosi.git /opt/mosi && cd /opt/mosi
./install.sh --install-docker                       # Ubuntu/Debian-Server (auch 26.04)
./install.sh --install-docker --allow-proxmox-host  # direkt auf dem Proxmox-Host
```
Die Container-Images bringen ihre eigene Software mit; auf dem Host werden nur Docker-Pakete installiert. Gibt es für Ihre Ubuntu-Version (z. B. 26.04) noch kein Docker-Repository, nutzt `--install-docker` automatisch `docker.io` + `docker-compose-v2` der Distribution. **Ubuntu 26.04 und der Proxmox-Host wurden nicht getestet.** Auf dem Proxmox-Host ändert Docker iptables-Regeln – Proxmox-Firewall und Ports (443, 80, 5060, 10000–10099/udp) vorher prüfen.

## Erste Schritte nach der Installation

1. `https://<IP der VM>` öffnen (Zertifikatshinweis: siehe [`docs/network.md`](docs/network.md#https-und-zertifikate)), als `admin` mit dem angezeigten Passwort anmelden und es unter *Passwort ändern* ersetzen.
2. **Nebenstellen** → *Nebenstelle anlegen* (z. B. 100, 101). Die Anlage erzeugt ein starkes SIP-Passwort und lädt die Konfiguration in Asterisk.
3. **Verbindung / Diagnose** der Nebenstelle öffnen → Serveradresse, Benutzername, Passwort in Telefon/App eintragen ([`docs/phones.md`](docs/phones.md)).
4. Oder **Browsertelefon** (Menü) – Mikrofon erlauben, Nummer wählen.
5. Intern anrufen. Anrufliste und Dashboard füllen sich mit echten Ereignissen.
6. Optional: SIP-Trunk einrichten ([`docs/trunk.md`](docs/trunk.md)). **Ohne Trunk sind keine externen Anrufe möglich** – das Dashboard weist darauf hin.

## Netzwerk und Sicherheit

| Dienst | Port | Erreichbar für |
|---|---|---|
| Dashboard / WebRTC (HTTPS, WSS unter `/ws`) | 443/tcp (80 → Weiterleitung) | `ADMIN_ALLOWED_NETS` (Standard: private Adressbereiche) |
| SIP | 5060/udp + 5060/tcp (optional 5061/tcp TLS) | `SIP_ALLOWED_NETS` (Standard: private Adressbereiche) |
| RTP (Sprache) | 10000–10099/udp (2 Ports je Gespräch) | LAN/VPN |
| PostgreSQL, Asterisk-AMI (5038), interne HTTP-Ports | – | **nicht veröffentlicht**, nur im internen Docker-Netz |

* **Nichts davon gehört ins offene Internet.** Für unterwegs: VPN (WireGuard-Beispiel: `config/wireguard/`). Keine Anleitung, „alle Ports freizugeben“.
* Firewall-Regeln, NAT, STUN/TURN, Zertifikate: [`docs/network.md`](docs/network.md) · Sicherheitsleitfaden: [`docs/security.md`](docs/security.md)

## Handy und Tischtelefone

* **Smartphone:** beliebige SIP-App (z. B. Linphone, Zoiper, Groundwire) mit Daten aus *Nebenstellen → Verbindung*; von unterwegs nur per VPN.
* **Tischtelefone:** jedes standardkonforme SIP-Telefon (Yealink, Snom, Grandstream, Gigaset, Cisco SPA …) manuell einrichten. Das Anstecken des Netzwerkkabels allein macht kein SIP-Telefon: Es braucht Serveradresse, Benutzername und Passwort.
* Anleitung mit typischen Menüpfaden und Diagnose fehlgeschlagener Registrierungen: [`docs/phones.md`](docs/phones.md)

## Externe Telefonie (SIP-Trunk)

Unter *Rufnummern und SIP-Trunks* tragen Sie Registrar, Benutzer, Passwort, Transport, Ihre Rufnummern und Wählregeln **Ihres eigenen Anbieters** ein. Es sind keine Zugangsdaten oder Rufnummern voreingestellt.
Ausgehend sind standardmäßig **nur freigegebene Nebenstellen** und **nur Ziele ohne Sperrpräfix** (0900, 0137, 0180, 118 …) erlaubt; Ausland braucht eine eigene Freigabe. Details: [`docs/trunk.md`](docs/trunk.md).

## Betrieb

```bash
./healthcheck.sh                  # echte Prüfung aller Dienste
./backup.sh                       # Datenbank + Telefoniekonfiguration + Voicemail + Zertifikats-CA + .env in eine Datei
./restore.sh backups/<datei>.tar.gz --yes     # Wiederherstellung (legt vorher eine Sicherheitskopie an)
./update.sh                       # Backup → git pull → neu bauen → prüfen; Daten bleiben erhalten
./uninstall.sh                    # Dienste entfernen, Daten bleiben; mit --purge ALLES löschen (mit Bestätigung)
docker compose logs -f app        # strukturierte JSON-Logs (auch: asterisk, db, proxy)
docker compose restart asterisk   # sicherer Neustart eines Dienstes; Konfiguration und Registrierungen kehren zurück
```

Alle Konfigurationen überstehen Neustarts der VM/des Containers (`restart: unless-stopped`, Daten in Docker-Volumes). Mehr: [`docs/operations.md`](docs/operations.md).
**Sicherheitswartung:** Images sind auf feste Versionen gepinnt – regelmäßig (mind. monatlich) `./update.sh` ausführen und Sicherheitsmeldungen zu Asterisk/Ubuntu/Caddy/Node beachten.

## Fehlerdiagnose

Siehe [`docs/troubleshooting.md`](docs/troubleshooting.md): Installation (LXC/Docker), Registrierung schlägt fehl, einseitiges/kein Audio, Browsertelefon, Trunk, Dashboard-Meldungen.

## Teststatus

Folgendes wurde **tatsächlich ausgeführt** – in einer Linux-VM mit Docker, gegen eine **frische Installation aus einem sauberen Git-Checkout** per `./install.sh --skip-build` (echtes Asterisk, echtes PostgreSQL, echter Chromium). `--skip-build` war nötig, weil der Docker-Build in dieser Umgebung nur mit `--network host` (und für Node mit einer um das Sandbox-Zertifikat erweiterten Basis) funktionierte; die Images wurden daher vorab mit `docker build` gebaut. Der unveränderte `docker compose build` mit den gepinnten Basis-Images lief erfolgreich in der GitHub-CI (`.github/workflows/ci.yml`, Run vom 20.10.2026):

| Test | Ergebnis |
|---|---|
| Backend-Unit-Tests (`cd backend && npm test`): Generator, Validierung/Injection, Krypto, CDR | 25/25 bestanden |
| `tests/integration/test_pbx.py` (Compose-Stack, 98 Prüfungen): Anmeldung/401/CSRF, Nebenstellen anlegen (Doppelte/Injection abgelehnt), Digest-Registrierung (richtig/falsch/unbekannt) und Fehlerdiagnose, **interner Anruf mit Audio in beide Richtungen** (RTP-Pakete verglichen), Auflegen, Anrufliste (Dauer/Richtung), nicht erreichbar, Klingel-Timeout, mehrere Geräte pro Nebenstelle parallel, Besetzt, Rufgruppe, Rufumleitung (sofort, bei Nichtannahme, bei Nichterreichbarkeit; extern ohne Berechtigung abgelehnt), Kurzwahl, Anrufübernahme, Warteschlange (+ leere Queue → Voicemail), Telefonmenü mit WAV-Ansage und DTMF-Tastenwahl, Echo-Test, Voicemail (Aufnahme + Abruf), Sperre externer/Auslands-/Mehrwertanrufe, **SIP-Trunk gegen simulierten Anbieter** ausgehend + eingehend inkl. Audio, Zeitplan/Nachtschaltung, Ablehnung ungültiger Konfiguration, **Neustart der Telefonie-Engine** (Konfiguration + Anrufe danach funktionsfähig), Audit-Log | 98/98 bestanden |
| `tests/integration/test_webrtc.py`: Chromium-Browsertelefon ↔ SIP-Gerät in **beide Richtungen** (ausgehend und eingehend/Klingeln/Annehmen), WSS über Caddy, **DTLS-SRTP verbunden**, Audio beidseitig, DTMF, Stumm, Auflegen | 14/14 bestanden |
| `tests/integration/ui_smoke.js`: Bedienung des Dashboards im Browser (Anmeldung, Nebenstelle anlegen, Fehlerdialog, Rollen, CSRF, Mobilansicht, keine CSP-Fehler) | bestanden |
| `install.sh` aus frischem Checkout inkl. Gesundheitsprüfung; `backup.sh` → Daten ändern → `restore.sh`; `update.sh` (Backup → Neustart der Dienste → Healthcheck); `uninstall.sh --purge` | bestanden |
| **Neustart-Test:** Docker-Daemon beendet und neu gestartet (entspricht Neustart der VM/des Containers): alle Dienste kamen von selbst gesund zurück, Nebenstellen/Trunks/Anrufliste/Konfiguration vorhanden | bestanden |
| Eigenes HTTPS-Zertifikat (`MOSI_TLS=/certs/...`, Zertifikatskette per curl geprüft); SIP-TLS-Transport lädt und beantwortet TLS-Handshake auf Port 5061 | bestanden (Registrierung/Anrufe über SIP-TLS **nicht** getestet) |
| `shellcheck` der Skripte | ohne Warnungen |

Wiederholung und Details: [`docs/testing.md`](docs/testing.md). Die Tests fanden u. a. diese Fehler, die behoben wurden (Auswahl): Reconnect des AMI-Clients, Browser-Authentifizierung (eigener Auth-Benutzer), `Dial(PJSIP/…)` ruft nur *einen* Kontakt an, Pickup-Syntax, CDR-Zeitzone, JsSIP kann Container-Hostnamen nicht parsen.

## Bekannte Grenzen

* **Nicht getestet:** Betrieb auf einem echten Proxmox-Server (LXC-Features/VM) – die Anleitung folgt der Docker-Dokumentation, wurde aber nicht auf Proxmox ausgeführt; **echter SIP-Anbieter** (Trunk-Logik wurde nur gegen einen simulierten Anbieter im selben Netz geprüft, Interoperabilität mit konkreten Anbietern kann Anpassungen erfordern); **echte Tischtelefone und Smartphone-Apps** (getestet mit einem eigenen Test-UA und Chromium); **Registrierung und Anrufe über SIP-TLS** (nur Transport und Handshake getestet); NAT-Szenarien über Netzgrenzen hinweg; Multi-Arch (ARM).
* Der Telefonie-Container basiert auf `ubuntu:24.04` (Asterisk 20.6 aus dem Ubuntu-Archiv; Debian 12 liefert kein Asterisk-Paket mehr – das hat die GitHub-CI beim ersten Versuch aufgedeckt). Die Basis-Tags sind gepinnt, die Paketversion folgt dem Ubuntu-Archiv (Sicherheitsupdates kommen mit `./update.sh`, ggf. `docker compose build --no-cache asterisk`).
* Browsertelefonie braucht **HTTPS mit vertrauenswürdigem Zertifikat** und funktioniert über NAT/Mobilfunk nicht ohne VPN oder STUN/TURN. Sie funktioniert nicht „über jedes Netzwerk“.
* Notrufe über VoIP sind nicht garantiert (Standort, Anbieter). Nicht als alleinige Notrufmöglichkeit verwenden.
* Kein automatisches Blockieren (fail2ban) von SIP-Angreifern; Schutz beruht auf Netzwerkfilter + starken Passwörtern + Überwachung im Dashboard.
* Voicemail-Ansagen sind die englischen Standardansagen von Asterisk (kein deutsches Sprachpaket in den Paketquellen); IVR-Ansagen laden Sie selbst hoch.
* Ausgehende Rufnummernübermittlung, Premium-Sperren und Berechtigungen schützen vor Missbrauch **innerhalb** der Anlage – sie ersetzen nicht die Ausgabenlimits Ihres Anbieters (dort ebenfalls setzen!).

## Lizenz und Drittanbieter

MIT-Lizenz für diesen Code (`LICENSE`). Eingesetzte Komponenten, Quellen und Lizenzen: [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)
(u. a. Asterisk GPL-2.0, PostgreSQL, Caddy, JsSIP MIT).

## Repository-Struktur

```
compose.yaml  compose.tls.yaml  .env.example  Dockerfile        # Orchestrierung, App-Image
install.sh update.sh backup.sh restore.sh uninstall.sh healthcheck.sh scripts/lib.sh
backend/      # API (Node.js): src/, migrations/, test/
frontend/     # Dashboard (ohne Build-Schritt; JsSIP wird beim Image-Build gebündelt)
telephony/    # Asterisk-Image, Entrypoint, Konfigurations-Templates
config/       # Caddyfile, Beispiele (Proxmox-LXC, WireGuard, nftables)
docs/         # Anleitungen
tests/        # Integrationstests (SIP-Testclient, WebRTC)
```
