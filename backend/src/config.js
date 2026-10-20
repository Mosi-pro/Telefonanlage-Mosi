'use strict';
// Zentrale Konfiguration aus Umgebungsvariablen (siehe .env.example).
const env = process.env;

function required(name) {
  const v = env[name];
  if (!v) throw new Error(`Umgebungsvariable ${name} fehlt (siehe .env.example)`);
  return v;
}
const int = (name, def) => {
  const v = parseInt(env[name] ?? '', 10);
  return Number.isFinite(v) ? v : def;
};

module.exports = {
  port: int('PORT', 3000),
  frontendDir: env.FRONTEND_DIR || require('path').join(__dirname, '..', 'public'),
  databaseUrl: env.DATABASE_URL || required('DATABASE_URL'),
  appSecret: env.APP_SECRET || required('APP_SECRET'),
  hostIp: env.HOST_IP || '127.0.0.1',
  hostName: env.MOSI_HOSTNAME || env.HOST_IP || 'localhost',
  tz: env.TZ || 'Europe/Berlin',
  secureCookies: (env.SECURE_COOKIES ?? 'true') === 'true',
  trustProxy: (env.TRUST_PROXY ?? 'true') === 'true',
  asterisk: {
    host: env.ASTERISK_HOST || 'asterisk',
    amiPort: int('AMI_PORT', 5038),
    amiUser: env.AMI_USER || 'mosi',
    amiSecret: env.AMI_SECRET || required('AMI_SECRET'),
    sipPort: int('SIP_PORT', 5060),
    sipTlsPort: int('SIP_TLS_PORT', 5061),
    sipTlsEnabled: (env.SIP_TLS_ENABLED ?? 'false') === 'true',
    wsPort: 8088,
    rtpStart: int('RTP_START', 10000),
    rtpEnd: int('RTP_END', 10099),
    generatedDir: env.ASTERISK_GENERATED_DIR || '/etc/asterisk/mosi',
    logDir: env.ASTERISK_LOG_DIR || '/var/log/asterisk',
    voicemailDir: env.VOICEMAIL_DIR || '/var/spool/asterisk/voicemail',
    soundsDir: env.SOUNDS_DIR || '/var/lib/mosi/sounds',
  },
  network: {
    adminAllowedNets: env.ADMIN_ALLOWED_NETS || 'private_ranges',
    sipAllowedNets: env.SIP_ALLOWED_NETS || '192.168.0.0/16,10.0.0.0/8,172.16.0.0/12',
    httpsPort: int('HTTPS_PORT', 443),
  },
  limits: {
    loginMaxFailures: int('LOGIN_MAX_FAILURES', 5),
    loginLockMinutes: int('LOGIN_LOCK_MINUTES', 15),
    sessionHours: int('SESSION_HOURS', 12),
    callRetentionDays: int('CALL_RETENTION_DAYS', 365),
  },
  bootstrapAdmin: {
    username: env.ADMIN_USER || 'admin',
    password: env.ADMIN_PASSWORD || '',
  },
  version: require('../package.json').version,
};
