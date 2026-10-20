import { h, clear, table, badge, dot, fmtTime, fmtDur } from '../ui.js';
import { get } from '../api.js';

const DISPO = { ANSWERED: ['angenommen', 'ok'], 'NO ANSWER': ['nicht angenommen', 'warn'], BUSY: ['besetzt', 'warn'], FAILED: ['fehlgeschlagen', 'err'], CONGESTION: ['nicht erreichbar', 'err'] };
const DIR = { internal: 'intern', inbound: 'eingehend', outbound: 'ausgehend' };

export default async function render(el) {
  const holder = h('div', {}); el.append(holder);
  let timer = null; let busy = false;
  async function load() {
    if (busy || document.hidden) return; busy = true;
    try { draw(holder, await get('/dashboard')); } catch (e) { clear(holder).append(h('div', { class: 'notice err' }, `Dashboard konnte nicht geladen werden: ${e.message}`)); }
    busy = false;
  }
  await load();
  timer = setInterval(load, 5000);   // nur bei sichtbarem Tab, siehe load()
  const vis = () => { if (!document.hidden) load(); };
  document.addEventListener('visibilitychange', vis);
  return () => { clearInterval(timer); document.removeEventListener('visibilitychange', vis); };
}

function stat(label, value, kind = '') { return h('div', { class: `card stat ${kind}` }, h('div', { class: 'num' }, value), h('div', { class: 'lbl' }, label)); }

function draw(el, d) {
  const down = d.services.filter((s) => !s.ok);
  clear(el).append(
    d.externalNotice ? h('div', { class: 'notice' }, h('strong', {}, 'Externe Telefonie: '), d.externalNotice) : null,
    down.length ? h('div', { class: 'notice err', role: 'alert' }, h('strong', {}, 'Dienst gestört: '), down.map((s) => `${s.name} – ${s.detail}`).join(' · ')) : null,
    h('div', { class: 'grid cols-4' },
      stat('Registrierte Geräte', d.devices.registered, d.devices.registered ? 'ok' : ''),
      stat('Nicht registrierte Geräte', d.devices.unregistered, d.devices.unregistered ? 'err' : ''),
      stat('Aktive Gespräche', d.activeCalls.filter((c) => c.bridged).length, 'accent'),
      stat('Anrufe heute', d.stats.total)),
    h('div', { class: 'grid cols-4' },
      stat('Angenommen (heute)', d.stats.answered, 'ok'),
      stat('Verpasst (heute)', d.stats.missed, d.stats.missed ? 'err' : ''),
      stat('SIP-Trunks aktiv', `${d.trunks.filter((t) => t.ok).length} / ${d.trunks.length}`),
      stat('Aktuelle Fehler (24 h)', d.errors.length, d.errors.length ? 'err' : 'ok')),
    h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('h2', {}, 'Dienste (echte Statusabfragen)'),
        table([{ label: 'Dienst', render: (s) => h('span', {}, dot(s.ok ? 'ok' : 'err'), s.name) }, { label: 'Status', render: (s) => h('span', { class: s.ok ? '' : 'badge err' }, s.detail) }], d.services)),
      h('div', { class: 'card' }, h('h2', {}, 'Aktive Gespräche'),
        table([{ label: 'Von', key: 'from' }, { label: 'Nach', key: 'to' }, { label: 'Status', render: (c) => badge(c.state, c.bridged ? 'ok' : 'accent') }, { label: 'Dauer', render: (c) => fmtDur(c.seconds) }], d.activeCalls, { empty: 'Keine aktiven Gespräche' }))),
    h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' }, h('h2', {}, 'Letzte Anrufe'),
        table([{ label: 'Zeit', render: (r) => fmtTime(r.started) }, { label: 'Von', key: 'from' }, { label: 'Nach', key: 'to' },
          { label: 'Art', render: (r) => DIR[r.direction] }, { label: 'Ergebnis', render: (r) => { const x = r.voicemail ? ['Voicemail', 'warn'] : (DISPO[r.disposition] || [r.disposition, '']); return badge(x[0], x[1]); } }], d.recent, { empty: 'Noch keine Anrufe aufgezeichnet' })),
      h('div', { class: 'card' }, h('h2', {}, 'SIP-Trunks'),
        table([{ label: 'Name', key: 'name' }, { label: 'Server', key: 'registrar' }, { label: 'Status', render: (t) => badge(t.state, t.ok ? 'ok' : (t.enabled ? 'err' : '')) }], d.trunks, { empty: 'Kein SIP-Trunk konfiguriert' }),
        h('h2', { style: 'margin-top:1rem' }, 'Aktuelle Systemfehler und Warnungen'),
        table([{ label: 'Zeit', render: (e) => fmtTime(e.ts) }, { label: 'Quelle', key: 'source' }, { label: 'Meldung', key: 'message' }], d.errors, { empty: 'Keine Fehler in den letzten 24 Stunden' }))),
    h('div', { class: 'card' }, h('h2', {}, 'Registrierungsstatus der Nebenstellen'),
      table([{ label: 'Nebenstelle', key: 'number' }, { label: 'Name', key: 'name' }, { label: 'Status', render: (x) => badge(x.registered ? 'registriert' : 'nicht registriert', x.registered ? 'ok' : 'err') }, { label: 'Kontakte', key: 'contacts' }], d.devices.list, { empty: 'Noch keine Nebenstellen angelegt' })));
}
