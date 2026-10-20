# Fehlerdiagnose

Erster Schritt immer: `./healthcheck.sh` und `docker compose ps` / `docker compose logs --tail=100`.

## Installation

| Symptom | Ursache / Lösung |
|---|---|
| „Dies scheint der Proxmox-VE-HOST zu sein“ | `install.sh` wurde auf dem Host gestartet. In VM/LXC ausführen. |
| „Docker ist nicht installiert“ | `./install.sh --install-docker` (Debian/Ubuntu, root) oder Docker laut docs.docker.com installieren |
| „Der Docker-Dienst ist nicht erreichbar“ | `systemctl status docker`; Benutzer in Gruppe `docker` oder root verwenden |
| LXC: Container startet nicht / `permission denied` / `sysctl` | Features **nesting** und **keyctl** fehlen (Proxmox → Container → Optionen → Features); Container neu starten; sonst VM nutzen |
| Build: `Could not resolve 'deb.debian.org'` / npm-Fehler | Kein Internet/DNS in der VM. `ping deb.debian.org`, DNS-Server prüfen; Proxy: Docker-Proxy-Einstellungen (`/etc/systemd/system/docker.service.d/`) |
| `429 Too Many Requests` beim Image-Download | Docker-Hub-Rate-Limit: später erneut oder `docker login` |
| Port 443/80/5060 belegt | Anderen Dienst beenden oder `HTTPS_PORT`/`HTTP_PORT`/`SIP_PORT` in `.env` ändern |
| `.env ist unvollständig` | Fehlende Schlüssel aus `.env.example` ergänzen |

## Dashboard / Zugriff

| Symptom | Lösung |
|---|---|
| Browser: Zertifikatswarnung | Normal bei lokaler CA; Root-Zertifikat installieren (`docs/network.md`) oder eigenes Zertifikat |
| „Zugriff nur aus dem lokalen Netz oder über VPN“ (403) | Ihre Adresse liegt nicht in `ADMIN_ALLOWED_NETS` → in `.env` ergänzen, `docker compose up -d proxy` |
| Anmeldung „Konto vorübergehend gesperrt“ | 5 Fehlversuche; 15 min warten oder Admin: *Benutzer → Bearbeiten → Sperre aufheben* |
| Erstpasswort verloren | steht (falls nicht entfernt) in `.env` als `ADMIN_PASSWORD`; sonst `docs/operations.md` → Passwort vergessen |
| Dashboard zeigt „Telefonie-Engine nicht erreichbar“ | `docker compose logs asterisk`; AMI-Geheimnis in `.env` geändert? Dann `docker compose up -d --force-recreate asterisk app` |
| Änderung wird abgelehnt: „Asterisk hat die Konfiguration nicht vollständig übernommen …“ | Die alte Konfiguration bleibt aktiv. Meldung nennt fehlende Endpunkte/Kontexte; Details unter *Systemstatus → Konfigurationsänderungen → Dateien* und `docker compose logs asterisk` |
| „Rufnummer ist doppelt vergeben“ | Nebenstellen, Rufgruppen, Queues und Menüs teilen sich einen Nummernraum |

## SIP-Registrierung schlägt fehl

1. *Nebenstellen → Verbindung / Diagnose*: „Letzter Fehler“ lesen (Tabelle in `docs/phones.md`).
2. Erreicht das Gerät die Anlage? Vom Gerätenetz: `nc -vzu <HOST_IP> 5060` bzw. Telefon-Diagnose. *Netzwerk und Sicherheit* zeigt, ob SIP in der Anlage antwortet.
3. Live in Asterisk beobachten: `docker compose exec asterisk asterisk -rx "pjsip set logger on"` und `docker compose logs -f asterisk` (danach `pjsip set logger off`).
4. Häufig: falscher Benutzername (nicht die Durchwahl, wenn abweichend), Passwort mit Leerzeichen kopiert, Netz nicht in `SIP_ALLOWED_NETS`, Firewall blockiert UDP 5060, Gerät nutzt TLS ohne aktivierte TLS-Option.

## Kein oder einseitiges Audio

* RTP-Portbereich (`RTP_START`–`RTP_END`/udp) muss vom Gerät zur `HOST_IP` erreichbar sein (Firewall/VLAN).
* Wenn Telefone in einem anderen Subnetz liegen: dieses in `SIP_ALLOWED_NETS`; Routing zwischen Subnetz und Anlage prüfen.
* Beim Trunk: Anbieter-RTP erreicht die Anlage nicht → NAT/Firewall (`docs/trunk.md`, `docs/network.md`).
* Codec-Konflikte: Geräte auf G.711 A-law/µ-law stellen. `docker compose exec asterisk asterisk -rx "rtp set debug on"` zeigt, ob Pakete kommen/gehen.
* Test: `*43` wählen (Echo-Test): hören Sie Ihre eigene Stimme, funktioniert der Medienpfad in beide Richtungen.

## Browsertelefon

| Meldung | Lösung |
|---|---|
| „HTTPS erforderlich“ | Seite über `https://` mit vertrauenswürdigem Zertifikat öffnen |
| „Mikrofon verweigert / nicht gefunden“ | Berechtigung in der Adressleiste erlauben; Gerät anschließen; anderes Programm schließen |
| „Registrierung fehlgeschlagen … Zugangsdaten“ | Nebenstelle hat Browsertelefonie aktiviert? Passwort kürzlich erneuert? Seite neu laden |
| „Verbindung zum Server fehlgeschlagen“ | `/ws` nicht erreichbar: `docker compose logs proxy asterisk`; Netz in `ADMIN_ALLOWED_NETS`? |
| „WebRTC Error … ICE/DTLS“ | Medienpfad blockiert: UDP-RTP-Bereich zur `HOST_IP`; über NAT: VPN oder STUN/TURN (`docs/network.md`) |
| Anruf klingelt nicht im Browser | Tab geschlossen/Browser im Standby; nur geöffneter Tab empfängt Anrufe |

## SIP-Trunk

* Status „Registrierung abgelehnt“: Benutzername/Passwort/Registrar/Domain prüfen (`auth_username` falls der Anbieter einen anderen verlangt).
* Status „pending/Unregistered“: Anbieter nicht erreichbar (DNS, Firewall ausgehend, Transport).
* Ausgehend scheitert: Nebenstelle „extern“ berechtigt? Regel-Muster passt? Kanal-Limit? Sperrpräfix? Nummernformat (strip/prepend) wie vom Anbieter erwartet?
* Eingehend kommt nicht an: Rufnummer exakt wie vom Anbieter gesendet eingetragen? Absenderadresse des Anbieters unter „Eingehende Absender“ aufgeführt? (`docker compose exec asterisk asterisk -rx "pjsip set logger on"` zeigt die ankommende INVITE.)

## Daten

* Anrufliste leer, obwohl telefoniert wurde: *Systemstatus → Anrufprotokoll-Import*; `docker compose logs app | grep CDR`; Datei `/var/log/asterisk/cdr-custom/Mosi.csv` im Asterisk-Container vorhanden?
* Voicemail: Nebenstelle „Voicemail aktiv“? PIN in den Verbindungsdaten; Abfrage am Telefon mit `*97`.
* Nach `restore.sh` Fehler beim Entschlüsseln: `.env` passt nicht zu den Daten → `--with-env` verwenden.
