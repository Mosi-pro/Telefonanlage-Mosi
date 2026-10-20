import { h, table, badge, dialog, confirmDialog, buildForm, secretField, toast, fmtTime, dot } from '../ui.js';
import { get, post, put, del, state } from '../api.js';

const STATE = { registered: ['registriert', 'ok'], unreachable: ['registriert, nicht erreichbar', 'warn'], offline: ['nicht registriert', 'err'], disabled: ['deaktiviert', ''] };

export default async function render(el) {
  const canWrite = state.user.role !== 'user';
  const holder = h('div', {});
  el.append(holder);
  async function load() {
    const [exts, users, trunkNums] = await Promise.all([get('/extensions'), canWrite ? get('/users').catch(() => []) : [], canWrite ? get('/trunk-numbers').catch(() => []) : []]);
    holder.replaceChildren(
      canWrite ? h('div', { class: 'toolbar' }, h('button', { class: 'primary', onClick: () => edit(null, users, trunkNums, exts) }, 'Nebenstelle anlegen'),
        h('span', { class: 'muted' }, 'SIP-Passwörter werden automatisch sicher generiert.')) : h('p', { class: 'muted' }, 'Hier sehen Sie Ihre Nebenstelle(n) und die Verbindungsdaten für SIP-App oder Tischtelefon.'),
      table([
        { label: 'Durchwahl', render: (r) => h('strong', {}, r.number) },
        { label: 'Name', key: 'display_name' },
        { label: 'SIP-Benutzer', render: (r) => h('span', { class: 'mono' }, r.sip_username) },
        { label: 'Status', render: (r) => { const [t, k] = STATE[r.registration.state]; return h('span', {}, dot(k || ''), badge(t, k)); } },
        { label: 'Berechtigungen', render: (r) => [badge('intern', 'ok'), ' ', r.allow_external ? badge('extern', 'accent') : null, ' ', r.allow_international ? badge('international', 'warn') : null] },
        { label: 'Zuletzt registriert', render: (r) => fmtTime(r.registration.lastRegistered) },
        { label: '', class: 'actions', render: (r) => h('span', {}, h('button', { class: 'small', onClick: () => details(r) }, 'Verbindung / Diagnose'), canWrite ? [' ', h('button', { class: 'small', onClick: () => edit(r, users, trunkNums, exts) }, 'Bearbeiten'), ' ', h('button', { class: 'small danger', onClick: () => remove(r) }, 'Löschen')] : null) },
      ], exts, { empty: canWrite ? 'Noch keine Nebenstellen. Legen Sie die erste Nebenstelle an.' : 'Ihnen ist noch keine Nebenstelle zugeordnet.' }));
  }

  function fieldsFor(users, trunkNums, exts, isNew) {
    const numOptions = [{ value: '', label: '– keine –' }];
    return [
      ...(isNew ? [{ name: 'number', label: 'Interne Durchwahl', required: true, hint: '2–6 Ziffern, z. B. 100' }, { name: 'sip_username', label: 'SIP-Benutzername', hint: 'Leer lassen = gleich der Durchwahl' }] : []),
      { name: 'display_name', label: 'Anzeigename', required: true },
      { name: 'user_id', label: 'Zugeordneter Benutzer', type: 'select', options: [{ value: '', label: '– keiner –' }, ...users.map((u) => ({ value: u.id, label: `${u.display_name} (${u.username})` }))] },
      { name: 'enabled', label: 'Nebenstelle aktiv', type: 'checkbox', default: true },
      { name: 'allow_external', label: 'Darf extern telefonieren (über SIP-Trunk)', type: 'checkbox', hint: 'Standard: aus. Ohne Freigabe sind nur interne Gespräche möglich.' },
      { name: 'allow_international', label: 'Darf ins Ausland telefonieren', type: 'checkbox', hint: 'Erhöht das Betrugsrisiko – nur bei Bedarf aktivieren.' },
      { name: 'max_out_calls', label: 'Max. gleichzeitige externe Gespräche', type: 'number', min: 1, max: 20, default: 2 },
      { name: 'external_cid', label: 'Ausgehende Rufnummer', type: 'select', options: [{ value: '', label: '– Standard des Trunks –' }, ...[...new Set(trunkNums.map((n) => n.number))].map((n) => ({ value: n, label: n }))], hint: 'Nur Nummern Ihrer SIP-Trunks sind wählbar (Schutz vor Nummernfälschung).' },
      { name: 'hide_caller_id', label: 'Rufnummer unterdrücken (CLIR)', type: 'checkbox' },
      { name: 'webrtc_enabled', label: 'Browsertelefonie erlauben', type: 'checkbox', default: true },
      { name: 'pickup_allowed', label: 'Darf Anrufe anderer Nebenstellen heranholen (**Durchwahl)', type: 'checkbox' },
      { name: 'voicemail_enabled', label: 'Voicemail aktiv', type: 'checkbox' },
      { name: 'ring_timeout', label: 'Klingeldauer (Sekunden)', type: 'number', min: 5, max: 120, default: 25 },
      { name: 'fwd_always', label: 'Rufumleitung sofort an', placeholder: 'Nummer', hint: 'Interne Durchwahl oder externe Nummer (externe Ziele erfordern „extern telefonieren“).' },
      { name: 'fwd_busy', label: 'Bei Besetzt an' }, { name: 'fwd_noanswer', label: 'Bei Nichtannahme an' }, { name: 'fwd_unavail', label: 'Wenn nicht erreichbar an' },
    ];
  }

  async function edit(row, users, trunkNums, exts) {
    const form = buildForm(fieldsFor(users, trunkNums, exts, !row), row ? { ...row, user_id: row.user_id ?? '', external_cid: row.external_cid ?? '' } : { enabled: true });
    const res = await dialog({ title: row ? `Nebenstelle ${row.number} bearbeiten` : 'Nebenstelle anlegen', body: form.el, onSubmit: async () => {
      const b = form.values();
      return row ? put(`/extensions/${row.id}`, b) : post('/extensions', b);
    } });
    if (res !== undefined) { toast('Gespeichert – Konfiguration wurde von der Telefonie-Engine geladen und geprüft'); load(); }
  }

  async function remove(r) {
    if (!(await confirmDialog('Nebenstelle löschen', `Nebenstelle ${r.number} (${r.display_name}) wirklich löschen? Registrierte Geräte verlieren sofort den Zugang.`))) return;
    try { await del(`/extensions/${r.id}`); toast('Gelöscht'); load(); } catch (e) { toast(e.message, true); }
  }

  async function details(r) {
    const c = await get(`/extensions/${r.id}/connection`);
    const reg = r.registration;
    const body = h('div', {},
      h('h3', {}, 'Verbindungsdaten für SIP-App oder Tischtelefon'),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Serveradresse'), h('dd', {}, h('span', { class: 'mono' }, c.server)),
        h('dt', {}, 'SIP-Benutzername'), h('dd', {}, h('span', { class: 'mono' }, c.username)),
        h('dt', {}, 'Authentifizierungs-ID'), h('dd', {}, h('span', { class: 'mono' }, c.username), ' (gleich dem Benutzernamen)'),
        h('dt', {}, 'SIP-Passwort'), h('dd', {}, secretField(c.password)),
        c.voicemail_pin ? [h('dt', {}, 'Voicemail-PIN'), h('dd', {}, secretField(c.voicemail_pin))] : null,
        h('dt', {}, 'Port / Transport'), h('dd', {}, c.transports.map((t) => h('div', {}, `${t.name} ${t.port} – `, h('span', { class: 'muted' }, t.note)))),
        h('dt', {}, 'Codecs'), h('dd', {}, c.codecs.join(', ')),
        h('dt', {}, 'Wählregeln'), h('dd', {}, 'Interne Nummern direkt wählen; externe Rufnummern wie gewohnt (mit Vorwahl) – sofern freigegeben.')),
      h('ul', {}, c.notes.map((n) => h('li', {}, n))),
      h('h3', {}, 'Registrierungsstatus und Diagnose'),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Status'), h('dd', {}, badge(STATE[reg.state][0], STATE[reg.state][1])),
        h('dt', {}, 'Letzte Registrierung'), h('dd', {}, fmtTime(reg.lastRegistered) + (reg.lastIp ? ` von ${reg.lastIp}` : '')),
        h('dt', {}, 'Aktive Kontakte'), h('dd', {}, reg.contacts?.length ? reg.contacts.map((k) => h('div', {}, `${k.web ? 'Browser' : 'Gerät'}: ${k.userAgent || 'unbekannt'} · ${k.via || k.uri} · ${k.status}${k.rttMs != null ? ` · ${k.rttMs} ms` : ''}`)) : 'keine'),
        h('dt', {}, 'Letzter Fehler'), h('dd', {}, reg.lastError ? h('span', { class: 'badge err' }, `${reg.lastError} (${fmtTime(reg.lastErrorAt)}, von ${reg.lastErrorIp})`) : 'keiner')),
      reg.state !== 'registered' ? h('div', { class: 'notice info' }, h('strong', {}, 'Nicht registriert? '),
        'Prüfen: 1) Serveradresse/Port, 2) Benutzername und Passwort exakt (Groß-/Kleinschreibung), 3) liegt das Gerät in einem erlaubten Netz (SIP_ALLOWED_NETS)? 4) Firewall/VPN. Ein Fehlschlag erscheint oben unter „Letzter Fehler“.') : null,
      canWrite ? h('div', { class: 'toolbar' }, h('button', { class: 'small danger', onClick: async () => {
        if (!(await confirmDialog('SIP-Passwort erneuern', 'Das Gerät muss danach mit dem neuen Passwort eingerichtet werden.', 'Erneuern'))) return;
        try { await post(`/extensions/${r.id}/reset-password`); toast('Neues Passwort erzeugt – bitte Verbindungsdaten erneut öffnen'); } catch (e) { toast(e.message, true); }
      } }, 'SIP-Passwort erneuern')) : null);
    await dialog({ title: `Nebenstelle ${r.number} – ${r.display_name}`, body, width: '760px' });
  }
  await load();
}
