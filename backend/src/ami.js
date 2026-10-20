'use strict';
// Minimaler Asterisk-Manager-Interface-Client (TCP, kein Fremdpaket).
const net = require('net');
const EventEmitter = require('events');
const log = require('./log');

class Ami extends EventEmitter {
  constructor({ host, port, user, secret }) {
    super();
    Object.assign(this, { host, port, user, secret });
    this.sock = null;
    this.connected = false;
    this.buf = '';
    this.pending = new Map(); // ActionID -> {resolve,reject,events,list,timer}
    this.seq = 0;
    this.retry = 1000;
    this.version = null;
    this.stopped = false;
  }

  start() { this.stopped = false; this._connect(); }
  stop() { this.stopped = true; if (this.sock) this.sock.destroy(); }

  _connect() {
    if (this.stopped) return;
    const sock = net.connect({ host: this.host, port: this.port });
    this.sock = sock;
    this.buf = '';
    this.greeted = false;
    sock.setEncoding('utf8');
    sock.setKeepAlive(true, 15000);
    sock.on('data', (d) => this._onData(d));
    sock.on('error', (e) => { this.lastError = e.message; });
    sock.on('close', () => {
      const was = this.connected;
      this.connected = false;
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error('AMI-Verbindung getrennt')); }
      this.pending.clear();
      if (was) { log.warn('AMI-Verbindung getrennt'); this.emit('disconnected'); }
      if (!this.stopped) setTimeout(() => this._connect(), this.retry = Math.min(this.retry * 2, 15000));
    });
  }

  _onData(chunk) {
    this.buf += chunk;
    if (!this.greeted) {
      const i = this.buf.indexOf('\r\n');
      if (i < 0) return;
      this.version = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 2);
      this.greeted = true;
      this._login();
    }
    let idx;
    while ((idx = this.buf.indexOf('\r\n\r\n')) >= 0) {
      const block = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 4);
      this._onBlock(block);
    }
  }

  _parse(block) {
    const m = {};
    for (const line of block.split('\r\n')) {
      const i = line.indexOf(':');
      if (i > 0) {
        const k = line.slice(0, i).trim(); const v = line.slice(i + 1).replace(/^ /, '');
        if (k === 'Output') m.output = m.output === undefined ? v : `${m.output}\n${v}`;
        else m[k] = v.trim();
      } else if (line && !m._raw) m._raw = line;
    }
    return m;
  }

  _onBlock(block) {
    // "Command"-Antworten enthalten freien Text, der nicht Key:Value ist
    if (/^Response: /.test(block) && /\r\n--END COMMAND--$/.test(block)) {
      const m = this._parse(block.replace(/\r\n--END COMMAND--$/, '').split('\r\n').filter((l) => /^(Response|ActionID|Message|Privilege):/.test(l)).join('\r\n'));
      const body = block.split('\r\n').filter((l) => !/^(Response|ActionID|Message|Privilege):/.test(l)).join('\n').replace(/\n--END COMMAND--$/, '');
      m.output = body;
      return this._response(m);
    }
    const m = this._parse(block);
    if (m.Response && !m.Event) return this._response(m);
    if (m.Event) {
      const p = this.pending.get(m.ActionID);
      if (p && p.list) {
        if (/Complete$/.test(m.Event)) { this.pending.delete(m.ActionID); clearTimeout(p.timer); p.resolve(p.events); }
        else p.events.push(m);
        return;
      }
      this.emit('event', m);
      this.emit(m.Event, m);
    }
  }

  _response(m) {
    const p = this.pending.get(m.ActionID);
    if (!p) return;
    if (m.Response === 'Error' && p.list && /^No .*found/i.test(m.Message || '')) { this.pending.delete(m.ActionID); clearTimeout(p.timer); return p.resolve([]); }
    if (m.Response === 'Error') { this.pending.delete(m.ActionID); clearTimeout(p.timer); return p.reject(new Error(m.Message || 'AMI-Fehler')); }
    if (p.list && /follow/i.test(m.Message || '')) return; // Liste folgt als Events
    this.pending.delete(m.ActionID); clearTimeout(p.timer);
    p.resolve(m);
  }

  _write(fields) {
    this.sock.write(Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join('\r\n') + '\r\n\r\n');
  }

  _login() {
    const id = `login-${++this.seq}`;
    this.pending.set(id, {
      list: false,
      timer: setTimeout(() => this.sock.destroy(), 5000),
      resolve: () => { this.connected = true; this.retry = 1000; log.info('AMI verbunden', { server: this.version }); this.emit('connected'); },
      reject: (e) => { log.error('AMI-Anmeldung fehlgeschlagen', { error: e.message }); this.lastError = e.message; this.sock.destroy(); },
    });
    this._write({ Action: 'Login', Username: this.user, Secret: this.secret, ActionID: id });
  }

  /** Sendet eine Aktion. Mit list=true werden die Events bis *Complete gesammelt. */
  action(fields, { list = false, timeout = 8000 } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.connected) return reject(new Error('Asterisk-AMI nicht verbunden'));
      const id = `a-${++this.seq}`;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`AMI-Zeitueberschreitung (${fields.Action})`)); }, timeout);
      this.pending.set(id, { resolve, reject, list, events: [], timer });
      this._write({ ...fields, ActionID: id });
    });
  }

  /** Fuehrt einen CLI-Befehl aus. Nur fest im Code stehende Befehle verwenden! */
  async command(cmd) {
    const r = await this.action({ Action: 'Command', Command: cmd });
    return r.output || '';
  }
}

module.exports = Ami;
