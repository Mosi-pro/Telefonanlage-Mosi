'use strict';
const path = require('path');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const config = require('./config');
const log = require('./log');
const db = require('./db');
const Ami = require('./ami');
const auth = require('./auth');
const apply = require('./apply');
const monitor = require('./monitor');
const cdr = require('./cdr');
const status = require('./status');

async function main() {
  log.info('Mosi Cloud PBX Backend startet', { version: config.version });
  await db.waitForDb();
  await db.migrate();
  await auth.bootstrapAdmin();

  const ami = new Ami({ host: config.asterisk.host, port: config.asterisk.amiPort, user: config.asterisk.amiUser, secret: config.asterisk.amiSecret });
  apply.setAmi(ami); monitor.init(ami); status.init(ami);
  let syncing = false;
  ami.on('connected', async () => {
    if (syncing) return; syncing = true;
    try { await apply.sync('Start/Neuverbindung'); status.setSync(true); await monitor.event('info', 'backend', 'Telefoniekonfiguration synchronisiert'); }
    catch (e) { status.setSync(false, e.message); await monitor.event('error', 'backend', `Konfigurationssynchronisation fehlgeschlagen: ${e.message}`); }
    finally { syncing = false; }
  });
  ami.on('disconnected', () => monitor.event('error', 'backend', 'Verbindung zur Telefonie-Engine verloren'));
  ami.start();
  cdr.start();
  setInterval(() => auth.cleanup().catch((e) => log.error('Bereinigung fehlgeschlagen', { error: e.message })), 3600_000).unref();

  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  app.use(helmet({
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'"], styleSrcAttr: ["'unsafe-inline'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'", 'wss:', 'ws:'], mediaSrc: ["'self'", 'blob:'], frameAncestors: ["'none'"], objectSrc: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"] } },
    hsts: config.secureCookies ? { maxAge: 31536000 } : false,
  }));
  app.use('/api', rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false, message: { error: 'Zu viele Anfragen' } }));
  app.use('/api', express.json({ limit: '200kb' }));
  app.use('/api', (req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });
  app.use('/api', auth.sessionLoader);
  app.use('/api', require('./routes/system'));
  app.use('/api', require('./routes/telephony'));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Unbekannter API-Pfad' }));
  app.use(express.static(config.frontendDir, { maxAge: '1h', index: 'index.html' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err.code === '23505') return res.status(409).json({ error: 'Eintrag existiert bereits (Nummer/Name/Benutzername doppelt)' });
    if (err.code === '23503') return res.status(409).json({ error: 'Eintrag wird noch verwendet und kann nicht geaendert werden' });
    if (err.code === '23514') return res.status(400).json({ error: 'Ungueltiger Wert' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Ungueltiges JSON' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Anfrage zu gross' });
    const status = err.status || 500;
    if (status >= 500) log.error('Unbehandelter Fehler', { path: req.path, error: err.message, stack: err.stack });
    res.status(status).json({ error: status >= 500 && status !== 503 ? 'Interner Fehler' : err.message, field: err.field });
  });

  const server = app.listen(config.port, () => log.info('API lauscht', { port: config.port }));
  const shutdown = () => { log.info('Beende...'); server.close(); ami.stop(); cdr.stop(); db.pool.end().finally(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}

main().catch((e) => { log.error('Start fehlgeschlagen', { error: e.message, stack: e.stack }); process.exit(1); });
