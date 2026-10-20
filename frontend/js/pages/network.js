import { h, table, badge, dot, fmtTime } from '../ui.js';
import { get } from '../api.js';

export default async function render(el) {
  const n = await get('/network');
  el.append(
    h('div', { class: 'card' }, h('h2', {}, 'Konfigurierte Adressen und Ports'),
      h('dl', { class: 'kv' }, h('dt', {}, 'Server-Adresse (für Geräte)'), h('dd', {}, h('span', { class: 'mono' }, n.hostName)), h('dt', {}, 'IP-Adresse des Hosts'), h('dd', {}, h('span', { class: 'mono' }, n.hostIp)),
        h('dt', {}, 'STUN / TURN'), h('dd', {}, [n.stun ? `STUN ${n.stun}` : 'kein STUN', n.turn ? ', TURN konfiguriert' : ', kein TURN'].join(''))),
      table([{ label: 'Dienst', render: (s) => h('strong', {}, s.name) }, { label: 'Port', render: (s) => h('span', { class: 'mono' }, s.port) }, { label: 'Erreichbar für', render: (s) => [s.scope, h('div', { class: 'muted' }, s.allowed)] },
        { label: 'Echte Prüfung', render: (s) => (s.probe.ok === null ? badge(s.probe.detail, '') : h('span', {}, dot(s.probe.ok ? 'ok' : 'err'), s.probe.detail || '')) }], n.services)),
    h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('h2', {}, 'Sicherheitsmaßnahmen (aktiv)'), h('ul', {}, n.security.map((s) => h('li', {}, s)))),
      h('div', { class: 'card' }, h('h2', {}, 'Grenzen – bitte beachten'), h('ul', {}, n.limits.map((s) => h('li', {}, s))))),
    h('div', { class: 'card' }, h('h2', {}, 'Gesperrte Zielpräfixe (Betrugsschutz)'), h('p', {}, n.blockedPrefixes.map((p) => [badge(p, 'warn'), ' '])), h('p', { class: 'muted' }, 'Änderbar unter Einstellungen. Diese Ziele werden auch bei freigegebenen Nebenstellen nie gewählt.')),
    h('div', { class: 'card' }, h('h2', {}, 'Fehlgeschlagene SIP-Anmeldungen (Diagnose)'),
      table([{ label: 'Konto', key: 'sip_username' }, { label: 'Fehler', key: 'last_error' }, { label: 'Zeit', render: (r) => fmtTime(r.last_error_at) }, { label: 'Quelle', key: 'last_error_ip' }], n.registrationFailures, { empty: 'Keine fehlgeschlagenen Anmeldungen aufgezeichnet' }),
      h('p', { class: 'muted' }, 'Viele Fehlversuche von einer Adresse deuten auf einen Angriff oder ein falsch eingerichtetes Gerät hin. Firewall-Regeln: docs/network.md.')));
}
