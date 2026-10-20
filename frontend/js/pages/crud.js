// Gemeinsame Seite fuer einfache Listen mit Anlegen/Bearbeiten/Loeschen.
import { h, table, dialog, confirmDialog, buildForm, toast } from '../ui.js';
import { get, post, put, del } from '../api.js';

export async function crudPage(el, { endpoint, columns, fields, noun, canWrite = true, intro, newDefaults = {}, extraActions, transformOut }) {
  const holder = h('div', {});
  el.append(intro || null, holder);
  async function load() {
    const rows = await get(endpoint);
    const opts = typeof fields === 'function' ? await fields() : fields;
    holder.replaceChildren(
      canWrite ? h('div', { class: 'toolbar' }, h('button', { class: 'primary', onClick: () => edit(null, opts) }, `${noun} anlegen`)) : null,
      table([...columns, { label: '', class: 'actions', render: (r) => h('span', {},
        extraActions ? extraActions(r, load) : null,
        canWrite ? [h('button', { class: 'small', onClick: () => edit(r, opts) }, 'Bearbeiten'), ' ', h('button', { class: 'small danger', onClick: () => remove(r) }, 'Löschen')] : null) }], rows));
  }
  async function edit(row, opts) {
    const form = buildForm(opts, row || newDefaults);
    const res = await dialog({ title: row ? `${noun} bearbeiten` : `${noun} anlegen`, body: form.el, onSubmit: async () => {
      const body = form.values();
      return row ? put(`${endpoint}/${row.id}`, body) : post(endpoint, body);
    } });
    if (res !== undefined) { toast('Gespeichert – Konfiguration wurde geprüft und übernommen'); load(); }
  }
  async function remove(row) {
    const ok = await confirmDialog(`${noun} löschen`, `„${row.name || row.number || row.id}“ wirklich löschen?`);
    if (!ok) return;
    try { await del(`${endpoint}/${row.id}`); toast('Gelöscht'); load(); } catch (e) { toast(e.message, true); }
  }
  await load();
}
