// Steuert Chromium (Fake-Mikrofon): Anmeldung, Browsertelefon oeffnen, Nummer anrufen, WebRTC-Statistik ausgeben.
// Aufruf: node webrtc_browser.js <https-url> <benutzer> <passwort> <zielnummer> [sekunden]
const { chromium } = require('playwright');
(async () => {
  const [base, user, pass, target, secs = '6'] = process.argv.slice(2);
  const incoming = target === 'INCOMING';   // Modus: warten, bis jemand anruft, dann annehmen
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    args: ['--no-sandbox', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--ignore-certificate-errors', '--no-proxy-server'],
  });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ['microphone'] });
  const page = await ctx.newPage();
  const out = { registered: false, ringing: false, inCall: false, errors: [] };
  page.on('pageerror', (e) => out.errors.push(e.message));
  await page.goto(base);
  await page.fill('#u', user); await page.fill('#p', pass); await page.click('button[type=submit]');
  await page.waitForSelector('.nav');
  await page.goto(`${base}/#/webphone`);
  try { await page.waitForSelector('.phone .badge.ok', { timeout: 20000 }); out.registered = true; } catch { out.regText = await page.textContent('.phone .badge'); out.err = await page.textContent('.phone .notice.err').catch(() => null); }
  if (out.registered && incoming) {
    await page.evaluate(() => { const O = window.RTCPeerConnection; window.__pcs = []; window.RTCPeerConnection = function (...a) { const pc = new O(...a); window.__pcs.push(pc); return pc; }; window.RTCPeerConnection.prototype = O.prototype; });
    console.log(JSON.stringify({ ready: true }));
    try { await page.waitForSelector('.phone .state:has-text("Eingehender Anruf")', { timeout: 40000 }); out.ringing = true; } catch { out.err = 'kein eingehender Anruf'; }
    if (out.ringing) {
      out.caller = await page.textContent('.phone .num');
      await page.click('button:has-text("Annehmen")');
      try { await page.waitForSelector('.phone .state:has-text("Im Gespräch")', { timeout: 15000 }); out.inCall = true; } catch { out.err = await page.textContent('.phone .notice.err').catch(() => null); }
      if (out.inCall) {
        await page.waitForTimeout(Number(secs) * 1000);
        out.stats = await page.evaluate(async () => {
          const r = { inboundPackets: 0, outboundPackets: 0, dtls: null };
          for (const pc of window.__pcs) { (await pc.getStats()).forEach((s) => { if (s.type === 'inbound-rtp' && s.kind === 'audio') r.inboundPackets += s.packetsReceived; if (s.type === 'outbound-rtp' && s.kind === 'audio') r.outboundPackets += s.packetsSent; if (s.type === 'transport') r.dtls = s.dtlsState; }); }
          return r;
        });
        await page.waitForSelector('.phone .state:has-text("beendet")', { timeout: 15000 }).catch(() => {});
        out.endState = await page.textContent('.phone .state');   // Gegenseite legt auf
      }
    }
  } else if (out.registered) {
    // Verbindungsstatistik der RTCPeerConnection mitschneiden
    await page.evaluate(() => { const O = window.RTCPeerConnection; window.__pcs = []; window.RTCPeerConnection = function (...a) { const pc = new O(...a); window.__pcs.push(pc); return pc; }; window.RTCPeerConnection.prototype = O.prototype; });
    await page.fill('input[type=tel]', target);
    await page.click('button.call');
    try { await page.waitForSelector('.phone .state:has-text("Im Gespräch")', { timeout: 25000 }); out.inCall = true; } catch { out.stateText = await page.textContent('.phone .state'); out.err = await page.textContent('.phone .notice.err').catch(() => null); }
    if (out.inCall) {
      await page.waitForTimeout(Number(secs) * 1000);
      out.stats = await page.evaluate(async () => {
        const r = { inboundPackets: 0, inboundBytes: 0, outboundPackets: 0, dtls: null, codec: null };
        for (const pc of window.__pcs) {
          const st = await pc.getStats();
          st.forEach((s) => {
            if (s.type === 'inbound-rtp' && s.kind === 'audio') { r.inboundPackets += s.packetsReceived; r.inboundBytes += s.bytesReceived; }
            if (s.type === 'outbound-rtp' && s.kind === 'audio') r.outboundPackets += s.packetsSent;
            if (s.type === 'transport') r.dtls = s.dtlsState;
            if (s.type === 'codec') r.codec = s.mimeType;
          });
        }
        return r;
      });
      // DTMF + Stummschaltung ausprobieren
      await page.click('.keypad button:has-text("5")'); await page.click('button.mute'); await page.waitForTimeout(500);
      out.muteLabel = await page.textContent('.phone button.mute');
      await page.click('button.hang');
      await page.waitForSelector('.phone .state:has-text("beendet")', { timeout: 10000 }).catch(() => {});
      out.endState = await page.textContent('.phone .state');
    }
  }
  console.log(JSON.stringify(out));
  await browser.close();
})().catch((e) => { console.log(JSON.stringify({ fatal: e.message })); process.exit(2); });
