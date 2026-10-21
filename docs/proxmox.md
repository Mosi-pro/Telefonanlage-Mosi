# Installation auf Proxmox VE

**Empfehlung:** Mosi in einer **VM** oder einem **LXC-Container** betreiben, dann bleibt der Host unverändert.
**Direkt auf dem Host** geht ebenfalls: `./install.sh --install-docker --allow-proxmox-host` (ohne das Flag bricht `install.sh` auf einem Proxmox-Host ab). Dabei werden Docker-Pakete auf dem Host installiert und Docker setzt iptables-Regeln; nicht getestet.

## Weg 1 (empfohlen): kleine virtuelle Maschine

Vorteile: Docker, Netzwerk (UDP-Ports, Conntrack), WebRTC und Updates verhalten sich wie auf einem normalen Linux-Server.

1. Debian-12-Cloud-Image bzw. ISO bereitstellen. In Proxmox: *VM erstellen* – 2 vCPU, 2 GB RAM, 16 GB Disk, Netzwerk `vmbr0` (gleiches LAN wie Ihre Telefone), **CPU-Typ `host`**, QEMU-Guest-Agent aktivieren.
2. Debian installieren (nur „SSH-Server“ + Standard-Systemwerkzeuge). Feste IP vergeben bzw. im Router reservieren.
3. In der VM als root:
   ```bash
   apt-get update && apt-get install -y git curl openssl ca-certificates
   git clone https://github.com/Mosi-pro/Telefonanlage-Mosi.git /opt/mosi && cd /opt/mosi
   ./install.sh --install-docker
   ```
4. VM bei Proxmox auf **„Start at boot“** setzen. Nach einem Neustart der VM startet Docker die Dienste automatisch (`restart: unless-stopped`).

## Weg 2: unprivilegierter LXC-Container

LXC teilt den Kernel mit dem Host; Docker darin funktioniert, braucht aber zwei Features. Wenn Docker/Netzwerk/WebRTC im LXC nicht zuverlässig laufen, nehmen Sie Weg 1.

1. Container aus Debian-12-Template erstellen: **Unprivileged = ja**, 2 Kerne, 2 GB RAM, 16 GB Disk, feste IP im LAN.
2. Container → *Optionen → Features*: **Nesting** und **keyctl** aktivieren (entspricht `features: nesting=1,keyctl=1`, siehe `config/proxmox/lxc-docker.conf.example`). Container neu starten.
3. Im Container (Konsole) wie bei Weg 1 `git clone … && ./install.sh --install-docker`.
4. Typische Stolpersteine:
   * `docker: Error response ... permission denied`/`sysctl`-Fehler → Features aus Schritt 2 fehlen.
   * Sehr alte Proxmox-/Kernelversionen oder AppArmor-Profile können Docker blockieren → VM verwenden.
   * Docker-Overlay-Dateisystem auf ZFS-Subvolumes: bei Fehlern `fuse-overlayfs` oder (einfacher) VM verwenden.

## Prüfen, ob alles läuft

```bash
cd /opt/mosi
./healthcheck.sh                 # jede Zeile ist eine echte Abfrage
docker compose ps
```

Dann im Browser `https://<IP>` öffnen. Weiter: README → *Erste Schritte nach der Installation*.

## Firewall

Aktivieren Sie die **Proxmox-Firewall** für die VM/den Container und erlauben Sie nur die in `docs/network.md` genannten Ports aus Ihrem LAN/VPN. Veröffentlichen Sie weder SIP noch RTP noch das Dashboard im Internet.

## Updates der VM

Betriebssystem-Updates (`apt upgrade`) und Docker-Updates regelmäßig einspielen. Mosi selbst: `./update.sh`.

## Hinweis: RTP-Portbereich und Docker-Proxy-Prozesse

Docker startet standardmäßig pro veröffentlichtem Port einen eigenen `docker-proxy`-Prozess. Der Standard-RTP-Bereich (`10000–10099`, ca. 50 gleichzeitige Gespräche) erzeugt daher rund 100 kleine Prozesse. Wählen Sie `RTP_START`/`RTP_END` nicht größer als nötig.
Optional lässt sich das Verhalten in `/etc/docker/daemon.json` mit `{"userland-proxy": false}` auf reine iptables-Weiterleitung umstellen (Docker neu starten); dann gelten die Einschränkungen aus der Docker-Dokumentation (z. B. Zugriff von der Docker-Host-Maschine auf ihre eigene veröffentlichte Adresse). Das wurde im Projekt nicht getestet.
