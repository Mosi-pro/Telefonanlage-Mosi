import { h, dialog, buildForm, toast, table, confirmDialog, badge, fmtTime } from '../ui.js';
import { get, post, put, del, state } from '../api.js';

const ROLES = [{ value: 'admin', label: 'Administrator – alles' }, { value: 'operator', label: 'Operator – Nebenstellen, Gruppen, Anrufe (keine Trunks/Benutzer/Netzwerk)' }, { value: 'user', label: 'Benutzer – eigene Nebenstelle, Browsertelefon, eigene Anrufe/Voicemail' }];
const RL = { admin: 'Administrator', operator: 'Operator', user: 'Benutzer' };

export default async function render(el) {
  const holder = h('div', {});
  const me = h('div', { class: 'card' });
  el.append(holder, me);
  async function load() {
    const rows = await get('/users');
    holder.replaceChildren(h('div', { class: 'toolbar' }, h('button', { class: 'primary', onClick: () => edit(null) }, 'Benutzer anlegen')),
      table([{ label: 'Benutzername', key: 'username' }, { label: 'Name', key: 'display_name' }, { label: 'Rolle', render: (u) => badge(RL[u.role], u.role === 'admin' ? 'accent' : '') },
        { label: 'Nebenstellen', render: (u) => u.extensions.join(', ') || '–' }, { label: 'Status', render: (u) => (u.locked_until && new Date(u.locked_until) > new Date() ? badge('gesperrt', 'err') : u.active ? badge('aktiv', 'ok') : badge('inaktiv')) },
        { label: 'Letzte Anmeldung', render: (u) => fmtTime(u.last_login) },
        { label: '', class: 'actions', render: (u) => h('span', {}, h('button', { class: 'small', onClick: () => edit(u) }, 'Bearbeiten'), ' ', u.id !== state.user.id ? h('button', { class: 'small danger', onClick: async () => { if (await confirmDialog('Benutzer löschen', `„${u.username}“ löschen?`)) { try { await del(`/users/${u.id}`); load(); } catch (e) { toast(e.message, true); } } } }, 'Löschen') : null) }], rows));
  }
  async function edit(u) {
    const form = buildForm([
      ...(u ? [] : [{ name: 'username', label: 'Benutzername', required: true }]),
      { name: 'display_name', label: 'Anzeigename', required: true },
      { name: 'role', label: 'Rolle', type: 'select', options: ROLES },
      { name: 'active', label: 'Aktiv', type: 'checkbox', default: true },
      { name: 'password', label: u ? 'Neues Passwort (leer = unverändert)' : 'Passwort', type: 'password', hint: 'Mindestens 12 Zeichen, mindestens 3 von 4 Zeichenklassen.' },
      ...(u ? [{ name: 'unlock', label: 'Sperre nach Fehlanmeldungen aufheben', type: 'checkbox' }] : [])], u || { role: 'user', active: true });
    const res = await dialog({ title: u ? `Benutzer ${u.username}` : 'Benutzer anlegen', body: form.el, onSubmit: async () => {
      const b = form.values(); if (u && !b.password) delete b.password; return u ? put(`/users/${u.id}`, b) : post('/users', b);
    } });
    if (res !== undefined) { toast('Gespeichert'); load(); }
  }
  me.append(h('h2', {}, 'Eigenes Passwort ändern'), h('button', { onClick: async () => {
    const form = buildForm([{ name: 'current', label: 'Aktuelles Passwort', type: 'password' }, { name: 'password', label: 'Neues Passwort', type: 'password' }]);
    const r = await dialog({ title: 'Passwort ändern', body: form.el, onSubmit: async () => post('/me/password', form.values()) });
    if (r !== undefined) toast('Passwort geändert; andere Sitzungen wurden beendet');
  } }, 'Passwort ändern'));
  await load();
}
