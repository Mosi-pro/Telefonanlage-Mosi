import { h, table, fmtTime, fmtDur, toast, confirmDialog } from '../ui.js';
import { get, del } from '../api.js';

export default async function render(el) {
  const holder = h('div', {});
  el.append(h('p', { class: 'muted' }, 'Mailbox abhören am Telefon: *97 wählen (eigene Mailbox, PIN in den Verbindungsdaten der Nebenstelle). Ansagen der Mailbox sind englische Standard-Ansagen von Asterisk.'), holder);
  async function load() {
    const r = await get('/voicemail');
    holder.replaceChildren(table([
      { label: 'Mailbox', key: 'mailbox' }, { label: 'Von', key: 'callerid' }, { label: 'Zeit', render: (m) => fmtTime(m.time) }, { label: 'Dauer', render: (m) => fmtDur(m.duration) },
      { label: 'Wiedergabe', render: (m) => (m.hasAudio ? h('audio', { controls: true, preload: 'none', src: `/api/voicemail/${m.mailbox}/${m.id}/audio` }) : '–') },
      { label: '', class: 'actions', render: (m) => h('button', { class: 'small danger', onClick: async () => { if (await confirmDialog('Nachricht löschen', 'Diese Nachricht endgültig löschen?')) { try { await del(`/voicemail/${m.mailbox}/${m.id}`); load(); } catch (e) { toast(e.message, true); } } } }, 'Löschen') }],
    r.messages, { empty: r.mailboxes.length ? 'Keine Nachrichten' : 'Keine Mailbox aktiv – Voicemail kann je Nebenstelle aktiviert werden.' }));
  }
  await load();
}
