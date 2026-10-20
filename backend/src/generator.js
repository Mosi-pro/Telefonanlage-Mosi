'use strict';
// Erzeugt aus dem Datenbankzustand die Asterisk-Konfiguration (reine Funktion, ohne Seiteneffekte).
// Alle Eingaben wurden vorher in validate.js gegen enge Whitelists geprueft; hier wird zusaetzlich
// konsistent geprueft (eindeutige Nummern, existierende Ziele). Fehler => Exception => nichts wird angewendet.

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const SOUND_DIR = '/var/lib/mosi/sounds';
const RESERVED_SHORT = new Set(['*43', '*97', '*98']);
const DEFAULT_BLOCKED = ['0900', '0137', '0138', '0180', '0190', '0700', '118'];

class ConfigError extends Error { constructor(m, status = 400) { super(m); this.status = status; } }

function generate(state) {
  const settings = state.settings || {};
  const exts = state.extensions || [];
  const groups = state.ringGroups || [];
  const queues = state.queues || [];
  const ivrs = state.ivrs || [];
  const schedules = state.schedules || [];
  const trunks = state.trunks || [];
  const trunkNumbers = state.trunkNumbers || [];
  const outRules = state.outRules || [];
  const contacts = state.contacts || [];
  const sounds = new Set(state.sounds || []);
  const blocked = (settings.blockedPrefixes || DEFAULT_BLOCKED).filter((p) => /^[0-9*#+]{1,10}$/.test(p));

  // ---- Konsistenzpruefungen -------------------------------------------------
  const numbers = new Map(); // Rufnummer -> Art
  const claim = (n, kind) => {
    if (numbers.has(n)) throw new ConfigError(`Rufnummer ${n} ist doppelt vergeben (${numbers.get(n)} und ${kind})`);
    numbers.set(n, kind);
  };
  exts.forEach((e) => claim(e.number, 'Nebenstelle'));
  groups.forEach((g) => claim(g.number, 'Rufgruppe'));
  queues.forEach((q) => claim(q.number, 'Warteschlange'));
  ivrs.forEach((i) => claim(i.number, 'Telefonmenue'));
  const extByNum = new Map(exts.map((e) => [e.number, e]));
  const schedById = new Map(schedules.map((s) => [s.id, s]));
  const trunkById = new Map(trunks.map((t) => [t.id, t]));

  const shortSeen = new Set();
  for (const c of contacts) {
    if (!c.short_code) continue;
    if (RESERVED_SHORT.has(c.short_code) || shortSeen.has(c.short_code)) throw new ConfigError(`Kurzwahl ${c.short_code} ist reserviert oder doppelt`);
    shortSeen.add(c.short_code);
  }

  const dsLines = (e) => [' same => n,Set(MOSI_DS=)', ` same => n,Gosub(mosi-ds,s,1(${e.sip_username}))`,
    ...(e.webrtc_enabled ? [` same => n,Gosub(mosi-dsw,s,1(${e.sip_username}-web))`] : [])];
  const dialStr = (e) => (e.webrtc_enabled ? `PJSIP/${e.sip_username}&PJSIP/${e.sip_username}-web` : `PJSIP/${e.sip_username}`);
  const memberDial = (n) => {
    const e = extByNum.get(n);
    if (!e) throw new ConfigError(`Mitglied ${n} ist keine Nebenstelle`);
    return e.enabled ? dialStr(e) : null;
  };

  /** Zielangabe -> Dialplan-Zeile. */
  function destLine(dest, what) {
    if (!dest || dest === 'hangup') return 'Hangup()';
    let m;
    if ((m = /^vm:([0-9]+)$/.exec(dest))) {
      const e = extByNum.get(m[1]);
      if (!e || !e.voicemail_enabled) throw new ConfigError(`${what}: Voicemail von ${m[1]} ist nicht aktiviert`);
      return `Voicemail(${m[1]}@default,u)`;
    }
    if (/^[0-9]{2,6}$/.test(dest)) {
      if (!numbers.has(dest)) throw new ConfigError(`${what}: Ziel ${dest} existiert nicht`);
      return `Goto(mosi-dest,${dest},1)`;
    }
    throw new ConfigError(`${what}: ungueltiges Ziel`);
  }

  // ---- pjsip -----------------------------------------------------------------
  const pj = ['; Erzeugt von Mosi Cloud PBX - NICHT von Hand bearbeiten (Aenderungen gehen verloren).', ''];
  for (const e of exts) {
    if (!e.enabled) continue;
    const u = e.sip_username;
    const cidOk = e.external_cid && trunkNumbers.some((tn) => tn.number === e.external_cid);
    const vars = [
      `set_var=MOSI_EXT=${e.number}`,
      `set_var=MOSI_ALLOW_EXT=${e.allow_external ? 1 : 0}`,
      `set_var=MOSI_ALLOW_INTL=${e.allow_international ? 1 : 0}`,
      `set_var=MOSI_MAXOUT=${e.max_out_calls}`,
      `set_var=MOSI_PICKUP=${e.pickup_allowed ? 1 : 0}`,
      `set_var=MOSI_HIDECID=${e.hide_caller_id ? 1 : 0}`,
      `set_var=MOSI_CID=${cidOk ? e.external_cid : ''}`,
    ];
    const common = (name) => [
      `[${name}]`, 'type=endpoint', 'context=mosi-internal', 'disallow=all', 'allow=alaw,ulaw',
      `auth=${name}`, `aors=${name}`, `callerid="${e.display_name}" <${e.number}>`,
      'direct_media=no', 'rtp_symmetric=yes', 'force_rport=yes', 'rewrite_contact=yes',
      'dtmf_mode=rfc4733', 'language=de', 'device_state_busy_at=1', 'allow_subscribe=yes',
      // Absender-Domain fuer Anfragen der Anlage an das Endgeraet: JsSIP (Browser) kann die Container-ID als Hostname nicht parsen
      ...(settings.hostName && /^[A-Za-z0-9.-]+$/.test(settings.hostName) ? [`from_domain=${settings.hostName}`] : []),
      ...(e.voicemail_enabled ? [`mailboxes=${e.number}@default`] : []),
      ...(e.pickup_group ? [`call_group=${e.pickup_group}`, `pickup_group=${e.pickup_group}`] : []),
      ...vars,
    ];
    pj.push(`; --- Nebenstelle ${e.number} (${e.sip_username}) ---`,
      `[${u}]`, 'type=auth', 'auth_type=userpass', `username=${u}`, `password=${e.sip_password}`, '',
      `[${u}]`, 'type=aor', 'max_contacts=5', 'remove_existing=yes', 'remove_unavailable=yes', 'qualify_frequency=30',
      'default_expiration=600', 'minimum_expiration=60', 'maximum_expiration=3600', '',
      ...common(u), 'acl=acl_sip', 'contact_acl=acl_sip', '');
    if (e.webrtc_enabled) {
      pj.push(
        `[${u}-web]`, 'type=auth', 'auth_type=userpass', `username=${u}-web`, `password=${e.sip_password}`, '',
        `[${u}-web]`, 'type=aor', 'max_contacts=1', 'remove_existing=yes', 'remove_unavailable=yes', 'default_expiration=600', '',
        ...common(`${u}-web`).filter((l) => !l.startsWith('allow=') && !l.startsWith('disallow=')),
        'disallow=all', 'allow=alaw,ulaw', 'transport=transport-ws', 'webrtc=yes', 'dtls_auto_generate_cert=yes', 'rtcp_mux=yes', '');
    }
  }

  for (const t of trunks) {
    if (!t.enabled) continue;
    const id = `trunk-${t.id}`;
    const tr = `transport-${t.transport}`;
    if (t.transport === 'tls' && !settings.tlsAvailable) {
      throw new ConfigError(`Trunk ${t.name}: TLS ist nicht aktiviert (SIP_TLS_ENABLED=true und Zertifikat erforderlich)`);
    }
    const hostOnly = t.registrar.replace(/:[0-9]+$/, '');
    const suffix = t.transport === 'udp' ? '' : `;transport=${t.transport}`;
    pj.push(`; --- SIP-Trunk ${t.id} (${t.name}) ---`);
    if (t.password_set) {
      pj.push(`[${id}]`, 'type=auth', 'auth_type=userpass', `username=${t.auth_username || t.username}`, `password=${t.password}`, '');
    }
    pj.push(`[${id}]`, 'type=aor', `contact=sip:${t.registrar}${suffix}`, 'qualify_frequency=60', 'qualify_timeout=5', '');
    if (t.auth_mode === 'register') {
      pj.push(`[${id}]`, 'type=registration', `transport=${tr}`, `outbound_auth=${id}`,
        `server_uri=sip:${t.registrar}${suffix}`, `client_uri=sip:${t.username}@${t.from_domain || hostOnly}`,
        `contact_user=${t.username}`, `expiration=${t.expiration}`, 'retry_interval=60', 'forbidden_retry_interval=600',
        'max_retries=10000', 'auth_rejection_permanent=no', 'line=yes', `endpoint=${id}`,
        ...(t.outbound_proxy ? [`outbound_proxy=sip:${t.outbound_proxy}\;lr`] : []), '');
    }
    pj.push(`[${id}]`, 'type=endpoint', `context=mosi-in-${t.id}`, 'disallow=all', 'allow=alaw,ulaw', `transport=${tr}`,
      ...(t.password_set ? [`outbound_auth=${id}`] : []), `aors=${id}`,
      ...(t.from_domain ? [`from_domain=${t.from_domain}`] : []),
      ...(t.cid_mode !== 'from' && t.username ? [`from_user=${t.username}`] : []),
      ...(t.cid_mode === 'pai' ? ['send_pai=yes'] : []),
      ...(t.outbound_proxy ? [`outbound_proxy=sip:${t.outbound_proxy}\;lr`] : []),
      'direct_media=no', 'rtp_symmetric=yes', 'force_rport=yes', 'rewrite_contact=yes', 'dtmf_mode=rfc4733', 'language=de', 'trust_id_inbound=no', '');
    const matchHosts = (t.match_hosts ? t.match_hosts.split(',').map((s) => s.trim()).filter(Boolean) : [hostOnly]);
    pj.push(`[${id}]`, 'type=identify', `endpoint=${id}`, ...matchHosts.map((h) => `match=${h}`), '');
  }

  // ---- extensions ------------------------------------------------------------
  const dp = ['; Erzeugt von Mosi Cloud PBX - NICHT von Hand bearbeiten.', ''];
  const L = (...lines) => dp.push(...lines);

  L('[mosi-hop]',
    'exten => s,1,Set(MOSI_HOPS=${IF($["${MOSI_HOPS}"=""]?0:${MOSI_HOPS})})',
    ' same => n,Set(__MOSI_HOPS=$[${MOSI_HOPS}+1])',
    ' same => n,GotoIf($[${MOSI_HOPS}>8]?loop)',
    ' same => n,Return()',
    ' same => n(loop),NoOp(Weiterleitungsschleife erkannt)',
    ' same => n,Congestion(5)', '');

  // Wahlstring fuer ALLE erreichbaren Kontakte (Tischtelefon, App, Browser) einer Nebenstelle:
  // "Dial(PJSIP/<endpoint>)" wuerde nur EINEN Kontakt anrufen, PJSIP_DIAL_CONTACTS() liefert alle verfuegbaren.
  // (Kein ${IF()} mit den Kontakt-URIs: der Doppelpunkt in "sip:..." wuerde die IF-Argumente zerreissen.)
  L('[mosi-ds]',
    'exten => s,1,Set(MOSI_C=${PJSIP_DIAL_CONTACTS(${ARG1})})',
    ' same => n,GotoIf($["${MOSI_C}"=""]?done)',
    ' same => n,GotoIf($["${MOSI_DS}"=""]?first)',
    ' same => n,Set(MOSI_DS=${MOSI_DS}&${MOSI_C})',
    ' same => n,Return()',
    ' same => n(first),Set(MOSI_DS=${MOSI_C})',
    ' same => n(done),Return()', '');
  // Browser-Kontakte (WebSocket) enthalten in der Kontakt-URI "x-ast-orig-host=...:0" und sind als Kontakt-Wahlstring
  // nicht waehlbar -> hier ueber den Endpunkt waehlen, aber nur wenn ein Browser registriert ist.
  L('[mosi-dsw]',
    'exten => s,1,GotoIf($["${DEVICE_STATE(PJSIP/${ARG1})}"="UNAVAILABLE"]?done)',
    ' same => n,GotoIf($["${MOSI_DS}"=""]?first)',
    ' same => n,Set(MOSI_DS=${MOSI_DS}&PJSIP/${ARG1})',
    ' same => n,Return()',
    ' same => n(first),Set(MOSI_DS=PJSIP/${ARG1})',
    ' same => n(done),Return()', '');

  // Berechtigungspruefung fuer ausgehende Rufe
  L('[mosi-outchk]',
    'exten => s,1,NoOp(Pruefung Klasse ${ARG1} Ziel ${ARG2} von ${MOSI_EXT})',
    ' same => n,GotoIf($["${ARG1}"="emergency"]?limit)',
    ' same => n,GotoIf($["${MOSI_ALLOW_EXT}"!="1"]?deny)',
    ' same => n,GotoIf($["${ARG1}"="international" & "${MOSI_ALLOW_INTL}"!="1"]?deny)');
  for (const p of blocked) L(` same => n,GotoIf($["\${ARG2:0:${p.length}}"="${p}"]?deny)`);
  L(' same => n(limit),Set(GROUP(out)=${MOSI_EXT})',
    ' same => n,GotoIf($[${GROUP_COUNT(${MOSI_EXT}@out)}>${IF($["${MOSI_MAXOUT}"=""]?1:${MOSI_MAXOUT})}]?toomany)',
    ' same => n,Return()',
    ' same => n(deny),NoOp(Ausgehender Ruf NICHT erlaubt)',
    ' same => n,Playback(ss-noservice,noanswer)',
    ' same => n,Hangup(21)',
    ' same => n(toomany),NoOp(Zu viele gleichzeitige ausgehende Gespraeche)',
    ' same => n,Busy(5)', '');

  // Zeitplaene
  L('[mosi-sched]');
  for (const s of schedules) {
    L(`exten => ${s.id},1,NoOp(Zeitplan ${s.id})`);
    if (s.mode === 'open') L(' same => n,Return(open)');
    else if (s.mode === 'closed') L(' same => n,Return(closed)');
    else {
      for (const h of s.holidays || []) {
        const [mm, dd] = h.split('-').map(Number);
        L(` same => n,GotoIfTime(*,*,${dd},${MONTHS[mm - 1]},${settings.tz || 'Europe/Berlin'}?closed)`);
      }
      for (const r of s.rules || []) {
        const days = r.days.map((d) => DAYS[d % 7]);
        const to = minusMinute(r.to);
        L(` same => n,GotoIfTime(${r.from}-${to},${days.join('&')},*,*,${settings.tz || 'Europe/Berlin'}?open)`);
      }
      L(' same => n,Return(closed)');
    }
    L(' same => n(open),Return(open)', ' same => n(closed),Return(closed)');
  }
  L('');

  // Ziele
  L('[mosi-dest]');
  for (const e of exts) {
    L(`exten => ${e.number},hint,${e.enabled ? dialStr(e) : 'Custom:disabled' + e.number}`);
    L(`exten => ${e.number},1,NoOp(Nebenstelle ${e.number})`);
    if (!e.enabled) { L(' same => n,Congestion(5)'); continue; }
    L(' same => n,Gosub(mosi-hop,s,1)', ` same => n,Set(__PICKUPMARK=${e.number})`);
    const fwd = (target, label) => {
      if (/^[0-9]{2,6}$/.test(target) && numbers.has(target)) return [`Goto(mosi-dest,${target},1)`];
      if (/^\+?[0-9*#]{1,24}$/.test(target)) {
        if (!e.allow_external) throw new ConfigError(`Nebenstelle ${e.number}: ${label} auf externe Nummer erfordert die Berechtigung fuer externe Anrufe`);
        const cidOk = e.external_cid && trunkNumbers.some((tn) => tn.number === e.external_cid);
        return [`Set(MOSI_EXT=${e.number})`, `Set(MOSI_ALLOW_EXT=1)`, `Set(MOSI_ALLOW_INTL=${e.allow_international ? 1 : 0})`,
          `Set(MOSI_MAXOUT=${e.max_out_calls})`, `Set(MOSI_HIDECID=0)`, `Set(MOSI_CID=${cidOk ? e.external_cid : ''})`, `Goto(mosi-out,${target},1)`];
      }
      throw new ConfigError(`Nebenstelle ${e.number}: ${label} hat ein ungueltiges Ziel`);
    };
    if (e.fwd_always) { fwd(e.fwd_always, 'Rufumleitung sofort').forEach((l) => L(` same => n,${l}`)); L(''); continue; }
    // Besetzt-Zustand: laeuft bereits ein Gespraech auf einem Endgeraet der Nebenstelle (device_state_busy_at=1)
    L(` same => n,GotoIf($["\${DEVICE_STATE(PJSIP/${e.sip_username})}"="BUSY"${e.webrtc_enabled ? ` | "\${DEVICE_STATE(PJSIP/${e.sip_username}-web)}"="BUSY"` : ''}]?busy)`);
    L(...dsLines(e), ' same => n,GotoIf($["${MOSI_DS}"=""]?unavail)',
      ` same => n,Dial(\${MOSI_DS},${e.ring_timeout},tT)`,
      ' same => n,GotoIf($["${DIALSTATUS}"="BUSY"]?busy)',
      ' same => n,GotoIf($["${DIALSTATUS}"="NOANSWER"]?noanswer)',
      ' same => n,GotoIf($["${DIALSTATUS}"="CHANUNAVAIL" | "${DIALSTATUS}"="CONGESTION"]?unavail)',
      ' same => n,Hangup()');
    const handler = (label, target, vmFlag, dflt) => {
      L(` same => n(${label}),NoOp(${label})`);
      if (target) fwd(target, label).forEach((l) => L(` same => n,${l}`));
      else if (e.voicemail_enabled) L(` same => n,Voicemail(${e.number}@default,${vmFlag})`, ' same => n,Hangup()');
      else L(` same => n,${dflt}`);
    };
    handler('busy', e.fwd_busy, 'b', 'Busy(10)');
    handler('noanswer', e.fwd_noanswer, 'u', 'Hangup()');
    handler('unavail', e.fwd_unavail, 'u', 'Congestion(5)');
    L('');
  }

  for (const g of groups) {
    const members = g.members.map((m) => {
      const e = extByNum.get(m);
      if (!e) throw new ConfigError(`Mitglied ${m} ist keine Nebenstelle`);
      return e;
    }).filter((e) => e.enabled);
    L(`exten => ${g.number},1,NoOp(Rufgruppe ${g.number})`, ' same => n,Gosub(mosi-hop,s,1)');
    if (!members.length) L(' same => n,NoOp(Keine aktiven Mitglieder)');
    else if (g.strategy === 'ringall') {
      L(' same => n,Set(MOSI_DS=)');
      for (const e of members) L(` same => n,Gosub(mosi-ds,s,1(${e.sip_username}))`, ...(e.webrtc_enabled ? [` same => n,Gosub(mosi-dsw,s,1(${e.sip_username}-web))`] : []));
      L(' same => n,GotoIf($["${MOSI_DS}"=""]?nobody)', ` same => n,Dial(\${MOSI_DS},${g.timeout},tT)`);
    } else {
      for (const e of members) {
        L(...dsLines(e), ' same => n,GotoIf($["${MOSI_DS}"=""]?next' + e.id + ')', ` same => n,Dial(\${MOSI_DS},${g.timeout},tT)`,
          ' same => n,GotoIf($["${DIALSTATUS}"="ANSWER" | "${DIALSTATUS}"="CANCEL"]?done)', ` same => n(next${e.id}),NoOp(naechstes Mitglied)`);
      }
    }
    L(' same => n(nobody),NoOp(Niemand erreicht)',
      ' same => n,GotoIf($["${DIALSTATUS}"="ANSWER" | "${DIALSTATUS}"="CANCEL"]?done)',
      ` same => n,${destLine(g.fallback, `Rufgruppe ${g.number}`)}`, ' same => n(done),Hangup()', '');
  }

  for (const q of queues) {
    L(`exten => ${q.number},1,NoOp(Warteschlange ${q.number})`, ' same => n,Gosub(mosi-hop,s,1)', ' same => n,Answer()',
      ` same => n,Queue(q-${q.number},tT,,,${q.max_wait})`,
      ' same => n,GotoIf($["${QUEUESTATUS}"="" | "${DIALSTATUS}"="ANSWER" | "${DIALSTATUS}"="CANCEL"]?done)',
      ` same => n,${destLine(q.fallback, `Warteschlange ${q.number}`)}`, ' same => n(done),Hangup()', '');
  }

  for (const i of ivrs) L(`exten => ${i.number},1,Goto(mosi-ivr-${i.number},s,1)`);
  L('');

  for (const i of ivrs) {
    const greeting = i.greeting && sounds.has(i.greeting) ? `${SOUND_DIR}/${i.greeting}` : null;
    L(`[mosi-ivr-${i.number}]`, 'exten => s,1,NoOp(Telefonmenue)', ' same => n,Gosub(mosi-hop,s,1)', ' same => n,Answer()', ' same => n,Set(IVR_TRIES=0)',
      ' same => n(menu),Set(TIMEOUT(digit)=3)', ` same => n,Set(TIMEOUT(response)=${i.timeout})`);
    if (greeting) L(` same => n,Background(${greeting})`);
    L(` same => n,WaitExten(${i.timeout})`);
    const seen = new Set();
    for (const o of i.options) {
      if (!/^[0-9*#]$/.test(o.digit) || seen.has(o.digit)) throw new ConfigError(`IVR ${i.number}: ungueltige oder doppelte Taste ${o.digit}`);
      seen.add(o.digit);
      L(`exten => ${o.digit},1,${destLine(o.target, `IVR ${i.number} Taste ${o.digit}`)}`);
    }
    const retry = [` same => n,Set(IVR_TRIES=$[\${IVR_TRIES}+1])`, ` same => n,GotoIf($[\${IVR_TRIES}>=${i.retries}]?giveup)`];
    L('exten => i,1,Playback(pbx-invalid)', ...retry, ' same => n,Goto(s,menu)',
      ' same => n(giveup),NoOp(zu viele Fehlversuche)', ` same => n,${destLine(i.fallback, `IVR ${i.number}`)}`);
    L('exten => t,1,NoOp(Zeitueberschreitung)', ...retry, ' same => n,Goto(s,menu)',
      ' same => n(giveup),NoOp(keine Eingabe)', ` same => n,${destLine(i.fallback, `IVR ${i.number}`)}`, '');
  }

  // Funktionen
  L('[mosi-features]',
    'exten => *43,1,Answer()', ' same => n,Wait(1)', ' same => n,Playback(beep)', ' same => n,Echo()', ' same => n,Hangup()',
    'exten => *97,1,Answer()', ' same => n,Wait(1)', ' same => n,VoiceMailMain(${MOSI_EXT}@default,s)', ' same => n,Hangup()',
    'exten => *98,1,Answer()', ' same => n,Wait(1)', ' same => n,VoiceMailMain(@default)', ' same => n,Hangup()',
    'exten => _**X.,1,GotoIf($["${MOSI_PICKUP}"="1"]?ok)', ' same => n,Playback(ss-noservice,noanswer)', ' same => n,Hangup(21)',
    ' same => n(ok),Pickup(${EXTEN:2}@PICKUPMARK)', ' same => n,Hangup()');
  for (const c of contacts) if (c.short_code) L(`exten => ${c.short_code},1,Goto(mosi-internal,${c.number},1)`);
  L('');

  // Ausgehende Regeln
  L('[mosi-out]');
  const patSeen = new Set();
  for (const r of outRules) {
    if (!r.enabled) continue;
    const t = trunkById.get(r.trunk_id);
    if (!t || !t.enabled) continue;
    if (patSeen.has(r.pattern)) throw new ConfigError(`Ausgehende Regel: Wahlmuster ${r.pattern} ist mehrfach vorhanden`);
    patSeen.add(r.pattern);
    const tid = `trunk-${t.id}`;
    L(`exten => ${r.pattern},1,NoOp(Ausgehend Regel ${r.id} ueber ${tid})`,
      ` same => n,Gosub(mosi-outchk,s,1(${r.class},\${EXTEN}))`,
      ` same => n,Set(MOSI_NUM=${r.prepend}\${EXTEN:${r.strip}})`,
      ` same => n,Set(GROUP(trk)=${tid})`,
      ` same => n,GotoIf($[\${GROUP_COUNT(${tid}@trk)}>${t.max_channels}]?busy)`);
    if (t.caller_id) L(` same => n,Set(CALLERID(num)=\${IF($["\${MOSI_CID}"=""]?${t.caller_id}:\${MOSI_CID})})`);
    else L(' same => n,ExecIf($["${MOSI_CID}"!=""]?Set(CALLERID(num)=${MOSI_CID}))');
    L(' same => n,Set(CALLERID(name)=)', ' same => n,ExecIf($["${MOSI_HIDECID}"="1"]?Set(CALLERID(pres)=prohib))',
      ` same => n,Dial(PJSIP/\${MOSI_NUM}@${tid},60,T)`, ' same => n,Hangup()',
      ' same => n(busy),NoOp(Trunk ausgelastet)', ' same => n,Busy(5)');
  }
  L('');

  L('[mosi-fallback]', 'exten => _X.,1,NoOp(Unbekanntes Ziel ${EXTEN})', ' same => n,Playback(ss-noservice,noanswer)', ' same => n,Hangup(1)',
    'exten => _*X.,1,NoOp(Unbekannte Funktion ${EXTEN})', ' same => n,Playback(ss-noservice,noanswer)', ' same => n,Hangup(1)', '');

  L('[mosi-internal]', 'include => mosi-features', 'include => mosi-dest', 'include => mosi-out', 'include => mosi-fallback', '');

  for (const t of trunks) {
    if (!t.enabled) continue;
    L(`[mosi-in-${t.id}]`);
    const mine = trunkNumbers.filter((n) => n.trunk_id === t.id);
    const seen = new Set();
    for (const n of mine) {
      for (const variant of new Set([n.number, n.number.replace(/^\+/, '')])) {
        if (seen.has(variant)) continue;
        seen.add(variant);
        L(`exten => ${variant},1,NoOp(Eingehend ${n.number} ueber trunk-${t.id})`);
        const s = n.schedule_id ? schedById.get(n.schedule_id) : null;
        if (s) {
          L(` same => n,Gosub(mosi-sched,${s.id},1)`, ' same => n,GotoIf($["${GOSUB_RETVAL}"="open"]?open:closed)',
            ` same => n(open),${destLine(n.dest_open, `Rufnummer ${n.number}`)}`, ` same => n(closed),${destLine(n.dest_closed, `Rufnummer ${n.number}`)}`);
        } else L(` same => n,${destLine(n.dest_open, `Rufnummer ${n.number}`)}`);
      }
    }
    L('exten => _[0-9+*#].,1,NoOp(Eingehender Ruf auf nicht zugeordnete Nummer ${EXTEN})',
      ` same => n,${t.default_inbound && t.default_inbound !== 'hangup' ? destLine(t.default_inbound, `Trunk ${t.name}`) : 'Hangup(1)'}`, '');
  }

  // ---- voicemail / queues ---------------------------------------------------
  const vm = ['; Erzeugt von Mosi Cloud PBX', '[default]'];
  for (const e of exts) if (e.enabled && e.voicemail_enabled) vm.push(`${e.number} => ${e.voicemail_pin},${e.display_name},,,attach=no|tz=berlin`);
  const qc = ['; Erzeugt von Mosi Cloud PBX'];
  for (const q of queues) {
    qc.push(`[q-${q.number}]`, `strategy=${q.strategy}`, `timeout=${q.timeout}`, 'retry=5', 'wrapuptime=5', 'ringinuse=no',
      'musiconhold=default', 'joinempty=paused,unavailable,invalid', 'leavewhenempty=paused,unavailable,invalid', 'announce-frequency=0');
    for (const m of q.members) {
      const e = extByNum.get(m);
      if (!e) throw new ConfigError(`Warteschlange ${q.number}: Mitglied ${m} ist keine Nebenstelle`);
      if (!e.enabled) continue;
      qc.push(`member => PJSIP/${e.sip_username},0,${e.display_name}`);
      if (e.webrtc_enabled) qc.push(`member => PJSIP/${e.sip_username}-web,0,${e.display_name} (Browser)`);
    }
    qc.push('');
  }

  const files = {
    'pjsip_mosi.conf': pj.join('\n') + '\n',
    'extensions_mosi.conf': dp.join('\n') + '\n',
    'voicemail_mosi.conf': vm.join('\n') + '\n',
    'queues_mosi.conf': qc.join('\n') + '\n',
  };
  return {
    files,
    expected: {
      endpoints: exts.filter((e) => e.enabled).flatMap((e) => [e.sip_username, ...(e.webrtc_enabled ? [`${e.sip_username}-web`] : [])])
        .concat(trunks.filter((t) => t.enabled).map((t) => `trunk-${t.id}`)),
      extensions: [...numbers.keys()],
      queues: queues.map((q) => `q-${q.number}`),
      trunkRegistrations: trunks.filter((t) => t.enabled && t.auth_mode === 'register').map((t) => `trunk-${t.id}`),
    },
  };
}

function minusMinute(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const t = (h * 60 + m - 1 + 1440) % 1440;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
}

/** Entfernt Geheimnisse, damit Revisionen gefahrlos gespeichert werden koennen. */
function redact(text) {
  return text.replace(/^(password=).*$/gm, '$1***').replace(/^(\d+ => )[^,]*/gm, '$1***');
}

module.exports = { generate, redact, ConfigError, DEFAULT_BLOCKED };
