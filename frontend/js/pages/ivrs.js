import { h, dialog, buildForm, toast, table, confirmDialog, badge } from '../ui.js';
import { get, post, put, del, api } from '../api.js';
import { destinations, destLabel } from './dest.js';

export default async function render(el) {
  const holder = h('div', {});
  el.append(h('p', { class: 'muted' }, 'Ein Telefonmenü spielt eine Ansage ab; der Anrufer wählt per Tastendruck ein Ziel. Ansage: WAV-Datei (PCM, 16 Bit, mono, 8000 oder 16000 Hz). Ohne Ansage wartet das Menü still auf eine Eingabe.'), holder);
  async function load() {
    const [rows, d] = await Promise.all([get('/ivrs'), destinations()]);
    holder.replaceChildren(h('div', { class: 'toolbar' }, h('button', { class: 'primary', onClick: () => edit(null, d.options) }, 'Telefonmenü anlegen')),
      table([{ label: 'Durchwahl', render: (r) => h('strong', {}, r.number) }, { label: 'Name', key: 'name' }, { label: 'Ansage', render: (r) => (r.greeting ? badge('hochgeladen', 'ok') : badge('keine', 'warn')) },
        { label: 'Tasten', render: (r) => r.options.map((o) => h('div', {}, `${o.digit} → ${destLabel(o.target, d.options)}`)) },
        { label: 'Keine/ungültige Eingabe', render: (r) => `${r.retries}× , dann ${destLabel(r.fallback, d.options)}` },
        { label: '', class: 'actions', render: (r) => h('span', {}, h('button', { class: 'small', onClick: () => edit(r, d.options) }, 'Bearbeiten'), ' ', h('button', { class: 'small', onClick: () => greeting(r) }, 'Ansage'), ' ',
          h('button', { class: 'small danger', onClick: async () => { if (await confirmDialog('Telefonmenü löschen', `„${r.name}“ löschen?`)) { try { await del(`/ivrs/${r.id}`); load(); } catch (e) { toast(e.message, true); } } } }, 'Löschen')) }], rows));
  }
  async function edit(row, destOptions) {
    const form = buildForm([{ name: 'number', label: 'Durchwahl', required: true, readonly: true }, { name: 'name', label: 'Name', required: true },
      { name: 'timeout', label: 'Wartezeit auf Eingabe (Sekunden)', type: 'number', min: 2, max: 30, default: 5 },
      { name: 'retries', label: 'Versuche', type: 'number', min: 1, max: 6, default: 3 },
      { name: 'fallback', label: 'Danach weiter an', type: 'select', options: destOptions }], row || { timeout: 5, retries: 3, fallback: 'hangup' });
    const opts = row ? structuredClone(row.options) : [];
    const optEl = h('div', {});
    const draw = () => optEl.replaceChildren(h('h3', {}, 'Tastenbelegung'), ...opts.map((o, i) => h('div', { class: 'toolbar' },
      h('select', { 'aria-label': 'Taste', style: 'width:5rem', onChange: (e) => { o.digit = e.target.value; } }, [...'0123456789*#'].map((k) => h('option', { value: k, selected: k === o.digit }, k))),
      h('select', { 'aria-label': 'Ziel', class: 'grow', onChange: (e) => { o.target = e.target.value; } }, destOptions.map((d) => h('option', { value: d.value, selected: d.value === o.target }, d.label))),
      h('button', { type: 'button', class: 'small danger', onClick: () => { opts.splice(i, 1); draw(); } }, 'Entfernen'))),
    h('button', { type: 'button', class: 'small', onClick: () => { opts.push({ digit: String(opts.length + 1).slice(-1), target: destOptions[1]?.value || 'hangup' }); draw(); } }, 'Taste hinzufügen'));
    draw();
    const res = await dialog({ title: row ? 'Telefonmenü bearbeiten' : 'Telefonmenü anlegen', body: h('div', {}, form.el, optEl), onSubmit: async () => {
      const b = form.values(); b.options = opts; return row ? put(`/ivrs/${row.id}`, b) : post('/ivrs', b);
    } });
    if (res !== undefined) { toast('Gespeichert – Konfiguration wurde geprüft und übernommen'); load(); }
  }
  async function greeting(row) {
    const file = h('input', { type: 'file', accept: '.wav,audio/wav' });
    const res = await dialog({ title: `Ansage für ${row.number} – ${row.name}`, submitLabel: 'Hochladen', body: h('div', {}, h('p', {}, row.greeting ? 'Es ist bereits eine Ansage vorhanden; ein Upload ersetzt sie.' : 'Noch keine Ansage vorhanden.'), file,
      row.greeting ? h('button', { type: 'button', class: 'small danger', style: 'margin-top:1rem', onClick: async () => { try { await del(`/ivrs/${row.id}/greeting`); toast('Ansage entfernt'); load(); } catch (e) { toast(e.message, true); } } }, 'Vorhandene Ansage entfernen') : null),
    onSubmit: async () => { if (!file.files[0]) throw new Error('Bitte eine WAV-Datei auswählen'); return api('PUT', `/ivrs/${row.id}/greeting`, file.files[0], { raw: true, headers: { 'Content-Type': 'audio/wav' } }); } });
    if (res !== undefined) { toast('Ansage gespeichert'); load(); }
  }
  await load();
}
