import { h, clear, toast, dialog, buildForm } from './ui.js';
import { api, state, login, logout, restore, post } from './api.js';

const ROLE_RANK = { user: 1, operator: 2, admin: 3 };
// Reihenfolge entspricht der geforderten Hauptnavigation; Browsertelefon ist die Zusatzseite fuer WebRTC.
const PAGES = [
  { id: 'setup', label: 'Einrichtungsassistent', min: 'operator', icon: '✦' },
  { id: 'dashboard', label: 'Dashboard', min: 'operator' },
  { id: 'extensions', label: 'Nebenstellen', min: 'user' },
  { id: 'devices', label: 'Telefone und Geräte', min: 'operator' },
  { id: 'calls', label: 'Anrufe', min: 'user' },
  { id: 'contacts', label: 'Kontakte', min: 'user' },
  { id: 'ringgroups', label: 'Rufgruppen', min: 'operator' },
  { id: 'queues', label: 'Warteschlangen', min: 'operator' },
  { id: 'ivrs', label: 'Telefonmenüs (IVR)', min: 'operator' },
  { id: 'trunks', label: 'Rufnummern und SIP-Trunks', min: 'admin' },
  { id: 'schedules', label: 'Zeitpläne', min: 'operator' },
  { id: 'voicemail', label: 'Voicemail', min: 'user' },
  { id: 'users', label: 'Benutzer und Rollen', min: 'admin' },
  { id: 'network', label: 'Netzwerk und Sicherheit', min: 'admin' },
  { id: 'status', label: 'Systemstatus', min: 'operator' },
  { id: 'settings', label: 'Einstellungen', min: 'admin' },
];
const WEBPHONE = { id: 'webphone', label: 'Browsertelefon', min: 'user' };
const MOBILE = { id: 'mobile', label: 'Handy-App', min: 'user' };
const ROLE_LABEL = { admin: 'Administrator', operator: 'Operator', user: 'Benutzer' };

const root = document.getElementById('app');
let cleanup = null;

function allowed(p) { return ROLE_RANK[state.user.role] >= ROLE_RANK[p.min]; }

function showLogin(msg) {
  if (cleanup) { cleanup(); cleanup = null; }
  const err = h('div', { class: 'notice err', role: 'alert', hidden: !msg }, msg || '');
  const user = h('input', { name: 'username', autocomplete: 'username', required: true, autofocus: true });
  const pass = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true });
  const btn = h('button', { class: 'primary', type: 'submit' }, 'Anmelden');
  const form = h('form', { class: 'card' },
    h('div', { class: 'brand', style: 'padding:0 0 1rem' }, h('b', {}, 'M'), 'Mosi Cloud PBX'),
    err,
    h('div', { class: 'field' }, h('label', { for: 'u' }, 'Benutzername'), Object.assign(user, { id: 'u' })),
    h('div', { class: 'field' }, h('label', { for: 'p' }, 'Passwort'), Object.assign(pass, { id: 'p' })),
    btn);
  form.addEventListener('submit', async (e) => {
    e.preventDefault(); btn.disabled = true; err.hidden = true;
    try { await login(user.value.trim(), pass.value); start(); }
    catch (ex) { err.hidden = false; err.textContent = ex.message; btn.disabled = false; pass.value = ''; pass.focus(); }
  });
  clear(root).append(h('div', { class: 'login' }, form, h('p', { class: 'muted', style: 'text-align:center;font-size:.85rem' }, 'Zugriff nur aus dem lokalen Netz.')));
}

async function route() {
  if (!state.user) return showLogin();
  const pages = [...PAGES, MOBILE, WEBPHONE].filter(allowed);
  const id = (location.hash.replace(/^#\/?/, '') || '').split('?')[0] || pages[0].id;
  const page = pages.find((p) => p.id === id) || pages[0];
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.id === page.id));
  document.querySelector('.sidebar')?.classList.remove('open');
  const content = document.getElementById('content');
  clear(content).append(h('h1', {}, page.label));
  const body = h('div', {}); content.append(body);
  try {
    const mod = await import(`./pages/${page.id}.js`);
    const c = await mod.default(body, { reload: route });
    if (typeof c === 'function') cleanup = c;
  } catch (e) {
    body.append(h('div', { class: 'notice err' }, `Seite konnte nicht geladen werden: ${e.message}`));
  }
  document.title = `${page.label} – Mosi Cloud PBX`;
}

async function changePassword() {
  const form = buildForm([{ name: 'current', label: 'Aktuelles Passwort', type: 'password' }, { name: 'password', label: 'Neues Passwort', type: 'password', hint: 'Mindestens 12 Zeichen, mindestens 3 von 4 Zeichenklassen.' }]);
  const r = await dialog({ title: 'Passwort ändern', body: form.el, onSubmit: async () => post('/me/password', form.values()) });
  if (r !== undefined) toast('Passwort geändert; andere Sitzungen wurden beendet');
}

function start() {
  if (cleanup) { cleanup(); cleanup = null; }
  const nav = h('nav', { class: 'nav', 'aria-label': 'Hauptnavigation' },
    PAGES.filter(allowed).map((p) => h('a', { href: `#/${p.id}`, 'data-id': p.id }, p.label)),
    h('div', { class: 'sep' }),
    [MOBILE, WEBPHONE].filter(allowed).map((p) => h('a', { href: `#/${p.id}`, 'data-id': p.id }, p.label)));
  const side = h('aside', { class: 'sidebar' },
    h('div', { class: 'brand' }, h('b', {}, 'M'), 'Mosi Cloud PBX'), nav,
    h('div', { class: 'userbox' }, h('div', {}, state.user.display_name, ' (', state.user.username, ')'), h('div', {}, ROLE_LABEL[state.user.role]),
      h('div', {}, `Version ${state.version}`),
      h('button', { class: 'small', onClick: changePassword }, 'Passwort ändern'), ' ',
      h('button', { class: 'small', onClick: async () => { await logout(); showLogin(); } }, 'Abmelden')));
  const top = h('div', { class: 'topbar' }, h('button', { 'aria-label': 'Menü', onClick: () => side.classList.toggle('open') }, '☰'), h('strong', {}, 'Mosi Cloud PBX'));
  clear(root).append(h('div', { class: 'layout' }, side, h('div', {}, top, h('main', { class: 'content', id: 'content' }))));
  route();
}

window.addEventListener('hashchange', route);
window.addEventListener('mosi:logout', () => { if (state.user) { state.user = null; showLogin('Sitzung abgelaufen – bitte erneut anmelden.'); } });
window.addEventListener('unhandledrejection', (e) => { toast(e.reason?.message || 'Unerwarteter Fehler', true); });

(async () => { if (await restore()) start(); else showLogin(); })();
