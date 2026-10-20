'use strict';
const fs = require('fs');
const path = require('path');
const config = require('../config');
const db = require('../db');
const monitor = require('../monitor');
const { encrypt, decrypt, sipPassword, voicemailPin, randomString } = require('../crypto');
const { requireRole } = require('../auth');
const { express, h, audit, mutate, plain, crud, dest, numberList, nullIfEmpty, v } = require('./helpers');

const router = express.Router();

// ---------------------------------------------------------------- Registrierungsstatus
function regState(ext, live, reg) {
  if (!ext.enabled) return { state: 'disabled', label: 'Deaktiviert' };
  const mine = live.contacts.filter((c) => c.username === ext.sip_username);
  let state = 'offline'; let label = 'Nicht registriert';
  if (mine.some((c) => c.status !== 'Unreachable')) { state = 'registered'; label = 'Registriert'; }
  else if (mine.length) { state = 'unreachable'; label = 'Registriert, aber nicht erreichbar'; }
  return {
    state, label, amiAvailable: live.amiConnected,
    contacts: mine.map((c) => ({ uri: c.uri, status: c.status, userAgent: c.userAgent, web: c.web, expires: c.expires, via: c.via, rttMs: c.rttMs })),
    lastRegistered: reg?.last_registered || null, lastIp: reg?.last_ip || null, lastUserAgent: reg?.last_user_agent || null,
    lastError: reg?.last_error || null, lastErrorAt: reg?.last_error_at || null, lastErrorIp: reg?.last_error_ip || null,
  };
}

async function extOut(row, req) {
  const [live, regs] = [await monitor.live(), (await db.query('SELECT * FROM registrations')).rows];
  const reg = regs.find((r) => r.sip_username === row.sip_username);
  const { sip_password_enc, voicemail_pin_enc, ...rest } = row;
  return { ...rest, voicemail_pin_set: !!voicemail_pin_enc, registration: regState(row, live, reg) };
}

// Liste mit Registrierungsstatus (Benutzer sehen nur eigene Nebenstellen)
router.get('/extensions', requireRole('user'), h(async (req, res) => {
  const rows = (await db.query('SELECT * FROM extensions ORDER BY number')).rows;
  const visible = req.user.role === 'user' ? rows.filter((r) => r.user_id === req.user.id) : rows;
  const live = await monitor.live();
  const regs = (await db.query('SELECT * FROM registrations')).rows;
  res.json(visible.map((row) => {
    const { sip_password_enc, voicemail_pin_enc, ...rest } = row;
    return { ...rest, voicemail_pin_set: !!voicemail_pin_enc, registration: regState(row, live, regs.find((r) => r.sip_username === row.sip_username)) };
  }));
}));

async function extFields(b, ex, c) {
  const out = {
    number: ex ? ex.number : v.number('number', b.number),
    display_name: v.name('display_name', b.display_name, { label: 'Anzeigename' }),
    sip_username: ex ? ex.sip_username : v.sipUser('sip_username', b.sip_username || b.number),
    user_id: nullIfEmpty(b.user_id) === null ? null : v.int('user_id', b.user_id, { min: 1, max: 2147483647 }),
    enabled: v.bool('enabled', b.enabled, true),
    allow_external: v.bool('allow_external', b.allow_external),
    allow_international: v.bool('allow_international', b.allow_international),
    max_out_calls: v.int('max_out_calls', b.max_out_calls, { min: 1, max: 20, def: 2 }),
    hide_caller_id: v.bool('hide_caller_id', b.hide_caller_id),
    external_cid: nullIfEmpty(b.external_cid) === null ? null : v.phone('external_cid', b.external_cid),
    webrtc_enabled: v.bool('webrtc_enabled', b.webrtc_enabled, true),
    pickup_allowed: v.bool('pickup_allowed', b.pickup_allowed),
    pickup_group: v.str('pickup_group', b.pickup_group, { optional: true, max: 10, re: /^[A-Za-z0-9]+$/, label: 'Pickup-Gruppe' }),
    voicemail_enabled: v.bool('voicemail_enabled', b.voicemail_enabled),
    ring_timeout: v.int('ring_timeout', b.ring_timeout, { min: 5, max: 120, def: 25 }),
    fwd_always: fwdTarget('fwd_always', b.fwd_always),
    fwd_busy: fwdTarget('fwd_busy', b.fwd_busy),
    fwd_noanswer: fwdTarget('fwd_noanswer', b.fwd_noanswer),
    fwd_unavail: fwdTarget('fwd_unavail', b.fwd_unavail),
    updated_at: new Date(),
  };
  if (out.allow_international && !out.allow_external) throw new v.ValidationError('Internationale Anrufe erfordern die Berechtigung fuer externe Anrufe', 'allow_international');
  if (out.user_id !== null && !(await c.query('SELECT 1 FROM users WHERE id = $1', [out.user_id])).rowCount) throw new v.ValidationError('Benutzer existiert nicht', 'user_id');
  if (out.external_cid && !(await c.query('SELECT 1 FROM trunk_numbers WHERE number = $1', [out.external_cid])).rowCount) {
    throw new v.ValidationError('Die externe Absendernummer muss einer Rufnummer eines SIP-Trunks entsprechen (Schutz vor Nummernmissbrauch)', 'external_cid');
  }
  if (ex) { out.sip_password_enc = ex.sip_password_enc; delete out.number; delete out.sip_username; }
  else out.sip_password_enc = encrypt(sipPassword());
  if (out.voicemail_enabled) out.voicemail_pin_enc = ex?.voicemail_pin_enc || encrypt(voicemailPin());
  else out.voicemail_pin_enc = ex?.voicemail_pin_enc || null;
  if (!ex) delete out.updated_at;
  return out;
}
function fwdTarget(field, val) {
  if (nullIfEmpty(val) === null) return null;
  const s = String(val).trim();
  if (/^[1-9][0-9]{1,5}$/.test(s)) return s;
  return v.phone(field, s, { label: 'Weiterleitungsziel' });
}

crud(router, {
  path: '/extensions', table: 'extensions', entity: 'Nebenstelle', order: 'number', fields: extFields, read: 'admin', write: 'operator',
  out: extOut, auditDetail: (r) => ({ number: r.number, name: r.display_name }),
});
// Die generische GET-Route oben ist bereits registriert (Rolle user); die crud()-GET wird davon ueberdeckt.

router.post('/extensions/:id(\\d+)/reset-password', requireRole('operator'), h(async (req, res) => {
  await mutate(req, 'SIP-Passwort erneuern', async (c) => {
    const r = await c.query('UPDATE extensions SET sip_password_enc = $1, updated_at = now() WHERE id = $2 RETURNING number', [encrypt(sipPassword()), req.params.id]);
    if (!r.rowCount) { const e = new Error('Nebenstelle nicht gefunden'); e.status = 404; throw e; }
    await audit(c, req, 'reset-password', 'Nebenstelle', req.params.id, { number: r.rows[0].number });
  });
  res.json({ ok: true });
}));

router.post('/extensions/:id(\\d+)/reset-pin', requireRole('operator'), h(async (req, res) => {
  await mutate(req, 'Voicemail-PIN erneuern', async (c) => {
    const r = await c.query('UPDATE extensions SET voicemail_pin_enc = $1 WHERE id = $2 AND voicemail_enabled RETURNING number', [encrypt(voicemailPin()), req.params.id]);
    if (!r.rowCount) { const e = new Error('Voicemail ist fuer diese Nebenstelle nicht aktiviert'); e.status = 400; throw e; }
    await audit(c, req, 'reset-pin', 'Nebenstelle', req.params.id, { number: r.rows[0].number });
  });
  res.json({ ok: true });
}));

/** Verbindungsdaten fuer SIP-Apps/Tischtelefone (inkl. Passwort - Zugriff wird protokolliert). */
router.get('/extensions/:id(\\d+)/connection', requireRole('user'), h(async (req, res) => {
  const ex = (await db.query('SELECT * FROM extensions WHERE id = $1', [req.params.id])).rows[0];
  if (!ex) return res.status(404).json({ error: 'Nebenstelle nicht gefunden' });
  if (req.user.role === 'user' && ex.user_id !== req.user.id) return res.status(403).json({ error: 'Keine Berechtigung' });
  await db.tx((c) => audit(c, req, 'view-credentials', 'Nebenstelle', ex.id, { number: ex.number }));
  const a = config.asterisk;
  res.json({
    extension: ex.number, display_name: ex.display_name, enabled: ex.enabled,
    server: config.hostName, username: ex.sip_username, password: decrypt(ex.sip_password_enc),
    voicemail_pin: ex.voicemail_enabled && ex.voicemail_pin_enc ? decrypt(ex.voicemail_pin_enc) : null,
    transports: [
      { name: 'UDP', port: a.sipPort, note: 'Standard fuer Tischtelefone und die meisten Apps' },
      { name: 'TCP', port: a.sipPort, note: 'Fuer Apps mit Hintergrundbetrieb auf dem Smartphone oft zuverlaessiger' },
      ...(a.sipTlsEnabled ? [{ name: 'TLS', port: a.sipTlsPort, note: 'Verschluesselte Signalisierung (Zertifikat siehe Dokumentation)' }] : []),
    ],
    codecs: ['G.711 A-law (PCMA)', 'G.711 u-law (PCMU)'],
    notes: [
      'Im WLAN/LAN: Serveradresse und Port direkt eintragen.',
      'Von unterwegs: nur ueber VPN (WireGuard/OpenVPN) ins lokale Netz verbinden - SIP ist standardmaessig NICHT aus dem Internet erreichbar.',
      'Smartphone-Apps: Energiesparmodus fuer die App deaktivieren, sonst gehen Anrufe im Standby verloren.',
    ],
  });
}));

// ---------------------------------------------------------------- Geraete (Inventar)
crud(router, {
  path: '/devices', table: 'devices', entity: 'Geraet', order: 'name', telephony: false, read: 'operator', write: 'operator',
  fields: async (b, ex, c) => {
    const extId = nullIfEmpty(b.extension_id) === null ? null : v.int('extension_id', b.extension_id, { min: 1, max: 2147483647 });
    if (extId !== null && !(await c.query('SELECT 1 FROM extensions WHERE id = $1', [extId])).rowCount) throw new v.ValidationError('Nebenstelle existiert nicht', 'extension_id');
    return {
      name: v.name('name', b.name, { label: 'Gerätename' }), extension_id: extId,
      kind: v.oneOf('kind', b.kind, ['deskphone', 'softphone', 'mobile', 'webrtc', 'other'], 'deskphone'),
      vendor: v.str('vendor', b.vendor, { optional: true, max: 60 }), model: v.str('model', b.model, { optional: true, max: 60 }),
      mac: v.mac('mac', b.mac), notes: v.text('notes', b.notes),
    };
  },
});

// ---------------------------------------------------------------- Kontakte / Kurzwahlen
crud(router, {
  path: '/contacts', table: 'contacts', entity: 'Kontakt', order: 'name', read: 'user', write: 'operator',
  fields: (b) => ({
    name: v.name('name', b.name), company: v.str('company', b.company, { optional: true, max: 80 }),
    number: v.phone('number', b.number), email: v.email('email', b.email),
    short_code: v.str('short_code', b.short_code, { optional: true, re: /^\*[0-9]{2,3}$/, label: 'Kurzwahl (z. B. *01)' }),
  }),
});

// ---------------------------------------------------------------- Rufgruppen / Warteschlangen / IVR
crud(router, {
  path: '/ring-groups', table: 'ring_groups', entity: 'Rufgruppe', order: 'number', read: 'operator', write: 'operator',
  fields: (b, ex) => ({
    number: ex ? ex.number : v.number('number', b.number), name: v.name('name', b.name),
    strategy: v.oneOf('strategy', b.strategy, ['ringall', 'hunt'], 'ringall'), members: numberList('members', b.members || []),
    timeout: v.int('timeout', b.timeout, { min: 5, max: 120, def: 25 }), fallback: dest('fallback', b.fallback),
  }),
});
crud(router, {
  path: '/queues', table: 'queues', entity: 'Warteschlange', order: 'number', read: 'operator', write: 'operator',
  fields: (b, ex) => ({
    number: ex ? ex.number : v.number('number', b.number), name: v.name('name', b.name),
    strategy: v.oneOf('strategy', b.strategy, ['ringall', 'leastrecent', 'fewestcalls', 'rrmemory', 'linear'], 'ringall'),
    members: numberList('members', b.members || []), timeout: v.int('timeout', b.timeout, { min: 5, max: 120, def: 20 }),
    max_wait: v.int('max_wait', b.max_wait, { min: 10, max: 3600, def: 300 }), fallback: dest('fallback', b.fallback),
  }),
});
crud(router, {
  path: '/ivrs', table: 'ivrs', entity: 'Telefonmenue', order: 'number', read: 'operator', write: 'operator',
  fields: (b, ex) => {
    if (!Array.isArray(b.options)) throw new v.ValidationError('options: Liste erforderlich', 'options');
    const options = b.options.map((o) => ({ digit: v.str('digit', String(o.digit), { re: /^[0-9*#]$/, label: 'Taste' }), target: dest('target', o.target) }));
    return {
      number: ex ? ex.number : v.number('number', b.number), name: v.name('name', b.name), greeting: ex?.greeting || null,
      options: JSON.stringify(options), timeout: v.int('timeout', b.timeout, { min: 2, max: 30, def: 5 }),
      retries: v.int('retries', b.retries, { min: 1, max: 6, def: 3 }), fallback: dest('fallback', b.fallback),
    };
  },
  afterDelete: (row) => { if (row.greeting) fs.rmSync(path.join(config.asterisk.soundsDir, `${row.greeting}.wav`), { force: true }); },
});

// Ansage hochladen: WAV, PCM 16 Bit, mono, 8000 oder 16000 Hz
function checkWav(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new v.ValidationError('Keine gueltige WAV-Datei', 'file');
  let pos = 12; let fmt = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('ascii', pos, pos + 4); const size = buf.readUInt32LE(pos + 4);
    if (id === 'fmt ') { fmt = { format: buf.readUInt16LE(pos + 8), channels: buf.readUInt16LE(pos + 10), rate: buf.readUInt32LE(pos + 12), bits: buf.readUInt16LE(pos + 22) }; break; }
    pos += 8 + size + (size % 2);
  }
  if (!fmt || fmt.format !== 1 || fmt.channels !== 1 || fmt.bits !== 16 || ![8000, 16000].includes(fmt.rate)) {
    throw new v.ValidationError('Erlaubt ist nur WAV: PCM, 16 Bit, mono, 8000 oder 16000 Hz', 'file');
  }
}
router.put('/ivrs/:id(\\d+)/greeting', requireRole('operator'), express.raw({ type: 'audio/wav', limit: '6mb' }), h(async (req, res) => {
  if (!Buffer.isBuffer(req.body) || !req.body.length) throw new v.ValidationError('Bitte eine WAV-Datei (Content-Type audio/wav) senden', 'file');
  checkWav(req.body);
  const name = `ivr-${randomString(10, 'abcdefghijkmnpqrstuvwxyz23456789')}`;
  fs.mkdirSync(config.asterisk.soundsDir, { recursive: true });
  const file = path.join(config.asterisk.soundsDir, `${name}.wav`);
  fs.writeFileSync(file, req.body, { mode: 0o640 });
  let old = null;
  try {
    await mutate(req, 'IVR-Ansage hochladen', async (c) => {
      old = (await c.query('SELECT greeting FROM ivrs WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
      if (!old) { const e = new Error('Telefonmenue nicht gefunden'); e.status = 404; throw e; }
      await c.query('UPDATE ivrs SET greeting = $1 WHERE id = $2', [name, req.params.id]);
      await audit(c, req, 'upload-greeting', 'Telefonmenue', req.params.id, { file: name });
    });
  } catch (e) { fs.rmSync(file, { force: true }); throw e; }
  if (old?.greeting) fs.rmSync(path.join(config.asterisk.soundsDir, `${old.greeting}.wav`), { force: true });
  res.json({ ok: true, greeting: name });
}));
router.delete('/ivrs/:id(\\d+)/greeting', requireRole('operator'), h(async (req, res) => {
  let old;
  await mutate(req, 'IVR-Ansage entfernen', async (c) => {
    old = (await c.query('SELECT greeting FROM ivrs WHERE id = $1 FOR UPDATE', [req.params.id])).rows[0];
    if (!old) { const e = new Error('Telefonmenue nicht gefunden'); e.status = 404; throw e; }
    await c.query('UPDATE ivrs SET greeting = NULL WHERE id = $1', [req.params.id]);
    await audit(c, req, 'delete-greeting', 'Telefonmenue', req.params.id);
  });
  if (old?.greeting) fs.rmSync(path.join(config.asterisk.soundsDir, `${old.greeting}.wav`), { force: true });
  res.json({ ok: true });
}));

// ---------------------------------------------------------------- Zeitplaene
const hhmm = (f, x) => v.str(f, x, { re: /^([01][0-9]|2[0-3]):[0-5][0-9]$/, label: 'Uhrzeit (HH:MM)' });
crud(router, {
  path: '/schedules', table: 'schedules', entity: 'Zeitplan', order: 'name', read: 'operator', write: 'operator',
  fields: (b) => {
    const rules = (Array.isArray(b.rules) ? b.rules : []).map((r) => {
      const days = [...new Set((Array.isArray(r.days) ? r.days : []).map((d) => v.int('days', d, { min: 0, max: 6 })))].sort();
      if (!days.length) throw new v.ValidationError('Jede Regel braucht mindestens einen Wochentag', 'rules');
      const from = hhmm('from', r.from); const to = hhmm('to', r.to);
      if (from >= to) throw new v.ValidationError('Zeitplan: "bis" muss nach "von" liegen (ueber Mitternacht: zwei Regeln anlegen)', 'rules');
      return { days, from, to };
    });
    const holidays = (Array.isArray(b.holidays) ? b.holidays : []).map((x) => {
      const s = v.str('holidays', x, { re: /^(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$/, label: 'Feiertag (MM-TT)' });
      return s;
    });
    return { name: v.name('name', b.name), mode: v.oneOf('mode', b.mode, ['auto', 'open', 'closed'], 'auto'), rules: JSON.stringify(rules), holidays };
  },
});

// ---------------------------------------------------------------- SIP-Trunks
const cleanProxy = (f, x) => v.host(f, nullIfEmpty(x), { optional: true });
async function trunkOut(row) {
  const live = await monitor.live();
  const { password_enc, ...rest } = row;
  const reg = live.trunkRegistrations.find((r) => r.name === `trunk-${row.id}`);
  let status = 'unknown'; let label = 'Unbekannt';
  if (!row.enabled) { status = 'disabled'; label = 'Deaktiviert'; }
  else if (!live.amiConnected) { label = 'Engine nicht erreichbar'; }
  else if (row.auth_mode === 'ip') { status = 'ip'; label = 'IP-Authentifizierung (keine Registrierung)'; }
  else if (reg) {
    if (reg.status === 'Registered') { status = 'registered'; label = 'Registriert'; }
    else if (reg.status === 'Rejected') { status = 'error'; label = 'Registrierung abgelehnt (Zugangsdaten/Berechtigung pruefen)'; }
    else { status = 'pending'; label = `Status: ${reg.status}`; }
  } else { status = 'error'; label = 'Registrierung nicht in der Engine vorhanden'; }
  return { ...rest, password_set: !!password_enc, status, status_label: label };
}
crud(router, {
  path: '/trunks', table: 'trunks', entity: 'SIP-Trunk', order: 'name', read: 'admin', write: 'admin', out: trunkOut,
  fields: (b, ex) => {
    const authMode = v.oneOf('auth_mode', b.auth_mode, ['register', 'ip'], 'register');
    const transport = v.oneOf('transport', b.transport, ['udp', 'tcp', 'tls'], 'udp');
    const username = v.str('username', b.username, { optional: authMode === 'ip', max: 64, re: /^[A-Za-z0-9._+@-]+$/, label: 'Benutzername' });
    if (transport === 'tls' && !config.asterisk.sipTlsEnabled) throw new v.ValidationError('TLS ist nicht aktiviert (SIP_TLS_ENABLED=true und Zertifikate erforderlich, siehe Dokumentation)', 'transport');
    let password_enc = ex?.password_enc || null;
    if (typeof b.password === 'string' && b.password !== '') {
      v.str('password', b.password, { max: 128, re: /^[\x21-\x7e]+$/, label: 'Passwort (nur druckbare ASCII-Zeichen ohne Leerzeichen)' });
      if (/[;#\\"']/.test(b.password)) throw new v.ValidationError('Passwort darf die Zeichen ; # \\ " \' nicht enthalten (Konfigurationsformat)', 'password');
      password_enc = encrypt(b.password);
    }
    if (authMode === 'register' && !password_enc) throw new v.ValidationError('Passwort ist erforderlich', 'password');
    return {
      name: v.name('name', b.name), enabled: v.bool('enabled', b.enabled, true), auth_mode: authMode,
      registrar: v.host('registrar', b.registrar), outbound_proxy: cleanProxy('outbound_proxy', b.outbound_proxy),
      username, auth_username: v.str('auth_username', b.auth_username, { optional: true, max: 64, re: /^[A-Za-z0-9._+@-]+$/ }),
      password_enc, transport, from_domain: v.host('from_domain', nullIfEmpty(b.from_domain), { optional: true }),
      match_hosts: v.str('match_hosts', b.match_hosts, { optional: true, max: 200, re: /^[A-Za-z0-9.\/:, -]+$/, label: 'Eingehende Absender (IP/Host, kommagetrennt)' }),
      expiration: v.int('expiration', b.expiration, { min: 60, max: 86400, def: 3600 }),
      caller_id: nullIfEmpty(b.caller_id) === null ? null : v.phone('caller_id', b.caller_id),
      cid_mode: v.oneOf('cid_mode', b.cid_mode, ['default', 'from', 'pai'], 'default'),
      max_channels: v.int('max_channels', b.max_channels, { min: 1, max: 100, def: 4 }),
      default_inbound: dest('default_inbound', b.default_inbound),
    };
  },
  auditDetail: (r) => ({ name: r.name, registrar: r.registrar }),
});

crud(router, {
  path: '/trunk-numbers', table: 'trunk_numbers', entity: 'Rufnummer', order: 'trunk_id, number', read: 'admin', write: 'admin',
  fields: async (b, ex, c) => {
    const trunkId = v.int('trunk_id', b.trunk_id, { min: 1, max: 2147483647 });
    if (!(await c.query('SELECT 1 FROM trunks WHERE id = $1', [trunkId])).rowCount) throw new v.ValidationError('Trunk existiert nicht', 'trunk_id');
    const sched = nullIfEmpty(b.schedule_id) === null ? null : v.int('schedule_id', b.schedule_id, { min: 1, max: 2147483647 });
    return {
      trunk_id: trunkId, number: v.phone('number', b.number), label: v.str('label', b.label, { optional: true, max: 60, re: /^[^"'\;#=\[\]{}$<>|&`,()]+$/ }),
      schedule_id: sched, dest_open: dest('dest_open', b.dest_open), dest_closed: dest('dest_closed', b.dest_closed),
    };
  },
});

crud(router, {
  path: '/outbound-rules', table: 'outbound_rules', entity: 'Ausgehende Regel', order: 'trunk_id, id', read: 'admin', write: 'admin',
  fields: async (b, ex, c) => {
    const trunkId = v.int('trunk_id', b.trunk_id, { min: 1, max: 2147483647 });
    if (!(await c.query('SELECT 1 FROM trunks WHERE id = $1', [trunkId])).rowCount) throw new v.ValidationError('Trunk existiert nicht', 'trunk_id');
    const klass = v.oneOf('class', b.class, ['national', 'mobile', 'international', 'service', 'emergency']);
    return {
      trunk_id: trunkId, name: v.name('name', b.name), pattern: v.dialPattern('pattern', b.pattern), strip: v.int('strip', b.strip, { min: 0, max: 15, def: 0 }),
      prepend: v.str('prepend', b.prepend ?? '', { optional: true, re: /^\+?[0-9]{0,10}$/, label: 'Vorwahl-Zusatz' }) || '',
      class: klass, enabled: v.bool('enabled', b.enabled, true),
    };
  },
});

router.get('/outbound-rule-templates', requireRole('admin'), (_req, res) => res.json([
  { name: 'Deutschland Festnetz', pattern: '_0[2-9]X.', class: 'national', strip: 0, prepend: '' },
  { name: 'Deutschland Mobilfunk', pattern: '_01[567]X.', class: 'mobile', strip: 0, prepend: '' },
  { name: 'International (00...)', pattern: '_00[1-9]X.', class: 'international', strip: 0, prepend: '' },
  { name: 'Notruf 112', pattern: '_112', class: 'emergency', strip: 0, prepend: '' },
  { name: 'Notruf 110', pattern: '_110', class: 'emergency', strip: 0, prepend: '' },
]));

module.exports = router;
