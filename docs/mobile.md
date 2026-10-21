# Handy-Telefonie von überall (App + VPN)

Die Telefonanlage ist absichtlich **nicht** aus dem Internet erreichbar. Von unterwegs verbindet sich das Handy per VPN ins Heimnetz und registriert sich dort wie im WLAN. Dieselbe Anleitung steht im Dashboard unter **Handy-App**.

## Apps (Vorschläge, nicht getestet)
Linphone (Empfehlung, kostenlos, Android/iOS), Zoiper, Groundwire (iOS, kostenpflichtig). Beliebige SIP-Apps funktionieren mit den Daten aus *Nebenstellen → Verbindung*: Server, Benutzername, Passwort, Port 5060 UDP/TCP, Codec G.711.

## VPN mit Tailscale (nicht getestet)
1. Auf dem Server/Proxmox-Host: `tailscale up --advertise-routes=<HOST_IP>/32` (HOST_IP = LAN-Adresse der Anlage).
2. Route im Tailscale-Adminbereich genehmigen.
3. In `/opt/mosi/.env`:
   ```
   SIP_ALLOWED_NETS=192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,100.64.0.0/10
   ADMIN_ALLOWED_NETS=private_ranges 100.64.0.0/10
   ```
   dann `docker compose up -d`.
4. Handy: Tailscale-App installieren, anmelden, aktivieren; SIP-App mit Server = `<HOST_IP>`.

Alternative: WireGuard (Beispiel `config/wireguard/wg0.conf.example`). Energiesparmodus für die SIP-App ausschalten; es gibt keine Push-Benachrichtigungen, die App muss im Hintergrund registriert bleiben.
