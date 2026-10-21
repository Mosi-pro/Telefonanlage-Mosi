import { h, table, badge, dot, fmtTime, dialog } from '../ui.js';
import { get } from '../api.js';
import { state } from '../api.js';

export default async function render(el) {
  const holder = h('div', {});
  el.append(holder);
  let timer; let busy = false;
  async function load() {
    if (busy || document.hidden) return; busy = true;
    try {
      const s = await get('/status');
      holder.replaceChildren(
        h('div', { class: 'card' }, h('h2', {}, 'Dienste'),
          table([{ label: 'Dienst', render: (x) => h('span', {}, dot(x.ok ? 'ok' : 'err'), x.name) }, { label: 'Zustand', render: (x) => badge(x.ok ? 'in Ordnung' : 'gestört', x.ok ? 'ok' : 'err') }, { label: 'Details', key: 'detail' }], s.services),
          h('p', { class: 'muted' }, `Backend ${s.version} · Node ${s.node} · Laufzeit ${Math.floor(s.uptimeSeconds / 60)} min. Jede Zeile ist eine echte Abfrage zum Zeitpunkt des Ladens.`)),
        h('div', { class: 'card' }, h('h2', {}, 'Konfigurationsänderungen (Telefonie)'),
          table([{ label: 'Zeit', render: (r) => fmtTime(r.ts) }, { label: 'Benutzer', key: 'username' }, { label: 'Anlass', key: 'reason' }, { label: 'Ergebnis', render: (r) => (r.ok ? badge('übernommen', 'ok') : badge('abgelehnt', 'err')) }, { label: 'Fehler', key: 'error' },
            ...(state.user.role === 'admin' ? [{ label: '', render: (r) => h('button', { class: 'small', onClick: () => showRev(r.id) }, 'Dateien') }] : [])], s.revisions)),
        h('div', { class: 'card' }, h('h2', {}, 'Systemereignisse'),
          table([{ label: 'Zeit', render: (e) => fmtTime(e.ts) }, { label: 'Stufe', render: (e) => badge(e.level, e.level === 'error' ? 'err' : e.level === 'warning' ? 'warn' : '') }, { label: 'Quelle', key: 'source' }, { label: 'Meldung', key: 'message' }], s.events, { empty: 'Keine Ereignisse' })));
    } catch (e) { holder.replaceChildren(h('div', { class: 'notice err' }, e.message)); }
    busy = false;
  }
  async function showRev(id) {
    const r = await get(`/config-revisions/${id}`);
    await dialog({ title: `Konfigurationsstand #${r.id}`, width: '900px', body: h('div', {}, h('p', { class: 'muted' }, 'Passwörter sind geschwärzt. Der aktuelle Stand liegt als Dateien im Volume der Telefonie-Engine und wird beim Backup gesichert.'), Object.entries(r.files).map(([n, t]) => h('div', {}, h('h3', {}, n), h('pre', { class: 'mono', style: 'max-height:18rem;overflow:auto;background:var(--code-bg);padding:.7rem;border-radius:6px' }, t)))) });
  }
  await load();
  timer = setInterval(load, 10000);
  return () => clearInterval(timer);
}
