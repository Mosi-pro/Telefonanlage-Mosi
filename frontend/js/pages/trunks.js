import { h, dialog, buildForm, toast, table, confirmDialog, badge, dot } from '../ui.js';
import { get, post, put, del } from '../api.js';
import { destinations, destLabel } from './dest.js';

const CLASS = { national: 'National (Festnetz)', mobile: 'Mobilfunk', international: 'International', service: 'Sonderdienste', emergency: 'Notruf' };
const SKIND = { registered: 'ok', ip: 'ok', pending: 'warn', error: 'err', disabled: '', unknown: 'warn' };

export default async function render(el) {
  const holder = h('div', {});
  el.append(h('div', { class: 'notice' }, h('strong', {}, 'Wichtig: '), 'Ohne SIP-Trunk eines Telefonanbieters sind keine Anrufe ins öffentliche Telefonnetz möglich, ebenso keine Anrufe von außen. Zugangsdaten und Rufnummern erhalten Sie von Ihrem Anbieter; es sind keine voreingestellt.'), holder);

  async function load() {
    const [trunks, nums, rules, sched, d] = await Promise.all([get('/trunks'), get('/trunk-numbers'), get('/outbound-rules'), get('/schedules'), destinations()]);
    holder.replaceChildren(
      h('div', { class: 'toolbar' }, h('button', { class: 'primary', onClick: () => editTrunk(null) }, 'SIP-Trunk anlegen')),
      ...(trunks.length ? trunks.map((t) => card(t, nums.filter((n) => n.trunk_id === t.id), rules.filter((r) => r.trunk_id === t.id), sched, d.options)) : [h('div', { class: 'card empty' }, 'Noch kein SIP-Trunk konfiguriert.')]));
  }

  function card(t, nums, rules, sched, destOptions) {
    return h('div', { class: 'card' },
      h('div', { class: 'toolbar' }, h('h2', { class: 'grow', style: 'margin:0' }, dot(SKIND[t.status]), t.name, ' ', badge(t.status_label, SKIND[t.status])),
        h('button', { class: 'small', onClick: () => editTrunk(t) }, 'Bearbeiten'), h('button', { class: 'small danger', onClick: () => removeTrunk(t) }, 'Löschen')),
      h('dl', { class: 'kv' }, h('dt', {}, 'Registrar / Server'), h('dd', {}, `${t.registrar} (${t.transport.toUpperCase()}${t.outbound_proxy ? `, Proxy ${t.outbound_proxy}` : ''})`),
        h('dt', {}, 'Anmeldung'), h('dd', {}, t.auth_mode === 'register' ? `Registrierung als ${t.username}` : 'IP-Authentifizierung (keine Registrierung)'),
        h('dt', {}, 'Max. gleichzeitige Gespräche'), h('dd', {}, t.max_channels)),
      h('h3', {}, 'Eingehende Rufnummern'),
      table([{ label: 'Rufnummer', render: (n) => h('span', { class: 'mono' }, n.number) }, { label: 'Bezeichnung', key: 'label' },
        { label: 'Zeitplan', render: (n) => sched.find((s) => s.id === n.schedule_id)?.name || 'immer' },
        { label: 'Ziel (geöffnet)', render: (n) => destLabel(n.dest_open, destOptions) }, { label: 'Ziel (geschlossen)', render: (n) => (n.schedule_id ? destLabel(n.dest_closed, destOptions) : '–') },
        { label: '', class: 'actions', render: (n) => h('span', {}, h('button', { class: 'small', onClick: () => editNumber(t, n, sched, destOptions) }, 'Bearbeiten'), ' ', h('button', { class: 'small danger', onClick: async () => { if (await confirmDialog('Rufnummer entfernen', n.number)) { try { await del(`/trunk-numbers/${n.id}`); load(); } catch (e) { toast(e.message, true); } } } }, 'Entfernen')) }], nums, { empty: 'Keine Rufnummer – eingehende Anrufe werden abgewiesen oder zum Standardziel geleitet.' }),
      h('div', { class: 'toolbar', style: 'margin-top:.6rem' }, h('button', { class: 'small', onClick: () => editNumber(t, null, sched, destOptions) }, 'Rufnummer hinzufügen'), h('span', { class: 'muted' }, `Standardziel für nicht zugeordnete Nummern: ${destLabel(t.default_inbound, destOptions)}`)),
      h('h3', {}, 'Ausgehende Regeln (Wahlmuster)'),
      table([{ label: 'Name', key: 'name' }, { label: 'Muster', render: (r) => h('span', { class: 'mono' }, r.pattern) }, { label: 'Klasse', render: (r) => badge(CLASS[r.class], r.class === 'international' ? 'warn' : '') },
        { label: 'Ziffern entfernen / voranstellen', render: (r) => `${r.strip} / ${r.prepend || '–'}` }, { label: 'Aktiv', render: (r) => (r.enabled ? 'ja' : 'nein') },
        { label: '', class: 'actions', render: (r) => h('span', {}, h('button', { class: 'small', onClick: () => editRule(t, r) }, 'Bearbeiten'), ' ', h('button', { class: 'small danger', onClick: async () => { if (await confirmDialog('Regel löschen', r.name)) { try { await del(`/outbound-rules/${r.id}`); load(); } catch (e) { toast(e.message, true); } } } }, 'Löschen')) }], rules, { empty: 'Keine Regel – von diesem Trunk wird nichts nach außen gewählt.' }),
      h('div', { class: 'toolbar', style: 'margin-top:.6rem' }, h('button', { class: 'small', onClick: () => editRule(t, null) }, 'Regel hinzufügen')));
  }

  async function editTrunk(t) {
    const form = buildForm([
      { name: 'name', label: 'Name des Anbieters', required: true },
      { name: 'enabled', label: 'Aktiv', type: 'checkbox', default: true },
      { name: 'auth_mode', label: 'Anmeldeverfahren', type: 'select', options: [{ value: 'register', label: 'Registrierung mit Benutzername/Passwort (üblich)' }, { value: 'ip', label: 'IP-Authentifizierung (Anbieter kennt Ihre IP)' }] },
      { name: 'registrar', label: 'Registrar / Server', required: true, placeholder: 'sip.anbieter.example', hint: 'Optional mit Port, z. B. sip.anbieter.example:5060' },
      { name: 'outbound_proxy', label: 'Outbound-Proxy (optional)' },
      { name: 'username', label: 'Benutzername / SIP-ID' },
      { name: 'auth_username', label: 'Authentifizierungs-Benutzername (falls abweichend)' },
      { name: 'password', label: t ? 'Passwort (leer lassen = unverändert)' : 'Passwort', type: 'password' },
      { name: 'transport', label: 'Transportprotokoll', type: 'select', options: [{ value: 'udp', label: 'UDP' }, { value: 'tcp', label: 'TCP' }, { value: 'tls', label: 'TLS (nur mit aktiviertem SIP-TLS)' }] },
      { name: 'from_domain', label: 'SIP-Domain (falls abweichend vom Registrar)' },
      { name: 'match_hosts', label: 'Eingehende Absender (IP/Host, kommagetrennt)', hint: 'Von welchen Adressen akzeptiert die Anlage Anrufe dieses Anbieters. Standard: der Registrar. Viele Anbieter rufen von weiteren Adressen aus – hier eintragen.' },
      { name: 'expiration', label: 'Registrierungsdauer (Sekunden)', type: 'number', min: 60, max: 86400, default: 3600 },
      { name: 'caller_id', label: 'Standard-Absenderrufnummer', hint: 'Wird bei ausgehenden Anrufen übermittelt, sofern die Nebenstelle keine eigene hat.' },
      { name: 'cid_mode', label: 'Rufnummernübermittlung', type: 'select', options: [{ value: 'default', label: 'Anbieterkonto (Standard)' }, { value: 'from', label: 'Im From-Header' }, { value: 'pai', label: 'Im P-Asserted-Identity-Header' }] },
      { name: 'max_channels', label: 'Max. gleichzeitige Gespräche', type: 'number', min: 1, max: 100, default: 4, hint: 'Begrenzt Kosten bei Missbrauch.' },
    ], t || { enabled: true, auth_mode: 'register', transport: 'udp', expiration: 3600, cid_mode: 'default', max_channels: 4 });
    const res = await dialog({ title: t ? `Trunk ${t.name} bearbeiten` : 'SIP-Trunk anlegen', body: form.el, onSubmit: async () => {
      const b = form.values(); if (t && !b.password) delete b.password; return t ? put(`/trunks/${t.id}`, b) : post('/trunks', b);
    } });
    if (res !== undefined) { toast('Gespeichert – die Anlage registriert sich beim Anbieter, Status siehe Karte'); load(); }
  }
  async function removeTrunk(t) {
    if (!(await confirmDialog('Trunk löschen', `„${t.name}“ samt Rufnummern und Regeln löschen?`))) return;
    try { await del(`/trunks/${t.id}`); load(); } catch (e) { toast(e.message, true); }
  }
  async function editNumber(t, n, sched, destOptions) {
    const form = buildForm([
      { name: 'number', label: 'Rufnummer (genau wie vom Anbieter übermittelt)', required: true, hint: 'z. B. +49301234567 oder 0301234567' },
      { name: 'label', label: 'Bezeichnung' },
      { name: 'schedule_id', label: 'Zeitplan', type: 'select', options: [{ value: '', label: '– immer gleich leiten –' }, ...sched.map((s) => ({ value: s.id, label: s.name }))] },
      { name: 'dest_open', label: 'Ziel (zu den Öffnungszeiten bzw. immer)', type: 'select', options: destOptions },
      { name: 'dest_closed', label: 'Ziel (außerhalb der Öffnungszeiten)', type: 'select', options: destOptions }], n ? { ...n, schedule_id: n.schedule_id ?? '' } : { dest_open: 'hangup', dest_closed: 'hangup', schedule_id: '' });
    const res = await dialog({ title: n ? 'Rufnummer bearbeiten' : 'Rufnummer hinzufügen', body: form.el, onSubmit: async () => {
      const b = { ...form.values(), trunk_id: t.id }; return n ? put(`/trunk-numbers/${n.id}`, b) : post('/trunk-numbers', b);
    } });
    if (res !== undefined) { toast('Gespeichert'); load(); }
  }
  async function editRule(t, r) {
    const templates = await get('/outbound-rule-templates');
    const form = buildForm([
      { name: 'name', label: 'Name', required: true },
      { name: 'pattern', label: 'Wahlmuster (Asterisk-Syntax)', required: true, placeholder: '_0[2-9]X.', hint: '_ am Anfang; X = Ziffer 0–9, Z = 1–9, N = 2–9, . = beliebig viele weitere, [ ] = Auswahl' },
      { name: 'class', label: 'Klasse (bestimmt die nötige Berechtigung)', type: 'select', options: Object.entries(CLASS).map(([value, label]) => ({ value, label })) },
      { name: 'strip', label: 'Führende Ziffern entfernen', type: 'number', min: 0, max: 15, default: 0 },
      { name: 'prepend', label: 'Ziffern voranstellen', hint: 'z. B. +49 – je nachdem, welches Format Ihr Anbieter erwartet' },
      { name: 'enabled', label: 'Aktiv', type: 'checkbox', default: true }], r || { enabled: true, class: 'national', strip: 0 });
    const tpl = h('select', { 'aria-label': 'Vorlage', onChange: (e) => { const x = templates[e.target.value]; if (!x) return; for (const k of ['name', 'pattern', 'class', 'strip', 'prepend']) { const f = form.el.querySelector(`[name=${k}]`); if (f) f.value = x[k]; } } },
      h('option', { value: '' }, '– Vorlage übernehmen (Deutschland) –'), ...templates.map((x, i) => h('option', { value: i }, x.name)));
    const res = await dialog({ title: r ? 'Regel bearbeiten' : 'Ausgehende Regel', body: h('div', {}, r ? null : h('div', { class: 'field' }, tpl), form.el,
      h('div', { class: 'notice info' }, 'Nebenstellen dürfen nur wählen, wenn sie „extern telefonieren“ dürfen; Klasse „International“ braucht zusätzlich die Auslandsfreigabe. Zielpräfixe aus der Sperrliste (Einstellungen) werden immer blockiert.')),
    onSubmit: async () => { const b = { ...form.values(), trunk_id: t.id }; return r ? put(`/outbound-rules/${r.id}`, b) : post('/outbound-rules', b); } });
    if (res !== undefined) { toast('Gespeichert'); load(); }
  }
  await load();
}
