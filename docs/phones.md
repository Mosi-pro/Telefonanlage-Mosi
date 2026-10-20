# Handy, Tischtelefone und Browsertelefon einrichten

Alle Geräte brauchen **dieselben vier Angaben** aus *Nebenstellen → Verbindung / Diagnose*:

| Feld im Gerät | Wert |
|---|---|
| Server / Registrar / Domain | `HOST_IP` bzw. `MOSI_HOSTNAME` der Anlage |
| Benutzername / SIP-ID / Auth-ID | SIP-Benutzername der Nebenstelle (standardmäßig = Durchwahl) |
| Passwort | das generierte SIP-Passwort (im Dashboard: *Anzeigen/Kopieren*; jeder Abruf wird im Audit-Log protokolliert) |
| Port / Transport | 5060, UDP (oder TCP). TLS nur wenn aktiviert |

Weitere Empfehlungen: Codecs **G.711 A-law/µ-law** (PCMA/PCMU); DTMF **RFC 2833/RFC 4733**; Registrierungsdauer 300–600 s; **kein** STUN/ICE im LAN; „Outbound-Proxy“ leer lassen; Wählregel: interne Nummern direkt, externe wie gewohnt mit Vorwahl.

> Ein Gerät wird nicht dadurch zum SIP-Telefon, dass es per Kabel am Switch steckt. Ein analoges Telefon braucht einen ATA/Gateway, ein normaler PC/Fernseher gar nichts. Nur ein SIP-fähiges Gerät mit obigen Daten registriert sich.

## Smartphone (SIP-App)

1. Eine SIP-App installieren, die „Generic SIP / SIP-Konto“ erlaubt (z. B. Linphone, Zoiper, Groundwire). Das Projekt enthält keinen eigenen SIP-Client; getestet wurde **kein** Smartphone, sondern ein eigener Test-Client – Menübezeichnungen unterscheiden sich je App.
2. Konto anlegen: Benutzername, Passwort, Domain = Serveradresse, Transport UDP/TCP.
3. Im **WLAN**: direkt registrieren. **Von unterwegs**: zuerst VPN verbinden (siehe `docs/network.md`), dann App öffnen. Direkt aus dem Internet ist die Registrierung absichtlich nicht möglich.
4. Energiesparmodus für die App ausnehmen („nicht optimieren“), sonst klingelt es im Standby nicht.

## SIP-Tischtelefone (LAN)

Einrichtung **manuell** über die Weboberfläche des Telefons (IP im Telefon-Menü ablesen). Menünamen ändern sich je Firmware – die Begriffe unten sind typisch:

| Hersteller (Beispiele) | Bereich | Felder |
|---|---|---|
| Yealink | *Account → Register* | Register Name = Auth-ID = Benutzername, Password, SIP Server Host, Port 5060, Transport UDP |
| Snom | *Identity → Login* | Account, Registrar, Authentication Name/Password |
| Grandstream | *Accounts → Account 1 → General* | SIP Server, SIP User ID, Authenticate ID, Authenticate Password |
| Gigaset / Cisco SPA / Fanvil | *SIP-Konto / Line 1* | Proxy/Registrar, Benutzername, Auth-Name, Passwort |

Die Registrierung steht danach im Dashboard unter *Nebenstellen* (Status „registriert“) und *Telefone und Geräte* (Live-Liste mit Hersteller-/Software-Kennung, Adresse, Laufzeit).
Das **Geräteinventar** (Seite *Telefone und Geräte*) dient der Dokumentation (Name, MAC, Zuordnung). Automatische Provisionierung (Autoprovisioning) ist **nicht implementiert**.

## Browsertelefon (WebRTC)

1. Dashboard per **HTTPS mit vertrauenswürdigem Zertifikat** öffnen (`docs/network.md` → HTTPS).
2. Menü *Browsertelefon*: eigene Nebenstelle wählen (Benutzer sehen nur ihnen zugeordnete Nebenstellen; Administratoren alle). Status „registriert“ abwarten.
3. Nummer eintippen/Tastatur → *Anrufen*. Eingehende Anrufe klingeln im geöffneten Tab (*Annehmen/Auflegen*). Während des Gesprächs: Stumm, Tastentöne (DTMF), Dauer.
4. Fehlertexte: „Mikrofon verweigert/nicht gefunden“, „Registrierung fehlgeschlagen (Zugangsdaten)“, „HTTPS erforderlich“, SIP-Fehlercodes mit Klartext.

Der Tab muss geöffnet bleiben, um Anrufe zu empfangen (kein Push). Für dauerhafte Erreichbarkeit nutzen Sie ein Tischtelefon oder eine App.

## Diagnose fehlgeschlagener Registrierungen

*Nebenstellen → Verbindung / Diagnose* zeigt Status, Gerätekennung, Adresse und den **letzten Fehler** mit Zeit und Quelladresse:

| Meldung | Bedeutung / Abhilfe |
|---|---|
| „Falsches SIP-Passwort“ | Passwort im Gerät prüfen (Groß/Klein, Leerzeichen); ggf. Passwort erneuern und neu eintragen |
| „Unbekannter SIP-Benutzer“ | Benutzername im Gerät stimmt nicht mit dem SIP-Benutzernamen überein (steht bei der Nebenstelle) |
| „Zugriff durch Netzwerkfilter blockiert“ | Gerät liegt nicht in `SIP_ALLOWED_NETS` (z. B. anderes VLAN/VPN-Netz) → in `.env` ergänzen, `docker compose up -d` |
| keine Meldung, Gerät nicht registriert | Gerät erreicht die Anlage nicht: Adresse/Port/Firewall/VPN prüfen; *Netzwerk und Sicherheit* zeigt, ob SIP-UDP in der Anlage antwortet |
| „registriert, nicht erreichbar“ | Registrierung existiert, aber die Anlage erreicht das Gerät nicht (NAT/Firewall/Gerät offline) |
