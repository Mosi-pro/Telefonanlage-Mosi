# Betrieb: Backup, Wiederherstellung, Update, Deinstallation, Logs

Alle Befehle im Installationsverzeichnis (z. B. `/opt/mosi`) in der VM/dem Container.

## Gesundheitsprüfung

```bash
./healthcheck.sh            # Exit-Code 0 = alles in Ordnung; --wait 120 wartet bis zu 120 s; --quiet für Skripte/Monitoring
```
Geprüft werden (jeweils real): PostgreSQL (`pg_isready` + Schema), Asterisk (Konsolenbefehl), geladene SIP-Transporte, Backend-API inkl. Verbindung zu Asterisk, HTTPS-Proxy → Backend.
Das Dashboard (*Systemstatus*) zeigt zusätzlich SIP-UDP-OPTIONS, WebSocket, CDR-Import, Konfigurationszustand, Speicherplatz.
Docker-Healthchecks (`docker compose ps`) laufen für `db`, `asterisk` und `app` zusätzlich.

## Backup

```bash
./backup.sh                      # nach ./backups
./backup.sh /mnt/nas/mosi        # anderes Ziel
```
Enthalten: Datenbank (`pg_dump`), generierte Asterisk-Konfiguration, Voicemail, IVR-Ansagen, Zertifikats-CA (Caddy), `.env`, Prüfsummen und Manifest in **einer** Datei `mosi-backup-<Datum>.tar.gz` (Rechte 600).
**Das Archiv enthält Geheimnisse** – verschlüsselt und getrennt vom Server aufbewahren. Nichts wird automatisch gelöscht; richten Sie eine Aufbewahrung ein, z. B. täglich per Cron:
```cron
15 3 * * *  cd /opt/mosi && ./backup.sh /mnt/nas/mosi >/var/log/mosi-backup.log 2>&1 && find /mnt/nas/mosi -name 'mosi-backup-*.tar.gz' -mtime +30 -delete
```
Zusätzlich empfehlenswert: Proxmox-Backup der gesamten VM/des Containers.

## Wiederherstellung

```bash
./restore.sh backups/mosi-backup-20261020-193406.tar.gz            # fragt nach Bestätigung
./restore.sh backups/<datei>.tar.gz --yes                           # ohne Rückfrage
./restore.sh backups/<datei>.tar.gz --with-env --yes                # auf einem NEUEN Server: .env aus dem Backup übernehmen
```
Ablauf: Prüfsummen prüfen → Sicherheitskopie des aktuellen Stands (`backups/pre-restore`) → Dienste stoppen → Datenbank neu aufspielen → Volumes ersetzen → Dienste starten → Healthcheck.
Auf einem neuen Server zuerst Repository klonen und `./install.sh --no-start`, dann `restore.sh --with-env`. Ohne passende `.env` (v. a. `APP_SECRET`) können gespeicherte SIP-Passwörter nicht entschlüsselt werden.

## Update (geordnet)

```bash
./update.sh            # fragt nach Bestätigung;  --yes ohne Rückfrage;  --no-git wenn Sie das Repository selbst aktualisieren;
                       # --skip-build wenn die Images vorab gebaut/geladen wurden (Offline-Update)
```
1. Zustand prüfen, 2. **automatisches Backup** (`backups/pre-update`; ohne Backup kein Update), 3. `git pull --ff-only`, 4. Images neu bauen (`--pull`, Basis-Images sind auf feste Versionen gepinnt), Dienste ersetzen, 5. Healthcheck.
Persistente Daten (Docker-Volumes) werden **nie** gelöscht; Datenbank-Migrationen laufen beim Start des Backends automatisch und versioniert. Schlägt der Healthcheck fehl, nennt das Skript den Rückweg (vorherige Version auschecken, `docker compose up -d --build`, bei Datenproblemen `restore.sh`).

**Versionspflege / Sicherheitswartung:** Die Basis-Images (`debian:12.15-slim`, `node:22.23.3-bookworm-slim`, `postgres:16.15-alpine`, `caddy:2.8.4-alpine`) sind in `telephony/Dockerfile`, `Dockerfile` und `compose.yaml` festgeschrieben, damit Builds reproduzierbar bleiben. Prüfen Sie monatlich auf neue Patch-Versionen (insbesondere Debian-Security-Updates für Asterisk, Node, Caddy, PostgreSQL), passen Sie die Tags an und führen Sie `./update.sh --no-git` aus. `docker compose build --pull` zieht Debian-Sicherheitsupdates der Pakete in den Telefonie-Container (apt-Schicht wird beim Neubau aktualisiert, wenn der Cache nicht greift: `docker compose build --no-cache asterisk`).

## Neustart / Dienste

```bash
docker compose restart asterisk    # Engine neu starten: Konfiguration bleibt, Geräte registrieren sich neu, Backend gleicht ab
docker compose restart app
docker compose down && docker compose up -d     # alle Dienste (Daten bleiben)
```
Nach einem Neustart der VM/des Containers starten alle Dienste selbst (`restart: unless-stopped`).

## Logs

* Strukturiert (JSON, eine Zeile pro Ereignis): `docker compose logs -f app`
* Asterisk: `docker compose logs -f asterisk`; Asterisk-Konsole: `docker compose exec asterisk asterisk -rvvv`
* Dashboard: *Systemstatus* (Ereignisse, Konfigurationsänderungen) und *Einstellungen* (Audit-Log)
* Anrufdaten: Dashboard *Anrufe* bzw. Tabelle `calls`. Aufbewahrung `CALL_RETENTION_DAYS`.
* Docker-Logrotation: in `/etc/docker/daemon.json` z. B. `{"log-driver":"local","log-opts":{"max-size":"20m","max-file":"5"}}` setzen.

## Deinstallation

```bash
./uninstall.sh            # stoppt/entfernt Container; Daten, .env und Backups bleiben (Neustart per ./install.sh)
./uninstall.sh --purge    # löscht zusätzlich Datenbank, Voicemail, Konfiguration, Zertifikats-CA und lokale Images (Backup-Angebot + Eingabe "LOESCHEN")
```
Übrig bleiben `.env`, `backups/`, `certs/` und das Repository (von Hand löschen). Docker selbst wird nicht entfernt. Die VM/der Container kann danach in Proxmox gelöscht werden.

## Administrator-Passwort vergessen

```bash
docker compose exec app node -e "
const bcrypt=require('bcryptjs');const {Pool}=require('pg');
const pw=process.argv[1];(async()=>{const p=new Pool({connectionString:process.env.DATABASE_URL});
await p.query('UPDATE users SET password_hash=\$1, failed_logins=0, locked_until=NULL WHERE username=\$2',[await bcrypt.hash(pw,12),'admin']);
await p.end();console.log('ok')})()" 'NeuesSicheresPasswort-123'
```
(Das Passwort steht danach in der Shell-Historie – anschließend im Dashboard ändern.)
