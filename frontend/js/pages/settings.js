import { h, table, badge, dialog, buildForm, toast, fmtTime } from '../ui.js';
import { get, put, post } from '../api.js';

export default async function render(el) {
  const s = await get('/settings');
  const prefix = buildForm([{ name: 'blocked', label: 'Gesperrte Zielpräfixe (kommagetrennt)', type: 'textarea', hint: 'Anrufe, deren gewählte Nummer mit einem dieser Präfixe beginnt, werden niemals aufgebaut – unabhängig von Berechtigungen. Standard: Mehrwert- und Sonderrufnummern in Deutschland.' }], { blocked: s.blockedPrefixes.join(',') });
  const audit = h('div', {});
  el.append(
    h('div', { class: 'card' }, h('h2', {}, 'Allgemein (aus der Installation, in .env änderbar)'),
      h('dl', { class: 'kv' }, h('dt', {}, 'Version'), h('dd', {}, s.version), h('dt', {}, 'Server-Adresse'), h('dd', {}, s.hostName), h('dt', {}, 'Host-IP'), h('dd', {}, s.hostIp), h('dt', {}, 'Zeitzone'), h('dd', {}, s.timezone),
        h('dt', {}, 'Gesprächsaufzeichnung'), h('dd', {}, badge('deaktiviert – nicht implementiert', '')))),
    h('div', { class: 'card' }, h('h2', {}, 'Betrugsschutz'), prefix.el,
      h('button', { class: 'primary', onClick: async () => {
        try { await put('/settings', { blockedPrefixes: prefix.values().blocked.split(',').map((x) => x.trim()).filter(Boolean) }); toast('Gespeichert und angewendet'); } catch (e) { toast(e.message, true); }
      } }, 'Speichern')),
    h('div', { class: 'card' }, h('h2', {}, 'Wartung'), h('p', { class: 'muted' }, 'Erzeugt die Telefoniekonfiguration neu aus der Datenbank, lädt sie in Asterisk und verifiziert sie. Bei Fehlern bleibt der bisherige Stand aktiv. Neustarts, Backup und Update erfolgen über die Skripte auf dem Server (restart/backup.sh/update.sh).'),
      h('button', { onClick: async () => { try { await post('/system/resync'); toast('Konfiguration neu angewendet und geprüft'); } catch (e) { toast(e.message, true); } } }, 'Konfiguration neu anwenden')),
    h('div', { class: 'card' }, h('h2', {}, 'Audit-Protokoll (administrative Änderungen)'), audit));
  const rows = await get('/audit?limit=100');
  audit.append(table([{ label: 'Zeit', render: (r) => fmtTime(r.ts) }, { label: 'Benutzer', key: 'username' }, { label: 'Aktion', key: 'action' }, { label: 'Objekt', render: (r) => `${r.entity || ''} ${r.entity_id || ''}` }, { label: 'Details', render: (r) => (r.detail ? JSON.stringify(r.detail) : '') }, { label: 'Adresse', key: 'ip' }], rows));
}
