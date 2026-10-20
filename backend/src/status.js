'use strict';
const fs = require('fs');
const db = require('./db');
const config = require('./config');
const monitor = require('./monitor');
const cdr = require('./cdr');
const { probeSipUdp, probeTcp } = require('./sipprobe');

let ami = null;
let lastSync = { ok: null, at: null, error: null };
const init = (a) => { ami = a; };
const setSync = (ok, error) => { lastSync = { ok, at: new Date(), error: error || null }; };

/** Echte Dienstpruefungen. Nichts wird als "online" gemeldet, ohne dass es abgefragt wurde. */
async function services() {
  const out = [];
  const add = (id, name, ok, detail) => out.push({ id, name, ok, detail });

  try { const t = Date.now(); await db.query('SELECT 1'); add('db', 'Datenbank (PostgreSQL)', true, `Antwort in ${Date.now() - t} ms`); }
  catch (e) { add('db', 'Datenbank (PostgreSQL)', false, e.message); }

  if (ami && ami.connected) {
    try {
      const up = await ami.action({ Action: 'CoreStatus' });
      add('ami', 'Telefonie-Engine (Asterisk, AMI)', true, `${ami.version || 'verbunden'}; Laufzeit seit ${up.CoreStartupDate || '?'} ${up.CoreStartupTime || ''}`);
    } catch (e) { add('ami', 'Telefonie-Engine (Asterisk, AMI)', false, e.message); }
  } else add('ami', 'Telefonie-Engine (Asterisk, AMI)', false, ami?.lastError || 'AMI nicht verbunden');

  const [sip, ws, tcp5060] = await Promise.all([probeSipUdp(), probeTcp(config.asterisk.host, config.asterisk.wsPort), probeTcp(config.asterisk.host, config.asterisk.sipPort)]);
  add('sip-udp', `SIP UDP ${config.asterisk.sipPort}`, sip.ok, sip.ok ? `OPTIONS beantwortet (${sip.response})` : `OPTIONS: ${sip.error || sip.response}`);
  add('sip-tcp', `SIP TCP ${config.asterisk.sipPort}`, tcp5060.ok, tcp5060.ok ? 'Verbindung moeglich' : tcp5060.error);
  add('websocket', 'WebSocket fuer Browsertelefonie (intern :8088)', ws.ok, ws.ok ? 'Verbindung moeglich' : ws.error);

  const c = cdr.status();
  add('cdr', 'Anrufprotokoll-Import', !c.error && !!c.at, c.error || (c.at ? `zuletzt ${c.at.toISOString()}` : 'noch nicht gelaufen'));
  add('config', 'Telefoniekonfiguration', lastSync.ok !== false, lastSync.ok === false ? `Letzte Synchronisation fehlgeschlagen: ${lastSync.error}` : (lastSync.at ? `synchronisiert ${lastSync.at.toISOString()}` : 'noch nicht synchronisiert'));

  try {
    const s = fs.statfsSync(config.asterisk.generatedDir);
    const free = Math.round((s.bavail * s.bsize) / 1048576);
    add('disk', 'Speicherplatz', free > 200, `${free} MB frei`);
  } catch (e) { add('disk', 'Speicherplatz', false, e.message); }
  return out;
}

module.exports = { init, setSync, services, monitor };
