'use strict';
// Live-Zustand der Telefonie-Engine (Registrierungen, Gespraeche, Trunks) + Sicherheits-/Registrierungsereignisse.
const db = require('./db');
const log = require('./log');

const TTL_MS = 3000;
let ami = null;
let cache = { at: 0, data: null, inflight: null };
const lastEventLog = new Map(); // Entprellung gleicher Fehler

const SECURITY_NAMES = ['InvalidAccountID', 'ChallengeResponseFailed', 'InvalidPassword', 'FailedACL'];
function init(a) {
  ami = a;
  ami.on('ContactStatus', onContactStatus);
  for (const name of SECURITY_NAMES) ami.on(name, onSecurityEvent);
}

const usernameOf = (endpointName) => (endpointName || '').replace(/-web$/, '');

async function onContactStatus(ev) {
  try {
    const user = usernameOf(ev.EndpointName);
    if (!user || user.startsWith('trunk-')) return;
    if (['Created', 'Updated', 'NonQualified'].includes(ev.ContactStatus)) {
      const ip = /@([^;:>]+)/.exec(ev.URI || '')?.[1] || null;
      await db.query(`INSERT INTO registrations (sip_username, last_registered, last_contact_uri, last_user_agent, last_ip)
        VALUES ($1, now(), $2, $3, $4)
        ON CONFLICT (sip_username) DO UPDATE SET last_registered = now(), last_contact_uri = $2, last_user_agent = COALESCE($3, registrations.last_user_agent), last_ip = $4`,
      [user, ev.URI || null, ev.UserAgent || null, ip]);
      cache.at = 0;
    } else if (ev.ContactStatus === 'Removed' || ev.ContactStatus === 'Unreachable') {
      cache.at = 0;
    }
  } catch (e) { log.error('ContactStatus-Verarbeitung fehlgeschlagen', { error: e.message }); }
}

const SECURITY_TEXT = {
  InvalidAccountID: 'Unbekannter SIP-Benutzer',
  ChallengeResponseFailed: 'Falsches SIP-Passwort',
  InvalidPassword: 'Falsches SIP-Passwort',
  FailedACL: 'Zugriff durch Netzwerkfilter (SIP_ALLOWED_NETS) blockiert',
};

async function onSecurityEvent(ev) {
  const kind = ev.Event;
  const text = SECURITY_TEXT[kind];
  if (!text) return;
  try {
    const account = (ev.AccountID || '').replace(/^"|"$/g, '');
    const remote = (ev.RemoteAddress || '').split('/')[2] || ev.RemoteAddress || '?';
    const key = `${kind}|${account}|${remote}`;
    countFailure(remote);
    const now = Date.now();
    if (now - (lastEventLog.get(key) || 0) < 60000) return;
    lastEventLog.set(key, now);
    if (lastEventLog.size > 2000) lastEventLog.clear();
    if (account && /^[A-Za-z0-9._-]{1,64}$/.test(account)) {
      await db.query(`INSERT INTO registrations (sip_username, last_error, last_error_at, last_error_ip) VALUES ($1,$2,now(),$3)
        ON CONFLICT (sip_username) DO UPDATE SET last_error=$2, last_error_at=now(), last_error_ip=$3`,
      [usernameOf(account), text, remote]);
    }
    await event('warning', 'sip-security', `${text}: Konto "${String(account).slice(0, 40)}" von ${remote}`, { type: kind });
  } catch (e) { log.error('SecurityEvent-Verarbeitung fehlgeschlagen', { error: e.message }); }
}

// Einfache Angriffserkennung: viele Fehlversuche von einer Adresse => Fehlermeldung im Dashboard.
const failures = new Map();
function countFailure(remote) {
  const now = Date.now();
  const list = (failures.get(remote) || []).filter((t) => now - t < 600000);
  list.push(now);
  failures.set(remote, list);
  if (list.length === 10) event('error', 'sip-security', `Auffaellig viele fehlgeschlagene SIP-Anmeldungen von ${remote} (10 in 10 Minuten) - Netzwerkfilter pruefen`);
  if (failures.size > 1000) failures.clear();
}

async function event(level, source, message, detail) {
  await db.query('INSERT INTO system_events (level, source, message, detail) VALUES ($1,$2,$3,$4)', [level, source, message, detail ? JSON.stringify(detail) : null]).catch(() => {});
}

function parseDuration(s) {
  const m = /^(\d+):(\d+):(\d+)$/.exec(s || '');
  return m ? (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) : 0;
}

async function collect() {
  const out = { amiConnected: !!(ami && ami.connected), contacts: [], calls: [], trunkRegistrations: [], channels: 0, error: null };
  if (!out.amiConnected) return out;
  try {
    const [contacts, channels, regs] = await Promise.all([
      ami.action({ Action: 'PJSIPShowContacts' }, { list: true }),
      ami.action({ Action: 'CoreShowChannels' }, { list: true }),
      ami.action({ Action: 'PJSIPShowRegistrationsOutbound' }, { list: true }),
    ]);
    const nowSec = Math.floor(Date.now() / 1000);
    out.contacts = contacts.map((c) => {
      const ep = c.Endpoint || c.EndpointName || '';
      return {
        endpoint: ep, username: usernameOf(ep), web: /-web$/.test(ep),
        uri: c.Uri, status: c.Status, userAgent: c.UserAgent || '',
        expires: c.ExpirationTime ? Math.max(0, Number(c.ExpirationTime) - nowSec) : null,
        via: c.ViaAddr ? `${c.ViaAddr}:${c.ViaPort || ''}` : '', rttMs: c.RoundtripUsec ? Math.round(Number(c.RoundtripUsec) / 1000) : null,
      };
    });
    out.channels = channels.length;
    const byLinked = new Map();
    for (const ch of channels) {
      const k = ch.Linkedid || ch.Uniqueid;
      if (!byLinked.has(k)) byLinked.set(k, []);
      byLinked.get(k).push(ch);
    }
    for (const [linkedid, chs] of byLinked) {
      const bridged = chs.some((c) => c.BridgeId);
      const first = chs[0];
      out.calls.push({
        linkedid, state: bridged ? 'Gespraech' : (chs.some((c) => /ring/i.test(c.ChannelStateDesc)) ? 'Klingelt' : first.ChannelStateDesc),
        bridged, from: first.CallerIDNum, to: chs.length > 1 ? (chs[1].CallerIDNum || chs[1].Exten) : first.Exten,
        seconds: Math.max(...chs.map((c) => parseDuration(c.Duration))), channels: chs.map((c) => c.Channel),
      });
    }
    out.trunkRegistrations = regs.map((r) => ({ name: r.ObjectName, status: r.Status, server: r.ServerUri, client: r.ClientUri }));
  } catch (e) { out.error = e.message; }
  return out;
}

/** Zwischengespeicherter Live-Zustand - schuetzt Asterisk vor haeufigen Abfragen mehrerer Browser. */
async function live() {
  if (cache.data && Date.now() - cache.at < TTL_MS) return cache.data;
  if (cache.inflight) return cache.inflight;
  cache.inflight = collect().then((d) => { cache = { at: Date.now(), data: d, inflight: null }; return d; }, (e) => { cache.inflight = null; throw e; });
  return cache.inflight;
}

module.exports = { init, live, event };
