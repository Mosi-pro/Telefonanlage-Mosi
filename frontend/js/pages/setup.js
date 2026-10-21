import { h, clear, badge, dialog, buildForm, secretField, toast } from '../ui.js';
import { get, post } from '../api.js';

export default async function render(el) {
  const holder = h('div', {});
  el.append(holder);
  let busy = false;

  async function load() {
    if (busy || document.hidden) return; busy = true;
    try { draw(await get('/setup/status')); } catch (e) { clear(holder).append(h('div', { class: 'notice err' }, e.message)); }
    busy = false;
  }

  function actions(step, st) {
    const link = (href, text, primary) => h('a', { class: `btn${primary ? ' primary' : ''}`, href }, text);
    switch (step.id) {
      case 'password': return [h('button', { class: 'primary', onClick: () => document.querySelector('.userbox button')?.click() }, 'Passwort jetzt ändern')];
      case 'extension': return [h('button', { class: 'primary', onClick: () => quickExtension(st) }, 'Nebenstelle anlegen'), link('#/extensions', 'Alle Nebenstellen')];
      case 'device': return [link('#/mobile', 'Handy einrichten', true), link('#/extensions', 'Tischtelefon: Verbindungsdaten'), link('#/webphone', 'Browsertelefon')];
      case 'call': return [h('p', { class: 'muted', style: 'flex-basis:100%;margin:0' }, 'Rufen Sie von einem registrierten Gerät eine andere Nebenstelle an. Mit der Nummer *43 testen Sie den Audiopfad (Signalton, dann hören Sie sich selbst).'), link('#/webphone', 'Browsertelefon öffnen', true), link('#/calls', 'Anrufliste')];
      case 'remote': return [link('#/mobile', 'Anleitung: Fernzugriff per VPN', true)];
      case 'trunk': return [link('#/trunks', 'SIP-Trunk einrichten', true)];
      default: return [];
    }
  }

  async function quickExtension(st) {
    const used = new Set(st.extensions);
    let next = 100; while (used.has(String(next))) next += 1;
    const form = buildForm([
      { name: 'number', label: 'Durchwahl', required: true, hint: 'Vorschlag: nächste freie Nummer' },
      { name: 'display_name', label: 'Name (z. B. Anna Empfang)', required: true },
      { name: 'allow_external', label: 'Darf extern telefonieren (erst nach SIP-Trunk sinnvoll)', type: 'checkbox' },
      { name: 'voicemail_enabled', label: 'Voicemail aktivieren', type: 'checkbox' }], { number: String(next), webrtc_enabled: true });
    const created = await dialog({ title: 'Neue Nebenstelle', submitLabel: 'Anlegen', body: form.el, onSubmit: async () => post('/extensions', { ...form.values(), webrtc_enabled: true }) });
    if (!created) return;
    const c = await get(`/extensions/${created.id}/connection`);
    await dialog({ title: `Nebenstelle ${c.extension} ist bereit`, width: '640px', body: h('div', {},
      h('p', {}, 'Tragen Sie diese Daten in Ihr Telefon oder Ihre App ein (Handy: Menü „Handy-App“):'),
      h('dl', { class: 'kv' }, h('dt', {}, 'Server'), h('dd', {}, h('span', { class: 'mono' }, c.server)), h('dt', {}, 'Benutzername'), h('dd', {}, h('span', { class: 'mono' }, c.username)),
        h('dt', {}, 'Passwort'), h('dd', {}, secretField(c.password)), h('dt', {}, 'Port'), h('dd', {}, `${c.transports[0].port} (UDP)`))) });
    toast('Nebenstelle angelegt'); load();
  }

  function draw(st) {
    const required = st.steps.filter((x) => !x.optional);
    const doneReq = required.filter((x) => x.done).length;
    const pct = Math.round((doneReq / required.length) * 100);
    let firstOpen = st.steps.find((x) => !x.done && !x.optional)?.id;
    clear(holder).append(
      h('div', { class: 'card hero' },
        h('div', {}, h('h2', { style: 'margin:0 0 .3rem' }, doneReq === required.length ? 'Ihre Telefonanlage ist einsatzbereit ✓' : 'Willkommen – wir richten Ihre Telefonanlage gemeinsam ein'),
          h('p', { class: 'muted', style: 'margin:0' }, doneReq === required.length ? 'Alle Pflichtschritte sind erledigt. Die optionalen Schritte unten machen die Anlage komplett.' : 'Der Assistent prüft jeden Schritt am echten System und zeigt, was als Nächstes zu tun ist.')),
        h('div', { class: 'progress', role: 'progressbar', 'aria-valuenow': pct, 'aria-valuemin': 0, 'aria-valuemax': 100 }, h('div', { style: `width:${pct}%` }), h('span', {}, `${doneReq} von ${required.length} Pflichtschritten`))),
      h('ol', { class: 'steps' }, st.steps.map((s, i) => h('li', { class: `step${s.done ? ' done' : ''}${s.id === firstOpen ? ' current' : ''}` },
        h('div', { class: 'num' }, s.done ? '✓' : String(i + 1)),
        h('div', { class: 'body' },
          h('div', { class: 'title' }, s.title, ' ', s.optional ? badge('optional', '') : null, ' ', s.done ? badge('erledigt', 'ok') : (s.id === firstOpen ? badge('als Nächstes', 'accent') : null)),
          h('div', { class: 'muted' }, s.detail),
          !s.done || s.id === 'extension' ? h('div', { class: 'toolbar', style: 'margin:.7rem 0 0' }, actions(s, st)) : null)))));
  }

  await load();
  const t = setInterval(load, 5000);
  return () => clearInterval(t);
}
