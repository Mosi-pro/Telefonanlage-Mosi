'use strict';
const bcrypt = require('bcryptjs');
const db = require('./db');
const config = require('./config');
const log = require('./log');
const { token, sha256, randomString } = require('./crypto');
const { fail } = require('./validate');

const COOKIE = 'mosi_sid';
const ROLE_RANK = { user: 1, operator: 2, admin: 3 };
// Dummy-Hash, damit unbekannte Benutzer genauso lange brauchen wie bekannte (kein Benutzer-Orakel)
const DUMMY_HASH = bcrypt.hashSync('dummy-password-for-timing', 12);

const hashPassword = (pw) => bcrypt.hash(pw, 12);

function parseCookies(header) {
  const out = {};
  for (const part of (header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(res, value, maxAgeSec) {
  const attrs = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
  if (config.secureCookies) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

async function login(username, password, ip) {
  const row = (await db.query('SELECT * FROM users WHERE lower(username) = lower($1)', [username || ''])).rows[0];
  const locked = row?.locked_until && row.locked_until > new Date();
  const ok = await bcrypt.compare(password || '', row?.password_hash || DUMMY_HASH);
  if (!row || !row.active || locked || !ok) {
    await db.query('INSERT INTO login_attempts (ip, username, ok) VALUES ($1,$2,false)', [ip, String(username || '').slice(0, 60)]);
    if (row && !locked) {
      const failed = row.failed_logins + 1;
      const lock = failed >= config.limits.loginMaxFailures;
      await db.query('UPDATE users SET failed_logins = $2, locked_until = CASE WHEN $3 THEN now() + ($4 || \' minutes\')::interval ELSE locked_until END WHERE id = $1',
        [row.id, lock ? 0 : failed, lock, String(config.limits.loginLockMinutes)]);
      if (lock) log.warn('Benutzer wegen fehlgeschlagener Anmeldungen gesperrt', { username: row.username, ip });
    }
    const err = new Error(locked ? `Konto vorübergehend gesperrt (${config.limits.loginLockMinutes} Minuten)` : 'Benutzername oder Passwort falsch');
    err.status = locked ? 423 : 401;
    throw err;
  }
  await db.query('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login = now() WHERE id = $1', [row.id]);
  await db.query('INSERT INTO login_attempts (ip, username, ok) VALUES ($1,$2,true)', [ip, row.username]);
  const tok = token();
  const csrf = token();
  await db.query('INSERT INTO sessions (token_hash, user_id, csrf, ip, expires_at) VALUES ($1,$2,$3,$4, now() + ($5 || \' hours\')::interval)',
    [sha256(tok), row.id, csrf, ip, String(config.limits.sessionHours)]);
  return { token: tok, csrf, user: publicUser(row) };
}

const publicUser = (u) => ({ id: u.id, username: u.username, display_name: u.display_name, role: u.role, active: u.active });

/** Middleware: laedt Sitzung, setzt req.user / req.session. */
async function sessionLoader(req, _res, next) {
  try {
    const tok = parseCookies(req.headers.cookie)[COOKIE];
    if (tok) {
      const r = await db.query(
        `SELECT s.csrf, s.token_hash, u.* FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`, [sha256(tok)]);
      if (r.rows[0]) {
        const row = r.rows[0];
        req.user = publicUser(row);
        req.session = { csrf: row.csrf, hash: row.token_hash };
      }
    }
    next();
  } catch (e) { next(e); }
}

/** Erzwingt Anmeldung, Rolle und (bei schreibenden Anfragen) CSRF-Token + Origin-Pruefung. */
const requireRole = (min = 'user') => (req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Nicht angemeldet' });
  if (ROLE_RANK[req.user.role] < ROLE_RANK[min]) return res.status(403).json({ error: 'Keine Berechtigung' });
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    if (req.headers['x-csrf-token'] !== req.session.csrf) return res.status(403).json({ error: 'CSRF-Pruefung fehlgeschlagen' });
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) return res.status(403).json({ error: 'Ungueltiger Origin' });
  }
  next();
};

async function logout(req, res) {
  if (req.session) await db.query('DELETE FROM sessions WHERE token_hash = $1', [req.session.hash]);
  setCookie(res, '', 0);
}

async function bootstrapAdmin() {
  const n = (await db.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
  if (n > 0) return;
  let pw = config.bootstrapAdmin.password;
  if (!pw) {
    pw = randomString(20);
    log.warn('Kein ADMIN_PASSWORD gesetzt - generiertes Erstpasswort (nur einmal angezeigt)', { username: config.bootstrapAdmin.username, password: pw });
  }
  await db.query('INSERT INTO users (username, display_name, password_hash, role) VALUES ($1,$2,$3,$4)',
    [config.bootstrapAdmin.username, 'Administrator', await hashPassword(pw), 'admin']);
  log.info('Erster Administrator angelegt', { username: config.bootstrapAdmin.username });
}

async function cleanup() {
  await db.query('DELETE FROM sessions WHERE expires_at < now()');
  await db.query("DELETE FROM login_attempts WHERE ts < now() - interval '30 days'");
  await db.query("DELETE FROM system_events WHERE ts < now() - interval '180 days'");
}

module.exports = { hashPassword, login, logout, sessionLoader, requireRole, setCookie, bootstrapAdmin, cleanup, publicUser };
