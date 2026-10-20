'use strict';
const fs = require('fs');
const path = require('path');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const db = require('../db');
const auth = require('../auth');
const apply = require('../apply');
const monitor = require('../monitor');
const status = require('../status');
const { decrypt } = require('../crypto');
const { probeSipUdp, probeTcp } = require('../sipprobe');
const { DEFAULT_BLOCKED } = require('../generator');
const { requireRole } = auth;
const { express, sensitiveLimit, h, audit, mutate, plain, nullIfEmpty, v } = require('./helpers');

const router = express.Router();
const loginLimit = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: true, legacyHeaders: false, message: { error: 'Zu viele Anmeldeversuche von dieser Adresse - bitte spaeter erneut versuchen' } });

// ---------------------------------------------------------------- Gesundheit (oeffentlich, minimal)
router.get('/health', h(async (_req, res) => {
  let dbOk = false;
  try { await db.query('SELECT 1'); dbOk = true; } catch { /* ignore */ }
  const ami = monitor.live ? (await monitor.live()).amiConnected : false;
  const ok = dbOk && ami;
  res.status(ok ? 200 : 503).json({ ok, database: dbOk, asterisk: ami, version: config.version });
}));

// ---------------------------------------------------------------- Anmeldung
router.post('/login', loginLimit, h(async (req, res) => {
  const { username, password } = req.body || {};
  const r = await auth.login(String(username || ''), String(password || ''), req.ip);
  auth.setCookie(res, r.token, config.limits.sessionHours * 3600);
  await db.tx((c) => audit(c, { ...req, user: r.user }, 'login', 'Benutzer', r.user.id));
  res.json({ user: r.user, csrf: r.csrf });
}));
router.post('/logout', h(async (req, res) => { await auth.logout(req, res); res.json({ ok: true }); }));
router.get('/session', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Nicht angemeldet' });
  res.json({ user: req.user, csrf: req.session.csrf, hostName: config.hostName, version: config.version });
});
router.post('/me/password', requireRole('user'), sensitiveLimit, h(async (req, res) => {
  const { current, password } = req.body || {};
  const row = (await db.query('SELECT password_hash FROM users WHERE id = $1', [req.user.id])).rows[0];
  if (!(await require('bcryptjs').compare(String(current || ''), row.password_hash))) return res.status(400).json({ error: 'Aktuelles Passwort ist falsch' });
  v.password('password', password);
  await plain(async (c) => {
    await c.query('UPDATE users SET password_hash = $1 WHERE id = $2', [await auth.hashPassword(password), req.user.id]);
    await c.query('DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2', [req.user.id, req.session.hash]);
    await audit(c, req, 'change-password', 'Benutzer', req.user.id);
  });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- Benutzer
router.get('/users', requireRole('admin'), h(async (_req, res) => {
  const rows = (await db.query(`SELECT u.id, u.username, u.display_name, u.role, u.active, u.last_login, u.locked_until,
    coalesce((SELECT array_agg(number ORDER BY number) FROM extensions e WHERE e.user_id = u.id), '{}') AS extensions
    FROM users u ORDER BY username`)).rows;
  res.json(rows);
}));
const userFields = (b, ex) => ({
  username: ex ? ex.username : v.username('username', b.username),
  display_name: v.name('display_name', b.display_name, { label: 'Anzeigename' }),
  role: v.oneOf('role', b.role, ['admin', 'operator', 'user']),
  active: v.bool('active', b.active, true),
});
router.post('/users', requireRole('admin'), sensitiveLimit, h(async (req, res) => {
  const f = userFields(req.body || {}, null);
  v.password('password', req.body.password);
  const hash = await auth.hashPassword(req.body.password);
  const id = await plain(async (c) => {
    const r = await c.query('INSERT INTO users (username, display_name, role, active, password_hash) VALUES ($1,$2,$3,$4,$5) RETURNING id', [f.username, f.display_name, f.role, f.active, hash]);
    await audit(c, req, 'create', 'Benutzer', r.rows[0].id, { username: f.username, role: f.role });
    return r.rows[0].id;
  });
  res.status(201).json({ id });
}));
router.put('/users/:id(\\d+)', requireRole('admin'), sensitiveLimit, h(async (req, res) => {
  await plain(async (c) => {
    const ex = (await c.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!ex) { const e = new Error('Benutzer nicht gefunden'); e.status = 404; throw e; }
    const f = userFields({ ...ex, ...req.body }, ex);
    if (ex.id === req.user.id && (f.role !== 'admin' || !f.active)) throw new v.ValidationError('Eigene Admin-Rolle bzw. Aktivierung kann nicht entzogen werden', 'role');
    await c.query('UPDATE users SET display_name=$1, role=$2, active=$3 WHERE id=$4', [f.display_name, f.role, f.active, ex.id]);
    if (req.body.password) {
      v.password('password', req.body.password);
      await c.query('UPDATE users SET password_hash=$1, failed_logins=0, locked_until=NULL WHERE id=$2', [await auth.hashPassword(req.body.password), ex.id]);
      await c.query('DELETE FROM sessions WHERE user_id = $1', [ex.id]);
    }
    if (!f.active) await c.query('DELETE FROM sessions WHERE user_id = $1', [ex.id]);
    if (req.body.unlock) await c.query('UPDATE users SET failed_logins=0, locked_until=NULL WHERE id=$1', [ex.id]);
    await audit(c, req, 'update', 'Benutzer', ex.id, { username: ex.username, role: f.role, passwordChanged: !!req.body.password });
  });
  res.json({ ok: true });
}));
router.delete('/users/:id(\\d+)', requireRole('admin'), h(async (req, res) => {
  if (Number(req.params.id) === req.user.id) throw new v.ValidationError('Der eigene Benutzer kann nicht geloescht werden', 'id');
  await plain(async (c) => {
    const r = await c.query('DELETE FROM users WHERE id = $1 RETURNING username', [req.params.id]);
    if (!r.rowCount) { const e = new Error('Benutzer nicht gefunden'); e.status = 404; throw e; }
    await audit(c, req, 'delete', 'Benutzer', req.params.id, { username: r.rows[0].username });
  });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- Anrufe
async function ownNumbers(user) {
  return (await db.query('SELECT number FROM extensions WHERE user_id = $1', [user.id])).rows.map((r) => r.number);
}
const BEST = `SELECT DISTINCT ON (linkedid) * FROM calls ORDER BY linkedid, (disposition = 'ANSWERED') DESC, billsec DESC, started`;
router.get('/calls', requireRole('user'), h(async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const params = []; const where = [];
  const add = (sql, val) => { params.push(val); where.push(sql.replace(/\?/g, `$${params.length}`)); };
  if (req.query.q) add('(src ILIKE ? OR dst ILIKE ? OR clid ILIKE ?)', `%${String(req.query.q).slice(0, 40)}%`);
  if (['internal', 'inbound', 'outbound'].includes(req.query.direction)) add('direction = ?', req.query.direction);
  if (req.query.result === 'answered') where.push("disposition = 'ANSWERED' AND lower(coalesce(lastapp,'')) <> 'voicemail'");
  if (req.query.result === 'missed') where.push("(disposition <> 'ANSWERED' OR lower(coalesce(lastapp,'')) = 'voicemail') AND direction <> 'outbound'");
  if (req.user.role === 'user') add('(src = ANY(?) OR dst = ANY(?))', await ownNumbers(req.user));
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const sql = `SELECT * FROM (${BEST}) b ${w} ORDER BY started DESC LIMIT ${limit} OFFSET ${offset}`;
  const total = (await db.query(`SELECT count(*)::int AS n FROM (${BEST}) b ${w}`, params)).rows[0].n;
  const exts = (await db.query('SELECT number, sip_username FROM extensions')).rows;
  const byUser = new Map(exts.map((e) => [e.sip_username, e.number]));
  const rows = (await db.query(sql, params)).rows.map((r) => {
    const m = /^PJSIP\/(.+?)-[0-9a-f]{8}$/.exec(r.dstchannel || '');
    let answeredBy = null;
    if (m && r.disposition === 'ANSWERED') answeredBy = m[1].startsWith('trunk-') ? 'Trunk' : (byUser.get(m[1].replace(/-web$/, '')) || m[1]);
    return { id: r.id, started: r.started, answered: r.answered, ended: r.ended, from: r.src, clid: r.clid, to: r.dst, direction: r.direction,
      disposition: r.disposition, voicemail: /^voicemail$/i.test(r.lastapp || ''), duration: r.duration, billsec: r.billsec, answeredBy };
  });
  res.json({ total, rows });
}));

// ---------------------------------------------------------------- Dashboard
router.get('/dashboard', requireRole('operator'), h(async (_req, res) => {
  const [live, services] = [await monitor.live(), await status.services()];
  const exts = (await db.query('SELECT id, number, display_name, sip_username, enabled, webrtc_enabled FROM extensions ORDER BY number')).rows;
  const devices = exts.filter((e) => e.enabled).map((e) => {
    const mine = live.contacts.filter((c) => c.username === e.sip_username);
    return { number: e.number, name: e.display_name, registered: mine.some((c) => c.status !== 'Unreachable'), contacts: mine.length };
  });
  const stats = (await db.query(`WITH best AS (SELECT * FROM (${BEST}) b WHERE started >= date_trunc('day', now() AT TIME ZONE $1) AT TIME ZONE $1)
    SELECT count(*)::int total,
      count(*) FILTER (WHERE disposition='ANSWERED' AND lower(coalesce(lastapp,''))<>'voicemail')::int answered,
      count(*) FILTER (WHERE (disposition<>'ANSWERED' OR lower(coalesce(lastapp,''))='voicemail') AND direction<>'outbound')::int missed FROM best`, [config.tz])).rows[0];
  const recent = (await db.query(`SELECT * FROM (${BEST}) b ORDER BY started DESC LIMIT 8`)).rows
    .map((r) => ({ started: r.started, from: r.src, to: r.dst, direction: r.direction, disposition: r.disposition, billsec: r.billsec, voicemail: /^voicemail$/i.test(r.lastapp || '') }));
  const errors = (await db.query("SELECT ts, level, source, message FROM system_events WHERE level IN ('warning','error') AND ts > now() - interval '24 hours' ORDER BY ts DESC LIMIT 8")).rows;
  const trunks = await Promise.all((await db.query('SELECT * FROM trunks ORDER BY name')).rows.map(async (t) => {
    const reg = live.trunkRegistrations.find((r) => r.name === `trunk-${t.id}`);
    const state = !t.enabled ? 'Deaktiviert' : t.auth_mode === 'ip' ? 'IP-Authentifizierung' : reg ? reg.status : 'nicht geladen';
    return { id: t.id, name: t.name, registrar: t.registrar, enabled: t.enabled, state, ok: state === 'Registered' || state === 'IP-Authentifizierung' };
  }));
  res.json({
    devices: { registered: devices.filter((d) => d.registered).length, unregistered: devices.filter((d) => !d.registered).length, list: devices },
    activeCalls: live.calls, stats, services, recent, errors, trunks,
    externalNotice: trunks.length === 0 ? 'Es ist kein SIP-Trunk konfiguriert: Anrufe ins oeffentliche Telefonnetz sind NICHT moeglich. Intern telefonieren funktioniert. Einen Anbieter richten Sie unter "Rufnummern und SIP-Trunks" ein.' : null,
  });
}));

router.get('/status', requireRole('operator'), h(async (_req, res) => {
  const services = await status.services();
  const revs = (await db.query('SELECT id, ts, username, reason, ok, error, hash FROM config_revisions ORDER BY id DESC LIMIT 10')).rows;
  const events = (await db.query('SELECT * FROM system_events ORDER BY id DESC LIMIT 50')).rows;
  res.json({ services, revisions: revs, events, version: config.version, uptimeSeconds: Math.round(process.uptime()), node: process.version });
}));

router.get('/config-revisions/:id(\\d+)', requireRole('admin'), h(async (req, res) => {
  const r = (await db.query('SELECT * FROM config_revisions WHERE id = $1', [req.params.id])).rows[0];
  if (!r) return res.status(404).json({ error: 'Revision nicht gefunden' });
  res.json(r);
}));

router.post('/system/resync', requireRole('admin'), sensitiveLimit, h(async (req, res) => {
  const r = await mutate(req, 'Konfiguration neu anwenden', (c) => audit(c, req, 'resync', 'System', null));
  res.json({ ok: true, result: r });
}));

// ---------------------------------------------------------------- Netzwerk und Sicherheit
router.get('/network', requireRole('admin'), h(async (_req, res) => {
  const a = config.asterisk;
  const [sip, tcp, ws] = await Promise.all([probeSipUdp(), probeTcp(a.host, a.sipPort), probeTcp(a.host, a.wsPort)]);
  const services = [
    { name: 'Verwaltung (HTTPS)', port: `${config.network.httpsPort}/tcp`, scope: 'nur LAN/VPN (ADMIN_ALLOWED_NETS)', allowed: config.network.adminAllowedNets, probe: { ok: true, detail: 'Sie sind verbunden' } },
    { name: 'SIP UDP', port: `${a.sipPort}/udp`, scope: 'nur LAN/VPN (SIP_ALLOWED_NETS)', allowed: config.network.sipAllowedNets, probe: { ok: sip.ok, detail: sip.response || sip.error } },
    { name: 'SIP TCP', port: `${a.sipPort}/tcp`, scope: 'nur LAN/VPN (SIP_ALLOWED_NETS)', allowed: config.network.sipAllowedNets, probe: { ok: tcp.ok, detail: tcp.error || 'Verbindung moeglich' } },
    { name: 'SIP TLS', port: `${a.sipTlsPort}/tcp`, scope: a.sipTlsEnabled ? 'LAN/VPN' : 'deaktiviert', allowed: config.network.sipAllowedNets, probe: { ok: a.sipTlsEnabled ? null : null, detail: a.sipTlsEnabled ? 'aktiviert (Zertifikat pruefen)' : 'nicht aktiviert (SIP_TLS_ENABLED=false)' } },
    { name: 'RTP (Sprache)', port: `${a.rtpStart}-${a.rtpEnd}/udp`, scope: 'nur LAN/VPN - Anzahl gleichzeitiger Gespraeche ca. ' + Math.floor((a.rtpEnd - a.rtpStart + 1) / 2), allowed: config.network.sipAllowedNets, probe: { ok: null, detail: 'Nicht aus dem Container pruefbar - nur durch einen Testanruf' } },
    { name: 'WebRTC (WSS ueber HTTPS)', port: `${config.network.httpsPort}/tcp Pfad /ws`, scope: 'nur LAN/VPN, TLS-Zertifikat noetig', allowed: config.network.adminAllowedNets, probe: { ok: ws.ok, detail: ws.ok ? 'WebSocket-Dienst in der Engine erreichbar' : ws.error } },
    { name: 'Asterisk-AMI (intern)', port: '5038/tcp', scope: 'nur internes Docker-Netz, NICHT veroeffentlicht', allowed: 'intern', probe: { ok: (await monitor.live()).amiConnected, detail: 'Verbindung des Backends' } },
  ];
  const settings = Object.fromEntries((await db.query('SELECT key, value FROM settings')).rows.map((r) => [r.key, r.value]));
  res.json({
    hostName: config.hostName, hostIp: config.hostIp, services,
    stun: process.env.STUN_SERVER || null, turn: process.env.TURN_URL ? 'konfiguriert' : null,
    blockedPrefixes: settings.blockedPrefixes || DEFAULT_BLOCKED,
    security: [
      'SIP-Registrierung ist nur mit Benutzername und individuellem Passwort moeglich; es gibt keinen anonymen Zugang.',
      `SIP-Endgeraete werden zusaetzlich auf diese Netze begrenzt: ${config.network.sipAllowedNets}`,
      `Die Verwaltung ist nur aus diesen Netzen erreichbar: ${config.network.adminAllowedNets}`,
      'Ausgehende Anrufe sind pro Nebenstelle standardmaessig verboten; internationale Ziele erfordern eine eigene Freigabe.',
      'Gesperrte Zielpraefixe (Mehrwert-/Sonderrufnummern) werden vor jeder externen Weiterleitung geprueft.',
    ],
    limits: [
      'Dies ist keine Firewall. Die Datei docs/network.md beschreibt die noetigen Firewall-Regeln. Veroeffentlichen Sie niemals SIP/RTP unkontrolliert im Internet.',
      'Browsertelefonie benoetigt HTTPS mit einem vom Browser akzeptierten Zertifikat und im Internet ggf. STUN/TURN.',
      'Notrufe ueber VoIP: Verfuegbarkeit und Standortuebermittlung haengen vom Anbieter ab und sind nicht garantiert.',
    ],
    registrationFailures: (await db.query("SELECT sip_username, last_error, last_error_at, last_error_ip FROM registrations WHERE last_error IS NOT NULL ORDER BY last_error_at DESC LIMIT 20")).rows,
  });
}));

// ---------------------------------------------------------------- Einstellungen
router.get('/settings', requireRole('admin'), h(async (_req, res) => {
  const s = Object.fromEntries((await db.query('SELECT key, value FROM settings')).rows.map((r) => [r.key, r.value]));
  res.json({ blockedPrefixes: s.blockedPrefixes || DEFAULT_BLOCKED, timezone: config.tz, hostName: config.hostName, hostIp: config.hostIp, version: config.version,
    recordingEnabled: false });
}));
router.put('/settings', requireRole('admin'), h(async (req, res) => {
  const list = (Array.isArray(req.body?.blockedPrefixes) ? req.body.blockedPrefixes : []).map((p) => v.str('blockedPrefixes', String(p), { max: 10, re: /^[0-9*#+]+$/, label: 'Zielpraefix' }));
  if (list.length > 50) throw new v.ValidationError('Maximal 50 Praefixe', 'blockedPrefixes');
  await mutate(req, 'Einstellungen aendern', async (c) => {
    await c.query("INSERT INTO settings (key, value) VALUES ('blockedPrefixes', $1) ON CONFLICT (key) DO UPDATE SET value = $1", [JSON.stringify([...new Set(list)])]);
    await audit(c, req, 'update', 'Einstellungen', 'blockedPrefixes', { count: list.length });
  });
  res.json({ ok: true });
}));
router.get('/audit', requireRole('admin'), h(async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
  res.json((await db.query('SELECT * FROM audit_log ORDER BY id DESC LIMIT $1', [limit])).rows);
}));

// ---------------------------------------------------------------- Voicemail
const VM_DIR = path.join(config.asterisk.voicemailDir, 'default');
const allowedBoxes = async (user) => {
  const q = user.role === 'user' ? 'SELECT number FROM extensions WHERE user_id = $1 AND voicemail_enabled' : 'SELECT number FROM extensions WHERE voicemail_enabled AND $1::int IS NOT NULL';
  return (await db.query(q, [user.id])).rows.map((r) => r.number);
};
function readMessages(box) {
  const dir = path.join(VM_DIR, box, 'INBOX');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^msg\d{4}\.txt$/.test(f)).sort().map((f) => {
    const kv = Object.fromEntries(fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter((l) => l.includes('=')).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    const id = f.slice(3, 7);
    const wav = path.join(dir, `msg${id}.wav`);
    return { mailbox: box, id, callerid: kv.callerid || '', origdate: kv.origdate || '', time: kv.origtime ? new Date(Number(kv.origtime) * 1000) : null, duration: Number(kv.duration || 0), hasAudio: fs.existsSync(wav) };
  });
}
router.get('/voicemail', requireRole('user'), h(async (req, res) => {
  const boxes = await allowedBoxes(req.user);
  res.json({ mailboxes: boxes, messages: boxes.flatMap(readMessages).sort((a, b) => (b.time || 0) - (a.time || 0)) });
}));
const vmParams = async (req) => {
  const { box, id } = req.params;
  if (!/^\d{2,6}$/.test(box) || !/^\d{4}$/.test(id)) throw new v.ValidationError('Ungueltige Nachricht', 'id');
  if (!(await allowedBoxes(req.user)).includes(box)) { const e = new Error('Keine Berechtigung'); e.status = 403; throw e; }
  return path.join(VM_DIR, box, 'INBOX', `msg${id}`);
};
router.get('/voicemail/:box/:id/audio', requireRole('user'), h(async (req, res) => {
  const base = await vmParams(req);
  if (!fs.existsSync(`${base}.wav`)) return res.status(404).json({ error: 'Audio nicht gefunden' });
  await db.tx((c) => audit(c, req, 'play-voicemail', 'Voicemail', `${req.params.box}/${req.params.id}`));
  res.setHeader('Content-Type', 'audio/wav');
  res.setHeader('Cache-Control', 'no-store');
  fs.createReadStream(`${base}.wav`).pipe(res);
}));
router.delete('/voicemail/:box/:id', requireRole('user'), h(async (req, res) => {
  const base = await vmParams(req);
  for (const ext of ['.txt', '.wav', '.WAV', '.gsm']) fs.rmSync(`${base}${ext}`, { force: true });
  await db.tx((c) => audit(c, req, 'delete-voicemail', 'Voicemail', `${req.params.box}/${req.params.id}`));
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- Browsertelefon
router.get('/webphone/config', requireRole('user'), sensitiveLimit, h(async (req, res) => {
  const rows = (await db.query(`SELECT * FROM extensions WHERE enabled AND webrtc_enabled ${req.user.role === 'admin' ? '' : 'AND user_id = $1'} ORDER BY number`, req.user.role === 'admin' ? [] : [req.user.id])).rows;
  await db.tx((c) => audit(c, req, 'webphone-config', 'Nebenstelle', null, { count: rows.length }));
  const ice = [];
  if (process.env.STUN_SERVER) ice.push({ urls: [`stun:${process.env.STUN_SERVER}`] });
  if (process.env.TURN_URL) ice.push({ urls: [process.env.TURN_URL], username: process.env.TURN_USER || '', credential: process.env.TURN_PASSWORD || '' });
  res.json({
    wsPath: '/ws', domain: config.hostName, iceServers: ice,
    extensions: rows.map((e) => ({ id: e.id, number: e.number, display_name: e.display_name, username: `${e.sip_username}-web`, authUsername: `${e.sip_username}-web`, password: decrypt(e.sip_password_enc) })),
  });
}));

module.exports = router;
