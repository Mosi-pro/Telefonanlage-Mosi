import { h, badge, secretField, table } from '../ui.js';
import { get, state } from '../api.js';

const APPS = [
  { name: 'Linphone', os: 'Android · iOS', why: 'Kostenlos und quelloffen, einfache Einrichtung, gute Sprachqualität. Unsere erste Empfehlung.', how: 'SIP-Konto → „Mit SIP-Konto verbinden“' },
  { name: 'Zoiper', os: 'Android · iOS', why: 'Weit verbreitet, Gratis-Version genügt für Grundfunktionen.', how: 'Account → „Existing account“ → SIP' },
  { name: 'Groundwire', os: 'iOS', why: 'Kostenpflichtig, sehr zuverlässig im Hintergrund auf dem iPhone.', how: 'Konto → „SIP Account“' },
];

export default async function render(el) {
  const exts = await get('/extensions');
  const setup = state.user.role === 'user' ? null : await get('/setup/status').catch(() => null);
  const sel = h('select', { 'aria-label': 'Nebenstelle' }, exts.map((e) => h('option', { value: e.id }, `${e.number} – ${e.display_name}`)));
  const data = h('div', {});
  async function showData() {
    if (!exts.length) { data.replaceChildren(h('div', { class: 'notice' }, 'Es ist noch keine Nebenstelle vorhanden bzw. zugeordnet. Legen Sie zuerst eine an (Einrichtungsassistent).')); return; }
    const c = await get(`/extensions/${sel.value}/connection`);
    data.replaceChildren(h('dl', { class: 'kv' },
      h('dt', {}, 'Server / Domain'), h('dd', {}, h('span', { class: 'mono' }, c.server)),
      h('dt', {}, 'Benutzername'), h('dd', {}, h('span', { class: 'mono' }, c.username)),
      h('dt', {}, 'Passwort'), h('dd', {}, secretField(c.password)),
      h('dt', {}, 'Port / Transport'), h('dd', {}, `${c.transports[0].port} · UDP (oder TCP)`),
      h('dt', {}, 'Codecs'), h('dd', {}, 'G.711 A-law / µ-law')));
  }
  sel.addEventListener('change', showData);

  el.append(
    h('div', { class: 'notice info' }, 'So telefonieren Sie mit dem Handy über Ihre Telefonanlage – auch von unterwegs. Die Anlage selbst bleibt aus Sicherheitsgründen NICHT im offenen Internet; das Handy verbindet sich per VPN ins Heimnetz.'),
    h('div', { class: 'grid cols-3' }, APPS.map((a, i) => h('div', { class: 'card app' },
      h('h2', {}, a.name, ' ', i === 0 ? badge('Empfehlung', 'accent') : null), h('div', { class: 'muted' }, a.os), h('p', {}, a.why), h('p', { class: 'muted' }, `Einrichtung: ${a.how}`)))),
    h('p', { class: 'muted' }, 'Hinweis: Diese Apps sind Vorschläge von Drittanbietern; sie wurden mit dieser Anlage nicht getestet. Bedienung und Menünamen können sich ändern.'),
    h('div', { class: 'card' }, h('h2', {}, '1. Verbindungsdaten für die App'), h('div', { class: 'field' }, h('label', {}, 'Nebenstelle'), sel), data),
    h('div', { class: 'card' }, h('h2', {}, '2. Von überall telefonieren: VPN einrichten'),
      h('p', {}, 'Empfohlen: ', h('b', {}, 'Tailscale'), ' (kostenloser Tarif für Privatnutzer, einfach) oder WireGuard. So geht es mit Tailscale:'),
      h('ol', {},
        h('li', {}, 'Auf dem Server/Proxmox-Host Tailscale installieren und mit Ihrem Konto verbinden, dabei die Adresse der Anlage als Subnetz freigeben:', h('pre', { class: 'code' }, `tailscale up --advertise-routes=${state.hostName}/32`)),
        h('li', {}, 'Im Tailscale-Adminbereich (login.tailscale.com → Machines) die freigegebene Route genehmigen.'),
        h('li', {}, 'In ', h('code', {}, '/opt/mosi/.env'), ' das Tailscale-Netz erlauben und neu starten:', h('pre', { class: 'code' }, 'SIP_ALLOWED_NETS=192.168.0.0/16,10.0.0.0/8,172.16.0.0/12,100.64.0.0/10\nADMIN_ALLOWED_NETS=private_ranges 100.64.0.0/10\n\ncd /opt/mosi && docker compose up -d')),
        h('li', {}, 'Auf dem Handy die Tailscale-App installieren, mit demselben Konto anmelden und aktivieren.'),
        h('li', {}, `In der SIP-App als Server ${state.hostName} eintragen (wie oben). Solange Tailscale aktiv ist, funktioniert das Telefonieren in beide Richtungen von jedem Netz aus.`)),
      h('p', { class: 'muted' }, 'Nicht getestet: Dieser Weg folgt der Tailscale-Dokumentation, wurde aber nicht mit dieser Anlage ausprobiert. Bei Problemen: Dokument docs/mobile.md und Fehlerdiagnose. Tipp: Energiesparmodus für die SIP-App ausschalten, sonst klingelt das Handy im Standby nicht.')));
  await showData();
}
