import { h, badge, dialog, buildForm, toast, table, confirmDialog } from '../ui.js';
import { get, post, put, del } from '../api.js';

const DAYS = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
const MODE = { auto: ['Automatisch nach Zeitplan', ''], open: ['Dauerhaft geöffnet', 'ok'], closed: ['Dauerhaft geschlossen (Nachtschaltung)', 'warn'] };

export default async function render(el) {
  const holder = h('div', {});
  el.append(h('p', { class: 'muted' }, 'Zeitpläne steuern, wohin eingehende Anrufe einer Rufnummer abhängig von Uhrzeit, Wochentag und Feiertag geleitet werden (Zuordnung unter „Rufnummern und SIP-Trunks“). Zeitzone: Server-Zeitzone (TZ).'), holder);
  async function load() {
    const rows = await get('/schedules');
    holder.replaceChildren(h('div', { class: 'toolbar' }, h('button', { class: 'primary', onClick: () => edit(null) }, 'Zeitplan anlegen')),
      table([{ label: 'Name', key: 'name' }, { label: 'Modus', render: (r) => badge(MODE[r.mode][0], MODE[r.mode][1]) },
        { label: 'Geöffnet', render: (r) => (r.rules.length ? r.rules.map((x) => h('div', {}, `${x.days.map((d) => DAYS[d]).join(',')} ${x.from}–${x.to}`)) : '–') },
        { label: 'Feiertage (jährlich)', render: (r) => r.holidays.join(', ') || '–' },
        { label: '', class: 'actions', render: (r) => h('span', {}, h('button', { class: 'small', onClick: () => edit(r) }, 'Bearbeiten'), ' ', h('button', { class: 'small danger', onClick: async () => { if (await confirmDialog('Zeitplan löschen', `„${r.name}“ löschen?`)) { try { await del(`/schedules/${r.id}`); load(); } catch (e) { toast(e.message, true); } } } }, 'Löschen')) }], rows));
  }
  async function edit(row) {
    const form = buildForm([
      { name: 'name', label: 'Name', required: true },
      { name: 'mode', label: 'Modus', type: 'select', options: Object.entries(MODE).map(([value, [label]]) => ({ value, label })) },
      { name: 'holidays', label: 'Feiertage (MM-TT, kommagetrennt, z. B. 12-25,01-01)', hint: 'An diesen Tagen gilt „geschlossen“. Bewegliche Feiertage (Ostern) müssen jährlich ergänzt werden.' }],
      row ? { ...row, holidays: row.holidays.join(',') } : { mode: 'auto' });
    const rules = row ? structuredClone(row.rules) : [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '17:00' }];
    const rulesEl = h('div', {});
    const drawRules = () => rulesEl.replaceChildren(h('h3', {}, 'Geöffnet zu folgenden Zeiten'), ...rules.map((r, i) => h('div', { class: 'card' },
      h('div', { class: 'checklist' }, DAYS.map((d, di) => h('label', {}, h('input', { type: 'checkbox', checked: r.days.includes(di), onChange: (e) => { r.days = e.target.checked ? [...new Set([...r.days, di])] : r.days.filter((x) => x !== di); } }), d))),
      h('div', { class: 'grid cols-2', style: 'margin-top:.6rem' }, h('div', {}, h('label', {}, 'von'), h('input', { type: 'time', value: r.from, onInput: (e) => { r.from = e.target.value; } })), h('div', {}, h('label', {}, 'bis'), h('input', { type: 'time', value: r.to, onInput: (e) => { r.to = e.target.value; } }))),
      h('button', { type: 'button', class: 'small danger', style: 'margin-top:.6rem', onClick: () => { rules.splice(i, 1); drawRules(); } }, 'Zeitfenster entfernen'))),
    h('button', { type: 'button', class: 'small', onClick: () => { rules.push({ days: [1, 2, 3, 4, 5], from: '08:00', to: '17:00' }); drawRules(); } }, 'Zeitfenster hinzufügen'));
    drawRules();
    const res = await dialog({ title: row ? 'Zeitplan bearbeiten' : 'Zeitplan anlegen', body: h('div', {}, form.el, rulesEl), onSubmit: async () => {
      const b = form.values(); b.holidays = b.holidays.split(',').map((s) => s.trim()).filter(Boolean); b.rules = rules;
      return row ? put(`/schedules/${row.id}`, b) : post('/schedules', b);
    } });
    if (res !== undefined) { toast('Gespeichert'); load(); }
  }
  await load();
}
