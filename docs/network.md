# Netzwerk, Firewall, HTTPS, NAT, VPN

## Ports

| Richtung | Port | Protokoll | Zweck | Wer darf zugreifen |
|---|---|---|---|---|
| Client → Mosi | 443 | TCP | Dashboard + WebRTC-Signalisierung (`/ws`) | LAN/VPN (`ADMIN_ALLOWED_NETS`) |
| Client → Mosi | 80 | TCP | Weiterleitung auf HTTPS | LAN/VPN |
| Gerät → Mosi | 5060 | UDP + TCP | SIP | LAN/VPN (`SIP_ALLOWED_NETS`, zusätzlich Asterisk-ACL) |
| Gerät → Mosi | 5061 | TCP | SIP-TLS (nur mit `SIP_TLS_ENABLED=true` + `compose.tls.yaml`) | LAN/VPN |
| Gerät/Browser ↔ Mosi | 10000–10099 | UDP | RTP/SRTP-Sprache (2 Ports/Gespräch) | LAN/VPN |
| Mosi → Anbieter | 5060/5061 (je nach Anbieter) | UDP/TCP/TLS | Trunk-Signalisierung | ausgehend |
| Anbieter ↔ Mosi | RTP-Bereich | UDP | Sprache des Trunks | nur Anbieter-Adressen |

**Nicht veröffentlicht** (nur Docker-intern): PostgreSQL 5432, Asterisk-AMI 5038, Asterisk-HTTP 8088, Backend 3000.

Das Dashboard zeigt unter *Netzwerk und Sicherheit* die tatsächlich konfigurierten Adressen und Ports sowie echte Erreichbarkeitsprüfungen (SIP-OPTIONS, TCP, WebSocket).

## Firewall-Empfehlungen

* Proxmox-Firewall (VM/LXC) oder Router: **eingehend nur aus LAN/VPN** auf die Ports oben.
* **Niemals** SIP (5060), RTP oder 443 für `0.0.0.0/0` freigeben. SIP-Scanner im Internet probieren Passwörter binnen Minuten.
* Für einen externen SIP-Trunk benötigen Sie in der Regel **keine** eingehende Portfreigabe, wenn sich die Anlage beim Anbieter registriert und der Anbieter symmetrisches RTP unterstützt (Mosi nutzt `rtp_symmetric`, `force_rport`). Wenn Ihr Anbieter eingehende Verbindungen verlangt, erlauben Sie ausschließlich **dessen** veröffentlichte Adressen.
* Beispiel für eine Host-Firewall: `config/nftables/mosi.nft.example`. Hinweis: Docker setzt eigene Regeln – wirksam ist die Firewall am Rand (Router/Proxmox).
* `BIND_IP` in der `.env` bindet die veröffentlichten Ports an eine bestimmte Host-Adresse.

## HTTPS und Zertifikate

Browser erlauben **Mikrofonzugriff (Browsertelefon) nur über HTTPS mit vertrauenswürdigem Zertifikat** (oder `localhost`).

**Option A – lokale CA (Standard, `MOSI_TLS=internal`):** Caddy erzeugt eine eigene Zertifizierungsstelle. Beim ersten Aufruf warnt der Browser. Root-Zertifikat exportieren und in den Browsern/Betriebssystemen der Nutzer als vertrauenswürdig installieren:
```bash
docker compose cp proxy:/data/caddy/pki/authorities/local/root.crt ./mosi-root-ca.crt
```
Das Zertifikat stammt aus Ihrer Installation – geben Sie es nur an vertrauenswürdige Geräte weiter. (Die CA liegt im Volume `caddy_data`, `backup.sh` sichert sie.)

**Option B – eigenes Zertifikat (z. B. Firmen-CA oder Let's-Encrypt über Ihren DNS-Provider):** Dateien nach `certs/fullchain.pem` und `certs/privkey.pem` legen und in `.env` setzen:
```
MOSI_HOSTNAME=pbx.example.lan
MOSI_TLS=/certs/fullchain.pem /certs/privkey.pem
```
`docker compose up -d proxy`. Der Hostname muss zum Zertifikat passen. Zertifikate und Schlüssel gehören **nicht** ins Git (`.gitignore` schließt `certs/`, `*.pem`, `*.key` aus).

**SIP-TLS (optional):** `certs/sip-cert.pem` + `certs/sip-key.pem` ablegen (Verzeichnis `certs/` mit Rechten 755; Schlüssel für die Asterisk-Benutzer-ID lesbar machen: `sudo chown 10001:10001 certs/sip-key.pem && chmod 600 certs/sip-key.pem`), `SIP_TLS_ENABLED=true`, `docker compose up -d` (die Skripte binden `compose.tls.yaml` automatisch ein). Endgeräte müssen dem Zertifikat vertrauen.

## WebRTC, NAT, STUN/TURN

* Im **selben LAN/VPN** funktioniert die Browsertelefonie ohne weitere Dienste.
* Über **NAT-Grenzen ohne VPN** (z. B. Browser im Mobilfunknetz, Mosi hinter Router) reicht dies nicht: Medien (UDP 10000–10099) müssten erreichbar sein und der Browser braucht passende ICE-Kandidaten. Einfachste Lösung: **VPN**. Alternativ STUN/TURN-Server betreiben (z. B. coturn) und in `.env` eintragen (`STUN_SERVER`, `TURN_URL`, `TURN_USER`, `TURN_PASSWORD`). Mosi liefert diese Werte an das Browsertelefon; ein TURN-Server wird **nicht** mitgeliefert und wurde **nicht getestet**.
* SIP-Endgeräte hinter NAT außerhalb des LANs werden nicht unterstützt (SIP-Registrierung ist auf `SIP_ALLOWED_NETS` begrenzt) – verwenden Sie VPN.

## VPN für Smartphones

Empfohlen: WireGuard auf Router/Firewall oder eigener VM. Beispiel: `config/wireguard/wg0.conf.example`.
1. VPN-Netz (z. B. `10.99.0.0/24`) liegt in `SIP_ALLOWED_NETS` und `ADMIN_ALLOWED_NETS` (die Standardwerte enthalten `10.0.0.0/8`).
2. Smartphone verbindet das VPN, SIP-App registriert sich gegen die LAN-Adresse der Anlage.
3. Nur die Anlage durch den Tunnel routen (Split-Tunnel: `AllowedIPs = <HOST_IP>/32, <VPN-Netz>`).
4. Smartphone-Energiesparfunktionen für die SIP-App ausschalten, sonst werden Anrufe im Standby nicht zugestellt (Push-Dienste gibt es hier nicht).

## Mehrere Netze / VLANs

Telefone in einem anderen VLAN: das VLAN in `SIP_ALLOWED_NETS` aufnehmen, Firewall-Regeln zwischen den VLANs für SIP + RTP-Bereich erlauben. Medienadresse ist immer `HOST_IP` – sie muss aus allen Telefon-VLANs erreichbar sein.
