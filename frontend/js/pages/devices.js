import { h, table, badge, fmtTime } from '../ui.js';
import { get } from '../api.js';
import { crudPage } from './crud.js';

const KIND = { deskphone: 'Tischtelefon', softphone: 'Softphone', mobile: 'Smartphone-App', webrtc: 'Browser', other: 'Sonstiges' };

export default async function render(el) {
  const live = h('div', {});
  el.append(h('div', { class: 'card' }, h('h2', {}, 'Aktuell registrierte SIP-Kontakte (live aus der Telefonie-Engine)'), live),
    h('div', { class: 'notice info' }, 'Ein Gerät wird nicht allein durch das Einstecken des Netzwerkkabels zu einem SIP-Telefon: Es muss mit Serveradresse, Benutzername und Passwort einer Nebenstelle eingerichtet werden (siehe Nebenstellen → Verbindung). Das Geräteinventar unten dient der Dokumentation.'));
  const exts = await get('/extensions');
  const rows = exts.flatMap((e) => (e.registration.contacts || []).map((c) => ({ ext: e, c })));
  live.replaceChildren(table([
    { label: 'Nebenstelle', render: (r) => `${r.ext.number} – ${r.ext.display_name}` },
    { label: 'Art', render: (r) => badge(r.c.web ? 'Browser' : 'SIP-Gerät', r.c.web ? 'accent' : '') },
    { label: 'Gerät / Software', render: (r) => r.c.userAgent || 'unbekannt' },
    { label: 'Adresse', render: (r) => h('span', { class: 'mono' }, r.c.via || r.c.uri) },
    { label: 'Status', render: (r) => badge(r.c.status === 'Unreachable' ? 'nicht erreichbar' : 'erreichbar', r.c.status === 'Unreachable' ? 'err' : 'ok') },
    { label: 'Laufzeit', render: (r) => (r.c.expires != null ? `${r.c.expires} s` : '–') },
  ], rows, { empty: 'Derzeit ist kein Gerät registriert' }));
  const names = exts.map((e) => ({ value: e.id, label: `${e.number} – ${e.display_name}` }));
  await crudPage(el, {
    endpoint: '/devices', noun: 'Gerät',
    columns: [{ label: 'Name', key: 'name' }, { label: 'Art', render: (r) => KIND[r.kind] }, { label: 'Hersteller / Modell', render: (r) => [r.vendor, r.model].filter(Boolean).join(' ') || '–' },
      { label: 'MAC', render: (r) => h('span', { class: 'mono' }, r.mac || '–') },
      { label: 'Nebenstelle', render: (r) => { const e = exts.find((x) => x.id === r.extension_id); return e ? `${e.number} – ${e.display_name}` : '–'; } },
      { label: 'Registrierung', render: (r) => { const e = exts.find((x) => x.id === r.extension_id); return e ? badge(e.registration.state === 'registered' ? 'registriert' : 'nicht registriert', e.registration.state === 'registered' ? 'ok' : 'err') : '–'; } }],
    fields: [{ name: 'name', label: 'Gerätename', required: true, placeholder: 'z. B. Empfang Tischtelefon' },
      { name: 'kind', label: 'Art', type: 'select', options: Object.entries(KIND).map(([value, label]) => ({ value, label })) },
      { name: 'vendor', label: 'Hersteller' }, { name: 'model', label: 'Modell' }, { name: 'mac', label: 'MAC-Adresse', placeholder: 'AA:BB:CC:DD:EE:FF' },
      { name: 'extension_id', label: 'Zugeordnete Nebenstelle', type: 'select', options: [{ value: '', label: '– keine –' }, ...names] },
      { name: 'notes', label: 'Notizen', type: 'textarea' }],
  });
}
