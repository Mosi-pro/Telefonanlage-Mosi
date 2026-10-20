'use strict';
// Echte SIP-Erreichbarkeitspruefung: sendet OPTIONS per UDP/TCP an die Engine und wertet die Antwort aus.
const dgram = require('dgram');
const net = require('net');
const crypto = require('crypto');
const config = require('./config');

function request(host) {
  const branch = 'z9hG4bK' + crypto.randomBytes(6).toString('hex');
  return [
    `OPTIONS sip:${host} SIP/2.0`, `Via: SIP/2.0/UDP 127.0.0.1:5090;branch=${branch}`, 'Max-Forwards: 70',
    `From: <sip:probe@mosi.local>;tag=${crypto.randomBytes(4).toString('hex')}`, `To: <sip:${host}>`,
    `Call-ID: ${crypto.randomBytes(8).toString('hex')}@mosi.local`, 'CSeq: 1 OPTIONS', 'Content-Length: 0', '', '',
  ].join('\r\n');
}

function udp(host, port, timeout = 2000) {
  return new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    const t = setTimeout(() => { s.close(); resolve({ ok: false, error: 'keine Antwort (Zeitueberschreitung)' }); }, timeout);
    s.on('message', (m) => { clearTimeout(t); s.close(); const line = m.toString().split('\r\n')[0]; resolve({ ok: /^SIP\/2\.0 (200|401|403|404)/.test(line), response: line }); });
    s.on('error', (e) => { clearTimeout(t); try { s.close(); } catch { /* ignore */ } resolve({ ok: false, error: e.message }); });
    s.send(request(host), port, host);
  });
}

function tcp(host, port, timeout = 2000) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const t = setTimeout(() => { s.destroy(); resolve({ ok: false, error: 'Zeitueberschreitung' }); }, timeout);
    s.on('connect', () => { clearTimeout(t); s.destroy(); resolve({ ok: true }); });
    s.on('error', (e) => { clearTimeout(t); resolve({ ok: false, error: e.code || e.message }); });
  });
}

const probeSipUdp = () => udp(config.asterisk.host, config.asterisk.sipPort);
const probeTcp = (host, port) => tcp(host, port);

module.exports = { probeSipUdp, probeTcp };
