# Architektur und Netzwerkmodell

## Komponenten (Docker Compose, Projektname `mosi`)

| Dienst | Image | Aufgabe | Veröffentlichte Ports |
|---|---|---|---|
| `asterisk` | selbst gebaut aus `telephony/` (Ubuntu 24.04 + Asterisk-Pakete) | SIP-Registrar/Vermittlung/Medien, Voicemail, Queues, WebSocket-Transport | 5060/udp+tcp, RTP-Bereich/udp (+5061/tcp mit `compose.tls.yaml`) |
| `app` | selbst gebaut aus `Dockerfile` (Node.js) | REST-API, Dashboard (statische Dateien), Konfigurationsgenerator, Überwachung, CDR-Import | keine (nur über `proxy`) |
| `db` | `postgres:16.15-alpine` | persistente Daten | keine |
| `proxy` | `caddy:2.8.4-alpine` | HTTPS/TLS, Zugriffsbeschränkung auf erlaubte Netze, Weiterleitung `/` → app, `/ws` → asterisk | 443, 80 |

Es gibt bewusst **keine weiteren Microservices**. Interne Adressen: Netz `172.29.0.0/24`, Asterisk fest `172.29.0.10`.

## Volumes (persistent)

| Volume | Inhalt | Gesichert durch `backup.sh` |
|---|---|---|
| `db_data` | PostgreSQL-Datenverzeichnis | ja (als `pg_dump`) |
| `asterisk_generated` | generierte Asterisk-Konfiguration (nachvollziehbar, wird beim Start aus der DB neu abgeglichen) | ja |
| `voicemail` | Voicemail-Nachrichten (WAV) | ja |
| `sounds` | hochgeladene IVR-Ansagen | ja |
| `asterisk_logs` | Asterisk-Logs und CDR-CSV | nein (Anrufe stehen in der DB) |
| `caddy_data` | lokale Zertifizierungsstelle und Zertifikate | ja |

## Konfigurationsfluss (Nebenstelle anlegen)

1. Browser → `POST /api/extensions` (Sitzung, CSRF-Token, Rolle, Rate-Limit).
2. Eingaben werden gegen enge Whitelists geprüft (`backend/src/validate.js`) – Namen dürfen z. B. keine Anführungszeichen, `;`, `$`, `,`, `(`, Zeilenumbrüche enthalten.
3. **Transaktion:** Datensatz wird geschrieben (SIP-Passwort zufällig, AES-256-GCM-verschlüsselt in der DB).
4. `generator.js` erzeugt **aus dem gesamten DB-Zustand** die vier Asterisk-Dateien (reine Funktion, unit-getestet). Konsistenzprüfungen: eindeutige Rufnummern, existierende Ziele, Berechtigung bei Weiterleitungen, Kurzwahl-Konflikte.
5. Dateien werden atomar (`rename`) ins Volume geschrieben, `core reload` per AMI.
6. **Verifikation:** Asterisk wird gefragt, ob alle erwarteten PJSIP-Endpunkte existieren, jeder Dialplan-Kontext die erwartete Zahl an Schritten geladen hat, Queues/Voicemail-Boxen/Trunk-Registrierungen vorhanden sind.
7. Erfolg → `COMMIT` + Eintrag in `config_revisions` (Passwörter geschwärzt). Fehler → `ROLLBACK`, alte Dateien zurück, erneuter `core reload`, Fehler in der Oberfläche.
8. Beim Start/Reconnect gleicht das Backend Dateien und DB ab (`apply.sync`) – Asterisk-Neustart oder Datenverlust im Volume heilen sich selbst.

## Rufverarbeitung (Dialplan)

* `mosi-internal` (alle Endgeräte) bindet in dieser Reihenfolge ein: `mosi-features` (`*43`, `*97`, `*98`, `**<Nr>`, Kurzwahlen) → `mosi-dest` (Nebenstellen/Gruppen/Queues/IVR) → `mosi-out` (ausgehende Regeln) → `mosi-fallback`.
* **Ausgehende Rufe** laufen über `mosi-outchk`: Klasse `emergency` immer erlaubt; sonst `MOSI_ALLOW_EXT` (Endpoint-Variable) nötig; `international` zusätzlich `MOSI_ALLOW_INTL`; Sperrpräfixe; Limit gleichzeitiger Gespräche je Nebenstelle (`GROUP_COUNT`) und je Trunk.
* **Eingehende Rufe** eines Trunks landen im Kontext `mosi-in-<id>`, werden per Rufnummer (optional Zeitplan) zugeordnet; unbekannte Nummern werden abgewiesen (oder zum Standardziel geleitet).
* **WebRTC:** Jede Nebenstelle mit Browsertelefonie hat zusätzlich den Endpunkt `<user>-web` (eigene Auth, DTLS-SRTP, ICE, `transport-ws`). Anrufe an die Nebenstelle klingeln parallel an **alle** erreichbaren Kontakte (`PJSIP_DIAL_CONTACTS(<user>)` über das Unterprogramm `mosi-ds`) und – falls ein Browser registriert ist – an `PJSIP/<user>-web` (`mosi-dsw`; Browser-Kontakte sind als Kontakt-Wahlstring nicht verwendbar). Queue-Mitglieder werden über `PJSIP/<user>` gerufen und erreichen daher nur ein Gerät je Mitglied.

## Netzwerkmodell

* Asterisk läuft in einem Bridge-Netz; SIP/RTP-Ports werden auf die Host-IP veröffentlicht. `external_media_address`/`external_signaling_address` = `HOST_IP`, `local_net` = Docker-Subnetz → Geräte im LAN erhalten die Host-IP im SDP.
* WebRTC-ICE: `[ice_host_candidates]` bildet die Container-IP auf `HOST_IP` ab, damit Browser einen erreichbaren Kandidaten erhalten.
* Der Browser spricht SIP über `wss://<Host>/ws` mit Caddy (TLS-Terminierung); Medien laufen direkt Browser ↔ `HOST_IP:RTP-Port` (DTLS-SRTP).
* Zugriffskontrolle: Caddy (`ADMIN_ALLOWED_NETS`), Asterisk-ACL für SIP-Endgeräte (`SIP_ALLOWED_NETS`), AMI/Postgres nur im internen Netz.

## Datenmodell (Auszug)

`users`, `sessions`, `login_attempts`, `extensions`, `devices`, `contacts`, `ring_groups`, `queues`, `ivrs`, `schedules`, `trunks`, `trunk_numbers`,
`outbound_rules`, `calls`, `registrations`, `settings`, `audit_log`, `system_events`, `config_revisions`, `cdr_state` – siehe `backend/migrations/001_init.sql`.
