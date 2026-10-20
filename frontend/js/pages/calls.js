import { h, table, badge, fmtTime, fmtDur } from '../ui.js';
import { get } from '../api.js';

const DISPO = { ANSWERED: ['angenommen', 'ok'], 'NO ANSWER': ['nicht angenommen', 'warn'], BUSY: ['besetzt', 'warn'], FAILED: ['fehlgeschlagen/abgelehnt', 'err'], CONGESTION: ['nicht erreichbar', 'err'] };
const DIR = { internal: 'intern', inbound: 'eingehend', outbound: 'ausgehend' };

export default async function render(el) {
  let offset = 0; const limit = 50;
  const q = h('input', { class: 'search', type: 'search', placeholder: 'Suche nach Nummer/Name', 'aria-label': 'Suche' });
  const dir = h('select', { 'aria-label': 'Richtung' }, h('option', { value: '' }, 'Alle Richtungen'), ...Object.entries(DIR).map(([v, l]) => h('option', { value: v }, l)));
  const res = h('select', { 'aria-label': 'Ergebnis' }, h('option', { value: '' }, 'Alle Ergebnisse'), h('option', { value: 'answered' }, 'Angenommen'), h('option', { value: 'missed' }, 'Verpasst'));
  const out = h('div', {}); const pager = h('div', { class: 'toolbar' });
  el.append(h('div', { class: 'toolbar' }, q, dir, res), out, pager);
  async function load() {
    const params = new URLSearchParams({ limit, offset, q: q.value, direction: dir.value, result: res.value });
    const r = await get(`/calls?${params}`);
    out.replaceChildren(table([
      { label: 'Zeit', render: (c) => fmtTime(c.started) }, { label: 'Von', render: (c) => c.clid || c.from }, { label: 'Nach', key: 'to' },
      { label: 'Art', render: (c) => DIR[c.direction] }, { label: 'Angenommen von', render: (c) => c.answeredBy || (c.voicemail ? 'Voicemail' : '–') },
      { label: 'Ergebnis', render: (c) => { const x = c.voicemail ? ['Voicemail', 'warn'] : (DISPO[c.disposition] || [c.disposition, '']); return badge(x[0], x[1]); } },
      { label: 'Dauer', render: (c) => fmtDur(c.billsec) }], r.rows, { empty: 'Keine Anrufe gefunden. Die Liste füllt sich mit echten Gesprächen.' }));
    pager.replaceChildren(
      h('button', { disabled: offset === 0, onClick: () => { offset = Math.max(0, offset - limit); load(); } }, '‹ Zurück'),
      h('span', { class: 'muted' }, r.total ? `${offset + 1}–${Math.min(offset + limit, r.total)} von ${r.total}` : '0 Einträge'),
      h('button', { disabled: offset + limit >= r.total, onClick: () => { offset += limit; load(); } }, 'Weiter ›'));
  }
  let t; const reset = () => { clearTimeout(t); t = setTimeout(() => { offset = 0; load(); }, 300); };
  q.addEventListener('input', reset); dir.addEventListener('change', reset); res.addEventListener('change', reset);
  await load();
}
