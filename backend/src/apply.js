'use strict';
// Anwenden der Telefoniekonfiguration: generieren -> schreiben -> Asterisk neu laden -> verifizieren.
// Schlaegt etwas fehl, wird die alte Konfiguration wiederhergestellt und die DB-Transaktion zurueckgerollt.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const log = require('./log');
const { generate, redact, ConfigError } = require('./generator');
const { decrypt, sha256 } = require('./crypto');

const DIR = config.asterisk.generatedDir;
const FILES = ['pjsip_mosi.conf', 'extensions_mosi.conf', 'voicemail_mosi.conf', 'queues_mosi.conf'];

let ami = null;
const setAmi = (a) => { ami = a; };

// Einfache Mutex-Warteschlange: nur eine Konfigurationsaenderung gleichzeitig.
let chain = Promise.resolve();
const exclusive = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };

async function loadState(c) {
  const q = async (sql) => (await c.query(sql)).rows;
  const settings = Object.fromEntries((await q('SELECT key, value FROM settings')).map((r) => [r.key, r.value]));
  const sounds = fs.existsSync(config.asterisk.soundsDir)
    ? fs.readdirSync(config.asterisk.soundsDir).filter((f) => f.endsWith('.wav')).map((f) => f.replace(/\.wav$/, ''))
    : [];
  return {
    settings: { ...settings, tz: config.tz, tlsAvailable: config.asterisk.sipTlsEnabled },
    extensions: (await q('SELECT * FROM extensions ORDER BY number')).map((e) => ({
      ...e, sip_password: decrypt(e.sip_password_enc), voicemail_pin: e.voicemail_pin_enc ? decrypt(e.voicemail_pin_enc) : '',
    })),
    ringGroups: await q('SELECT * FROM ring_groups ORDER BY number'),
    queues: await q('SELECT * FROM queues ORDER BY number'),
    ivrs: await q('SELECT * FROM ivrs ORDER BY number'),
    schedules: await q('SELECT * FROM schedules ORDER BY id'),
    trunks: (await q('SELECT * FROM trunks ORDER BY id')).map((t) => ({ ...t, password_set: !!t.password_enc, password: t.password_enc ? decrypt(t.password_enc) : '' })),
    trunkNumbers: await q('SELECT * FROM trunk_numbers ORDER BY id'),
    outRules: await q('SELECT * FROM outbound_rules ORDER BY id'),
    contacts: await q('SELECT * FROM contacts ORDER BY id'),
    sounds,
  };
}

function readCurrent() {
  const out = {};
  for (const f of FILES) {
    try { out[f] = fs.readFileSync(path.join(DIR, f), 'utf8'); } catch { out[f] = null; }
  }
  return out;
}

function writeFiles(files) {
  fs.mkdirSync(DIR, { recursive: true });
  for (const [name, text] of Object.entries(files)) {
    if (text === null) continue;
    const target = path.join(DIR, name);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, text, { mode: 0o640 });
    fs.renameSync(tmp, target);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function priorityCounts(text) {
  const counts = {};
  let ctx = null;
  for (const line of text.split('\n')) {
    const m = /^\[(.+)\]$/.exec(line);
    if (m) { ctx = m[1]; counts[ctx] = counts[ctx] || 0; continue; }
    if (ctx && (/^exten =>/.test(line) || /^ same =>/.test(line))) counts[ctx] += 1;
  }
  return counts;
}

/** Prueft, ob Asterisk die erwartete Konfiguration tatsaechlich geladen hat. Gibt Liste der Abweichungen zurueck. */
async function verify(generated) {
  const problems = [];
  const eps = new Set((await ami.action({ Action: 'PJSIPShowEndpoints' }, { list: true })).map((e) => e.ObjectName));
  const missing = generated.expected.endpoints.filter((e) => !eps.has(e));
  if (missing.length) problems.push(`PJSIP-Endpunkte fehlen: ${missing.join(', ')}`);

  const counts = priorityCounts(generated.files['extensions_mosi.conf']);
  for (const [ctx, n] of Object.entries(counts)) {
    const out = await ami.command(`dialplan show ${ctx}`);
    const m = /\((\d+) priorities\)/.exec(out);
    const got = m ? Number(m[1]) : 0;
    if (n > 0 && got !== n) problems.push(`Dialplan-Kontext ${ctx}: ${got} von ${n} Schritten geladen`);
  }
  if (generated.expected.queues.length) {
    const out = await ami.command('queue show');
    for (const qn of generated.expected.queues) if (!new RegExp(`^${qn} `, 'm').test(out)) problems.push(`Warteschlange ${qn} nicht geladen`);
  }
  const vmWanted = (generated.files['voicemail_mosi.conf'].match(/^\d+ =>/gm) || []).length;
  if (vmWanted) {
    const out = await ami.command('voicemail show users');
    const got = out.split('\n').filter((l) => /^default\s+\d+/.test(l)).length;
    if (got !== vmWanted) problems.push(`Voicemail-Postfaecher: ${got} von ${vmWanted} geladen`);
  }
  if (generated.expected.trunkRegistrations.length) {
    const regs = new Set((await ami.action({ Action: 'PJSIPShowRegistrationsOutbound' }, { list: true })).map((e) => e.ObjectName));
    const miss = generated.expected.trunkRegistrations.filter((t) => !regs.has(t));
    if (miss.length) problems.push(`Trunk-Registrierungen fehlen: ${miss.join(', ')}`);
  }
  return problems;
}

async function reloadAndVerify(generated) {
  if (!ami || !ami.connected) throw new ConfigError('Telefonie-Engine (Asterisk) ist nicht erreichbar - Aenderung wurde NICHT uebernommen.', 503);
  await ami.command('core reload');
  let problems = [];
  for (let i = 0; i < 6; i++) {
    await sleep(i === 0 ? 700 : 1200);
    try { problems = await verify(generated); } catch (e) { problems = [e.message]; }
    if (!problems.length) return;
  }
  throw new ConfigError(`Asterisk hat die Konfiguration nicht vollstaendig uebernommen: ${problems.join('; ')}`);
}

async function recordRevision({ ok, error, user, reason, generated }) {
  const files = Object.fromEntries(Object.entries(generated.files).map(([k, v]) => [k, redact(v)]));
  const hash = sha256(JSON.stringify(generated.files));
  await db.query('INSERT INTO config_revisions (username, reason, hash, ok, error, files) VALUES ($1,$2,$3,$4,$5,$6)',
    [user || 'system', reason || '', hash, ok, error || null, JSON.stringify(files)]).catch((e) => log.error('Revision nicht gespeichert', { error: e.message }));
  await db.query('DELETE FROM config_revisions WHERE id NOT IN (SELECT id FROM config_revisions ORDER BY id DESC LIMIT 60)').catch(() => {});
}

/**
 * Fuehrt fn(client) in einer DB-Transaktion aus und wendet danach die daraus resultierende
 * Konfiguration an. Bei jedem Fehler: DB-Rollback + Wiederherstellung der alten Dateien.
 */
function transact(ctx, fn) {
  return exclusive(async () => {
    const previous = readCurrent();
    let wrote = false;
    let generated = null;
    try {
      const result = await db.tx(async (c) => {
        const r = await fn(c);
        generated = generate(await loadState(c));
        writeFiles(generated.files);
        wrote = true;
        await reloadAndVerify(generated);
        return r;
      });
      await recordRevision({ ok: true, user: ctx.user, reason: ctx.reason, generated });
      return result;
    } catch (e) {
      if (wrote) {
        try {
          writeFiles(previous);
          if (ami && ami.connected) await ami.command('core reload');
          log.warn('Konfiguration zurueckgesetzt', { reason: ctx.reason, error: e.message });
        } catch (e2) { log.error('Wiederherstellung fehlgeschlagen', { error: e2.message }); }
      }
      if (generated) await recordRevision({ ok: false, error: e.message, user: ctx.user, reason: ctx.reason, generated });
      throw e;
    }
  });
}

/** Beim Start/Neuverbinden: Dateien aus DB-Stand erzeugen und, falls abweichend, anwenden. */
function sync(reason = 'Synchronisation') {
  return exclusive(async () => {
    const client = await db.pool.connect();
    try {
      const generated = generate(await loadState(client));
      const current = readCurrent();
      const same = FILES.every((f) => current[f] === generated.files[f]);
      if (same && ami && ami.connected) {
        const problems = await verify(generated).catch((e) => [e.message]);
        if (!problems.length) return { changed: false };
        log.warn('Geladene Konfiguration weicht ab, lade neu', { problems });
      }
      writeFiles(generated.files);
      await reloadAndVerify(generated);
      await recordRevision({ ok: true, user: 'system', reason, generated });
      return { changed: !same };
    } catch (e) {
      log.error('Konfigurationssynchronisation fehlgeschlagen', { error: e.message });
      throw e;
    } finally { client.release(); }
  });
}

module.exports = { setAmi, transact, sync, loadState, generate };
