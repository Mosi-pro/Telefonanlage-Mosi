# Tests

## Backend-Unit-Tests (ohne Datenbank/Asterisk)

```bash
cd backend && npm ci && npm test
```
Prüft: Konfigurationsgenerator (Endpunkte inkl. WebRTC, Dialplan für intern/Weiterleitung/Gruppen/Queues/IVR/Zeitpläne/Trunks/Berechtigungen, Fehlerfälle), Eingabevalidierung inkl. Injection-Versuchen, Verschlüsselung, CDR-Parser.

## Integrationstests mit echter Telefonie

`tests/integration/sipua.py` ist ein kleiner SIP-Client (nur Python-Standardbibliothek: Digest-Registrierung, INVITE/BYE, RTP G.711). Damit wird **echtes Audio in beide Richtungen** nachgewiesen: Jeder Client sendet ein eigenes Byte-Muster; geprüft wird, dass beim Gegenüber exakt dieses Muster ankommt.

### Gegen den Compose-Stack

```bash
python3 tests/integration/test_pbx.py --api https://<HOST_IP> --sip <HOST_IP>:5060 --local-ip <IP des Testrechners im erlaubten Netz> \
        --provider-ip <zweite IP des Testrechners für den simulierten Anbieter> \
        --admin-pass '<Admin-Passwort>' --restart-cmd "docker compose restart asterisk"
```
* Der Testrechner braucht eine Adresse in `SIP_ALLOWED_NETS` und für den simulierten Anbieter eine **zweite** Adresse (z. B. `ip addr add 192.168.1.250/32 dev eth0`), weil Trunks per Quelladresse erkannt werden.
* Der Test legt Nebenstellen 100–102, eine Rufgruppe 700, einen Test-Trunk und Zeitpläne an und räumt Nebenstellen/Gruppen/Trunks zu Beginn früherer Läufe auf – **nicht gegen produktive Systeme ausführen!**

Geprüft werden u. a.: Anmeldung/CSRF/401, mehrere Geräte pro Nebenstelle (parallel klingeln), Besetzt-Zustand, Kurzwahl, Rufumleitung, Anrufübernahme (`**101`) inkl. Berechtigung, Warteschlange (inkl. leere Queue → Voicemail), Telefonmenü mit hochgeladener WAV-Ansage und Tastenwahl (RFC-4733-DTMF), Anlegen von Nebenstellen und Ablehnung von Doppelten/Injection, Registrierung (richtig/falsch/unbekannt), Fehlerdiagnose, interner Anruf mit Audio beidseitig, Auflegen, Anrufliste (Dauer/Richtung), nicht erreichbar, Klingel-Timeout, Rufgruppe, Voicemail (Aufnahme + WAV-Abruf), Sperre externer Anrufe ohne Berechtigung, Ausland/Mehrwertpräfix gesperrt, Trunk ausgehend und eingehend inkl. Audio, Zeitplan/Nachtschaltung, unbekannte Rufnummer, Ablehnung ungültiger Konfiguration, Neustart der Engine (Konfiguration und Anrufe danach wieder funktionsfähig), Audit-Log.

### Browsertelefon (WebRTC)

```bash
cd tests/integration && npm install            # Playwright; Chromium muss vorhanden sein (CHROMIUM_PATH) oder `npx playwright install chromium`
python3 test_webrtc.py --api https://<HOST_IP> --sip <HOST_IP>:5060 --local-ip <Testrechner-IP> --admin-pass '<Passwort>'
```
Chromium (Fake-Mikrofon) meldet sich über `wss://…/ws` an und ruft Nebenstelle 101 (SIP-Testclient) an; danach ruft der SIP-Client das Browsertelefon an (Klingeln, Anruferkennung, Annehmen). Geprüft werden DTLS-SRTP (`dtlsState=connected`), RTP-Pakete in beide Richtungen, DTMF/Stumm und Auflegen. Voraussetzung: Nebenstellen aus `test_pbx.py` existieren.

### Ohne Docker (Entwicklung)

`tests/integration/local-env.sh up` startet PostgreSQL, Asterisk (aus den Systempaketen) und das Backend lokal (root, Debian/Ubuntu) – siehe Kopfzeile des Skripts; danach `python3 tests/integration/test_pbx.py`.

## Was nicht automatisch getestet wird

Echte Tischtelefone/Smartphones, echte SIP-Anbieter, SIP-TLS, Proxmox-spezifische Konfiguration, NAT über Netzgrenzen, ARM-Architektur. Siehe README → *Bekannte Grenzen*.

## Dashboard-Rauchtest (Chromium)

```bash
cd tests/integration && npm install
node ui_smoke.js https://<HOST_IP> admin '<Passwort>'
```
Meldet sich über die Oberfläche an, legt eine Nebenstelle über den Dialog an (CSRF-/Origin-Prüfung), prüft die Passwortanzeige, Fehlermeldungen, die Rollenbeschränkung (Rolle „Benutzer“ sieht keine Admin-Bereiche, `/api/users` → 403, schreiben ohne CSRF-Token → 403), die Mobilansicht und dass keine JavaScript-/CSP-Fehler auftreten. Räumt danach auf.
