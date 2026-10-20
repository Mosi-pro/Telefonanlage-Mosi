# Sicherheitsleitfaden

## Eingebaute Maßnahmen

| Thema | Umsetzung |
|---|---|
| Zugangsdaten | Alle Geheimnisse (Datenbank, App-Schlüssel, AMI, Admin-Passwort) werden bei der Installation zufällig erzeugt (`openssl`), liegen in `.env` (Rechte 600, nicht im Git). SIP-Passwörter: 24 Zeichen zufällig je Nebenstelle |
| Passwörter der Web-Benutzer | bcrypt (Kostenfaktor 12), Mindestlänge 12 + 3 von 4 Zeichenklassen |
| Anmeldeschutz | Rate-Limit je IP (20/15 min), Kontosperre nach 5 Fehlversuchen (15 min, konfigurierbar), gleiche Antwortzeit für unbekannte Benutzer |
| Sitzungen | Zufallstoken (nur der Hash wird gespeichert), Cookie `HttpOnly; SameSite=Strict; Secure`, 12 h Gültigkeit, Abmeldung/Passwortwechsel beendet Sitzungen |
| CSRF | Pflicht-Header `X-CSRF-Token` + Origin-Prüfung bei allen schreibenden Anfragen, SameSite=Strict |
| Rollen | `admin` (alles), `operator` (Nebenstellen/Gruppen/Menüs/Zeitpläne/Geräte/Anrufe, **keine** Trunks, Benutzer, Netzwerk, Einstellungen), `user` (eigene Nebenstelle, Browsertelefon, eigene Anrufe/Voicemail) |
| Injection | Parametrisierte SQL-Abfragen; Eingaben für Asterisk-Konfiguration nur über enge Whitelists (keine Anführungszeichen, `;`, `$`, `,`, Zeilenumbrüche …); Dialplan-Muster nur `[0-9XZN[]-+*#.!]`; keine Shell-Ausführung, AMI nur mit festen Befehlen |
| Geheimnisse in der DB | SIP-/Trunk-Passwörter und Voicemail-PINs AES-256-GCM-verschlüsselt (Schlüssel aus `APP_SECRET`). Achtung: die Asterisk-Konfigurationsdateien im Volume enthalten diese Passwörter zwangsläufig im Klartext (Asterisk benötigt sie) – Volume und Backups schützen |
| Netzwerk | Dashboard nur aus `ADMIN_ALLOWED_NETS`; SIP-Endgeräte nur aus `SIP_ALLOWED_NETS` (Asterisk-ACL für Zugriff und Kontakt-URI); AMI/DB nicht veröffentlicht; **kein anonymer SIP-Zugang**, keine unauthentifizierte Registrierung |
| Telefonbetrug | siehe `docs/trunk.md` (Berechtigungen, Sperrpräfixe, Limits, Ausland aus) |
| Protokolle | Audit-Log (wer hat was wann von welcher IP geändert; inkl. Abruf von Zugangsdaten, Voicemail-Wiedergabe), Konfigurationsrevisionen (Passwörter geschwärzt), Systemereignisse inkl. fehlgeschlagener SIP-Anmeldungen und Angriffshinweis ab 10 Fehlversuchen/10 min je Adresse |
| HTTP-Header | CSP (nur eigene Skripte), HSTS, `frame-ancestors 'none'`, `nosniff`; Inline-Styles werden nur als Attribut erlaubt (`style-src-attr`), Skripte nie inline |
| Datenschutz | Anruflisten werden nach `CALL_RETENTION_DAYS` (Standard 365) gelöscht; keine Aufzeichnung von Gesprächen |

## Was Sie tun müssen

1. Erstpasswort ändern; `ADMIN_PASSWORD` danach aus der `.env` entfernen.
2. Dashboard/SIP/RTP **nie** ins Internet öffnen; Firewall am Rand (`docs/network.md`). Fernzugriff nur per VPN.
3. `.env`, `backups/` und `certs/` wie Passwörter behandeln (Backups enthalten Geheimnisse); verschlüsselt und getrennt aufbewahren.
4. Regelmäßig `./update.sh` (mindestens monatlich) und Betriebssystem-Updates der VM/des Containers.
5. Beim SIP-Anbieter Ausgabenlimits und Sperren setzen. Dashboard-Meldungen zu fehlgeschlagenen SIP-Anmeldungen beachten.
6. Nur Nebenstellen externe Rechte geben, die sie brauchen. Ausland standardmäßig aus lassen.
7. Rechtliche Anforderungen (DSGVO, TKG, Aufbewahrung, Aufzeichnung) in Ihrer Organisation klären.

## Bekannte Grenzen (offen kommuniziert)

* Kein fail2ban-artiges automatisches Sperren fehlgeschlagener SIP-Anmeldungen. Schutz = Netzwerkfilter + starke Passwörter + Überwachung.
* SIP-Signalisierung ist im Standard (UDP/TCP) **unverschlüsselt**; im LAN/VPN akzeptabel, sonst SIP-TLS (ungetestet) bzw. VPN. Medien der SIP-Endgeräte sind nicht verschlüsselt (SRTP nicht aktiviert); Browsertelefonie nutzt DTLS-SRTP.
* `style-src-attr 'unsafe-inline'` ist erlaubt (Inline-`style`-Attribute der Oberfläche).
* Admin-Zugriff wird zusätzlich zu Caddy nicht im Backend auf Netze begrenzt (nur über den Proxy erreichbar).
* Betreiber mit Zugriff auf Docker, `.env` oder das Asterisk-Volume haben Vollzugriff auf alle Zugangsdaten.
* Keine Mehr-Faktor-Authentifizierung.
* Sicherheitsrelevante Funde bitte vertraulich als GitHub-Security-Advisory melden.
