# Externe Telefonie: SIP-Trunk eines Anbieters

**Ohne SIP-Trunk (oder einen anderen Telefoniedienst) sind keine Gespräche ins öffentliche Telefonnetz und keine Anrufe von außen möglich.**
Mosi enthält keine Zugangsdaten und keine Rufnummern – Sie benötigen einen eigenen Vertrag bei einem SIP-Anbieter.

## Was Sie vom Anbieter brauchen

Registrar/Server (ggf. Port, Outbound-Proxy), SIP-Benutzername und Passwort (bzw. bei IP-Authentifizierung: Ihre feste öffentliche IP), Transport (UDP/TCP/TLS), Ihre Rufnummern, das erwartete Nummernformat (national `030…`, international `+4930…` oder `004930…`), Liste der Adressen, von denen eingehende Anrufe kommen, und die **Ausgabenlimits** (dort ebenfalls setzen!).

## Einrichtung im Dashboard (*Rufnummern und SIP-Trunks*)

1. **SIP-Trunk anlegen:** Name, Anmeldeverfahren (*Registrierung* oder *IP-Authentifizierung*), Registrar, Benutzername/Passwort, Transport, optional Outbound-Proxy, SIP-Domain, **Eingehende Absender** (IP/Host-Liste – die Anlage nimmt Trunk-Anrufe nur von diesen Adressen ohne Passwort an; Standard ist der Registrar, viele Anbieter rufen jedoch von weiteren Adressen aus), max. gleichzeitige Gespräche, Standard-Absenderrufnummer, Rufnummernübermittlung (Anbieterkonto / From / P-Asserted-Identity).
2. Status auf der Karte: *Registriert*, *Registrierung abgelehnt (Zugangsdaten prüfen)* usw. (live aus Asterisk, `PJSIPShowRegistrationsOutbound`).
3. **Eingehende Rufnummer** hinzufügen (genau so, wie der Anbieter sie als Ziel sendet; die Variante ohne `+` wird automatisch mitbedient) → Ziel (Nebenstelle, Rufgruppe, Queue, IVR, Voicemail) und optional Zeitplan mit Ziel „geöffnet“/„geschlossen“.
4. **Ausgehende Regeln** hinzufügen: Wahlmuster (Asterisk-Syntax), Klasse, Ziffern entfernen/voranstellen. Vorlagen für Deutschland sind im Dialog abrufbar (Festnetz `_0[2-9]X.`, Mobil `_01[567]X.`, Ausland `_00[1-9]X.`, Notruf `_112`/`_110`).
5. In *Nebenstellen* pro Nebenstelle **„darf extern telefonieren“** aktivieren (Standard: aus), „Ausland“ nur bei Bedarf, ggf. ausgehende Rufnummer wählen (nur Nummern Ihrer Trunks erlaubt).

## Schutz vor Telefonbetrug (eingebaut)

* Ausgehend wählbar ist **nur**, was eine Regel erlaubt **und** wofür die Nebenstelle berechtigt ist; Ausland erfordert eigene Freigabe.
* **Sperrpräfixe** (Standard: 0900, 0137, 0138, 0180, 0190, 0700, 118) gelten immer – editierbar unter *Einstellungen*.
* Limit gleichzeitiger externer Gespräche je Nebenstelle und je Trunk.
* Absendernummer kann nicht frei gewählt werden (nur Nummern der Trunks, sonst Trunk-Standard) – kein Nummern-Spoofing.
* Weiterleitungen auf externe Nummern erfordern die externe Berechtigung der weiterleitenden Nebenstelle; Weiterleitungsschleifen werden abgebrochen.
* Zusätzlich beim **Anbieter** Kreditlimit, Länder-Sperren und Sonderrufnummern-Sperre aktivieren.

## Hinweise

* Mosi wurde nur gegen einen **simulierten** Anbieter getestet (IP-Authentifizierung, Ein-/Ausgang, Zeitplan). Registrierung, TLS, Nummernformate und Besonderheiten Ihres Anbieters müssen Sie verifizieren; Anpassungsbedarf ist möglich.
* NAT: Die Anlage meldet im SDP die LAN-Adresse (`HOST_IP`). Anbieter mit symmetrischem RTP („Comedia“) funktionieren damit meist hinter einem NAT-Router. Andernfalls Portweiterleitung des RTP-Bereichs (nur von den Anbieteradressen) bzw. öffentliche Adresse – siehe `docs/network.md`.
* **Notrufe:** Verfügbarkeit, Rufnummernzuordnung und Standortübermittlung über VoIP-Anbieter sind eingeschränkt oder nicht garantiert. Regel „Notruf“ nur anlegen, wenn Ihr Anbieter Notrufe unterstützt und Sie die Adresse hinterlegt haben.
* Anrufaufzeichnung ist nicht implementiert (standardmäßig aus); Gesprächsaufzeichnung unterliegt gesetzlichen Vorgaben (Einwilligung, § 201 StGB, DSGVO).
