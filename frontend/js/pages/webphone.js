import { h, toast, fmtDur } from '../ui.js';
import { get } from '../api.js';

function loadJsSip() {
  if (window.JsSIP) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/jssip.min.js';
    s.onload = resolve; s.onerror = () => reject(new Error('Telefon-Bibliothek (JsSIP) konnte nicht geladen werden'));
    document.head.append(s);
  });
}

// Verstaendliche Fehlertexte fuer typische Fehlerursachen
function mediaError(e) {
  switch (e && e.name) {
    case 'NotAllowedError': case 'SecurityError': return 'Zugriff auf das Mikrofon wurde verweigert. Erlauben Sie das Mikrofon in der Adressleiste des Browsers und versuchen Sie es erneut.';
    case 'NotFoundError': case 'OverconstrainedError': return 'Es wurde kein Mikrofon gefunden. Schließen Sie ein Mikrofon bzw. Headset an.';
    case 'NotReadableError': return 'Das Mikrofon wird bereits von einer anderen Anwendung verwendet.';
    default: return `Mikrofonfehler: ${e && e.message ? e.message : e}`;
  }
}
const CAUSES = { Busy: 'Besetzt', Rejected: 'Abgelehnt', 'Unavailable': 'Teilnehmer nicht erreichbar', 'Not Found': 'Rufnummer nicht gefunden', 'Authentication Error': 'Anmeldung am Server fehlgeschlagen', 'Connection Error': 'Verbindung zum Server fehlgeschlagen', 'Request Timeout': 'Zeitüberschreitung', 'Address Incomplete': 'Rufnummer unvollständig', 'Canceled': 'Abgebrochen', 'No Answer': 'Keine Antwort', 'SIP Failure Code': 'Anruf vom Server abgelehnt (evtl. keine Berechtigung für dieses Ziel)', 'Forbidden': 'Nicht erlaubt', 'Expires': 'Zeitüberschreitung', 'WebRTC Error': 'Medienverbindung fehlgeschlagen (ICE/DTLS) – Netzwerk/STUN/TURN prüfen', 'User Denied Media Access': 'Mikrofonzugriff verweigert', 'Unsupported SDP': 'Codec-Aushandlung fehlgeschlagen' };

export default async function render(el) {
  const insecure = !window.isSecureContext || !navigator.mediaDevices;
  if (insecure) {
    el.append(h('div', { class: 'notice err' }, h('strong', {}, 'HTTPS erforderlich: '), 'Browser erlauben den Mikrofonzugriff nur über HTTPS mit einem vertrauenswürdigen Zertifikat (oder localhost). Installieren Sie das Zertifikat der Anlage im Browser bzw. hinterlegen Sie ein eigenes Zertifikat (docs/network.md).'));
    return;
  }
  const cfg = await get('/webphone/config');
  if (!cfg.extensions.length) {
    el.append(h('div', { class: 'notice' }, 'Ihnen ist keine Nebenstelle mit aktivierter Browsertelefonie zugeordnet. Ein Administrator kann Ihren Benutzer unter „Nebenstellen“ zuordnen.'));
    return;
  }
  await loadJsSip();
  const JsSIP = window.JsSIP;

  const sel = h('select', { 'aria-label': 'Eigene Nebenstelle' }, cfg.extensions.map((e) => h('option', { value: e.id }, `${e.number} – ${e.display_name}`)));
  const regBadge = h('span', { class: 'badge' }, 'nicht verbunden');
  const stateEl = h('div', { class: 'state' }, 'Bereit');
  const numEl = h('div', { class: 'num' }, '');
  const durEl = h('div', { class: 'muted' }, '');
  const audio = h('audio', { autoplay: true });
  const errBox = h('div', { class: 'notice err', hidden: true, role: 'alert' });
  const dial = h('input', { type: 'tel', inputmode: 'tel', placeholder: 'Rufnummer eingeben', 'aria-label': 'Rufnummer', autocomplete: 'off' });
  const callBtn = h('button', { class: 'call' }, 'Anrufen');
  const hangBtn = h('button', { class: 'hang', hidden: true }, 'Auflegen');
  const answerBtn = h('button', { class: 'call', hidden: true }, 'Annehmen');
  const muteBtn = h('button', { class: 'mute', hidden: true }, 'Stumm');
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

  let ua = null; let session = null; let timer = null; let started = 0; let muted = false; let ringer = null;
  const showErr = (m) => { errBox.hidden = !m; errBox.textContent = m || ''; };

  // Einfacher Klingelton ueber WebAudio (kein Audio-Asset noetig)
  function startRing() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator(); const gain = ctx.createGain();
      osc.frequency.value = 440; osc.connect(gain); gain.connect(ctx.destination); gain.gain.value = 0; osc.start();
      let on = false; const iv = setInterval(() => { on = !on; gain.gain.value = on ? 0.15 : 0; }, 800);
      ringer = () => { clearInterval(iv); osc.stop(); ctx.close(); ringer = null; };
    } catch { /* kein Ton moeglich */ }
  }
  const stopRing = () => { if (ringer) ringer(); };

  function setUi(mode) {
    const inCall = mode === 'call'; const ringing = mode === 'incoming'; const calling = mode === 'dialing';
    callBtn.hidden = inCall || ringing || calling; hangBtn.hidden = !(inCall || ringing || calling); answerBtn.hidden = !ringing; muteBtn.hidden = !inCall;
    dial.disabled = inCall || ringing || calling;
  }
  function tick() { durEl.textContent = fmtDur((Date.now() - started) / 1000); }
  function end(reason) {
    clearInterval(timer); stopRing(); session = null; muted = false; muteBtn.textContent = 'Stumm'; durEl.textContent = ''; audio.srcObject = null;
    stateEl.textContent = reason || 'Bereit'; numEl.textContent = ''; setUi('idle');
  }

  function attach(s) {
    session = s;
    s.on('peerconnection', (e) => { e.peerconnection.addEventListener('track', (ev) => { audio.srcObject = ev.streams[0]; audio.play().catch(() => {}); }); });
    s.on('progress', () => { stateEl.textContent = 'Es klingelt…'; });
    s.on('accepted', () => { stateEl.textContent = 'Im Gespräch'; started = Date.now(); clearInterval(timer); timer = setInterval(tick, 1000); stopRing(); setUi('call'); });
    s.on('confirmed', () => { const pc = s.connection; if (pc) pc.getReceivers().forEach((r) => { if (r.track && r.track.kind === 'audio') { audio.srcObject = new MediaStream([r.track]); audio.play().catch(() => {}); } }); });
    s.on('ended', () => end('Gespräch beendet'));
    s.on('failed', (e) => { const c = e.cause; end(`Anruf fehlgeschlagen: ${CAUSES[c] || c}`); showErr(`Anruf fehlgeschlagen: ${CAUSES[c] || c}${e.message && e.message.status_code ? ` (SIP ${e.message.status_code})` : ''}`); });
  }

  function connect(ext) {
    if (ua) { ua.stop(); ua = null; }
    regBadge.className = 'badge'; regBadge.textContent = 'verbinde…'; showErr('');
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    const socket = new JsSIP.WebSocketInterface(`${scheme}://${location.host}${cfg.wsPath}`);
    ua = new JsSIP.UA({ sockets: [socket], uri: `sip:${ext.username}@${cfg.domain}`, authorization_user: ext.authUsername, password: ext.password, display_name: ext.display_name, register: true, register_expires: 300, session_timers: false });
    ua.on('registered', () => { regBadge.className = 'badge ok'; regBadge.textContent = 'registriert'; showErr(''); });
    ua.on('unregistered', () => { regBadge.className = 'badge warn'; regBadge.textContent = 'abgemeldet'; });
    ua.on('registrationFailed', (e) => { regBadge.className = 'badge err'; regBadge.textContent = 'Registrierung fehlgeschlagen'; showErr(`Registrierung fehlgeschlagen: ${CAUSES[e.cause] || e.cause}. ${e.cause === 'Authentication Error' ? 'Die Zugangsdaten werden vom Server nicht akzeptiert – Nebenstelle prüfen.' : 'Prüfen Sie Netzwerk, HTTPS-Zertifikat und die Erreichbarkeit der Anlage.'}`); });
    ua.on('disconnected', () => { regBadge.className = 'badge err'; regBadge.textContent = 'getrennt'; });
    ua.on('connected', () => { regBadge.textContent = 'verbunden, registriere…'; });
    ua.on('newRTCSession', (e) => {
      if (e.originator !== 'remote') return;
      if (session) { e.session.terminate({ status_code: 486, reason_phrase: 'Busy Here' }); return; }
      attach(e.session);
      numEl.textContent = e.session.remote_identity.display_name || e.session.remote_identity.uri.user;
      stateEl.textContent = 'Eingehender Anruf'; setUi('incoming'); startRing();
    });
    ua.start();
  }

  async function startCall() {
    showErr('');
    const target = dial.value.trim().replace(/[\s-]/g, '');
    if (!/^\+?[0-9*#]{1,24}$/.test(target)) { showErr('Bitte eine gültige Rufnummer eingeben (Ziffern, *, #).'); return; }
    if (!ua || !ua.isRegistered()) { showErr('Das Browsertelefon ist nicht registriert – Anruf nicht möglich.'); return; }
    try { const probe = await navigator.mediaDevices.getUserMedia({ audio: true }); probe.getTracks().forEach((t) => t.stop()); } catch (e) { showErr(mediaError(e)); return; }
    numEl.textContent = target; stateEl.textContent = 'Wähle…'; setUi('dialing');
    const s = ua.call(`sip:${target}@${cfg.domain}`, { mediaConstraints: { audio: true, video: false }, pcConfig: { iceServers: cfg.iceServers }, rtcOfferConstraints: { offerToReceiveAudio: true } });
    attach(s);
  }
  async function answer() {
    showErr('');
    try { const probe = await navigator.mediaDevices.getUserMedia({ audio: true }); probe.getTracks().forEach((t) => t.stop()); } catch (e) { showErr(mediaError(e)); session?.terminate(); return; }
    stopRing();
    session.answer({ mediaConstraints: { audio: true, video: false }, pcConfig: { iceServers: cfg.iceServers } });
  }

  callBtn.addEventListener('click', startCall);
  answerBtn.addEventListener('click', answer);
  hangBtn.addEventListener('click', () => { if (session) session.terminate(); else end(); });
  muteBtn.addEventListener('click', () => { if (!session) return; muted = !muted; if (muted) session.mute({ audio: true }); else session.unmute({ audio: true }); muteBtn.textContent = muted ? 'Stumm aus' : 'Stumm'; stateEl.textContent = muted ? 'Im Gespräch (stumm)' : 'Im Gespräch'; });
  dial.addEventListener('keydown', (e) => { if (e.key === 'Enter') startCall(); });
  const pad = h('div', { class: 'keypad' }, keys.map((k) => h('button', { type: 'button', 'aria-label': `Taste ${k}`, onClick: () => {
    if (session && session.isEstablished()) { try { session.sendDTMF(k, { duration: 120, interToneGap: 80 }); } catch { /* ignore */ } numEl.textContent = (numEl.textContent + k).slice(-24); beep(k); }
    else dial.value += k;
  } }, k)));
  function beep(k) { // lokaler Tastenton
    try { const c = new (window.AudioContext || window.webkitAudioContext)(); const o = c.createOscillator(); const g = c.createGain(); o.frequency.value = 350 + keys.indexOf(k) * 60; g.gain.value = 0.08; o.connect(g); g.connect(c.destination); o.start(); setTimeout(() => { o.stop(); c.close(); }, 100); } catch { /* ignore */ }
  }
  sel.addEventListener('change', () => { if (session) session.terminate(); connect(cfg.extensions.find((e) => String(e.id) === sel.value)); });

  el.append(h('div', { class: 'phone' }, h('div', { class: 'card' },
    h('div', { class: 'field' }, h('label', {}, 'Meine Nebenstelle'), sel), h('p', {}, 'Status: ', regBadge), errBox,
    h('div', { class: 'display' }, stateEl, numEl, durEl), dial, pad,
    h('div', { class: 'row' }, callBtn, answerBtn, hangBtn), h('div', { class: 'row' }, muteBtn), audio)),
  h('p', { class: 'muted' }, 'Audio läuft verschlüsselt (WSS + DTLS-SRTP) zwischen Browser und Telefonanlage. Über Netzgrenzen hinweg (NAT, Mobilfunk) ist je nach Netzwerk ein VPN oder TURN-Server nötig – siehe docs/network.md.'));
  setUi('idle');
  connect(cfg.extensions[0]);
  return () => { if (session) { try { session.terminate(); } catch { /* ignore */ } } if (ua) ua.stop(); stopRing(); clearInterval(timer); };
}
