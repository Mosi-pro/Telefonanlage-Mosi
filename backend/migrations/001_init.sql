-- Mosi Cloud PBX - Schema v1
CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  display_name  TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('admin','operator','user')),
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until  TIMESTAMPTZ,
  last_login    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf       TEXT NOT NULL,
  ip         TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  last_seen  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE login_attempts (
  id SERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  ip TEXT NOT NULL,
  username TEXT,
  ok BOOLEAN NOT NULL
);
CREATE INDEX login_attempts_ip_ts ON login_attempts (ip, ts);

CREATE TABLE extensions (
  id              SERIAL PRIMARY KEY,
  number          TEXT NOT NULL UNIQUE,
  display_name    TEXT NOT NULL,
  sip_username    TEXT NOT NULL UNIQUE,
  sip_password_enc TEXT NOT NULL,
  user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  allow_external  BOOLEAN NOT NULL DEFAULT FALSE,
  allow_international BOOLEAN NOT NULL DEFAULT FALSE,
  max_out_calls   INTEGER NOT NULL DEFAULT 2 CHECK (max_out_calls BETWEEN 1 AND 20),
  hide_caller_id  BOOLEAN NOT NULL DEFAULT FALSE,
  external_cid    TEXT,
  webrtc_enabled  BOOLEAN NOT NULL DEFAULT TRUE,
  pickup_allowed  BOOLEAN NOT NULL DEFAULT FALSE,
  pickup_group    TEXT,
  voicemail_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  voicemail_pin_enc TEXT,
  ring_timeout    INTEGER NOT NULL DEFAULT 25 CHECK (ring_timeout BETWEEN 5 AND 120),
  fwd_always      TEXT,
  fwd_busy        TEXT,
  fwd_noanswer    TEXT,
  fwd_unavail     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE devices (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  extension_id INTEGER REFERENCES extensions(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL DEFAULT 'deskphone' CHECK (kind IN ('deskphone','softphone','mobile','webrtc','other')),
  vendor       TEXT,
  model        TEXT,
  mac          TEXT,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE contacts (
  id         SERIAL PRIMARY KEY,
  name       TEXT NOT NULL,
  company    TEXT,
  number     TEXT NOT NULL,
  email      TEXT,
  short_code TEXT UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE ring_groups (
  id        SERIAL PRIMARY KEY,
  number    TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL,
  strategy  TEXT NOT NULL DEFAULT 'ringall' CHECK (strategy IN ('ringall','hunt')),
  members   TEXT[] NOT NULL DEFAULT '{}',
  timeout   INTEGER NOT NULL DEFAULT 25 CHECK (timeout BETWEEN 5 AND 120),
  fallback  TEXT NOT NULL DEFAULT 'hangup'
);

CREATE TABLE queues (
  id        SERIAL PRIMARY KEY,
  number    TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL,
  strategy  TEXT NOT NULL DEFAULT 'ringall' CHECK (strategy IN ('ringall','leastrecent','fewestcalls','rrmemory','linear')),
  members   TEXT[] NOT NULL DEFAULT '{}',
  timeout   INTEGER NOT NULL DEFAULT 20 CHECK (timeout BETWEEN 5 AND 120),
  max_wait  INTEGER NOT NULL DEFAULT 300 CHECK (max_wait BETWEEN 10 AND 3600),
  fallback  TEXT NOT NULL DEFAULT 'hangup'
);

CREATE TABLE ivrs (
  id        SERIAL PRIMARY KEY,
  number    TEXT NOT NULL UNIQUE,
  name      TEXT NOT NULL,
  greeting  TEXT,
  options   JSONB NOT NULL DEFAULT '[]',
  timeout   INTEGER NOT NULL DEFAULT 5 CHECK (timeout BETWEEN 2 AND 30),
  retries   INTEGER NOT NULL DEFAULT 3 CHECK (retries BETWEEN 1 AND 6),
  fallback  TEXT NOT NULL DEFAULT 'hangup'
);

CREATE TABLE schedules (
  id       SERIAL PRIMARY KEY,
  name     TEXT NOT NULL UNIQUE,
  mode     TEXT NOT NULL DEFAULT 'auto' CHECK (mode IN ('auto','open','closed')),
  rules    JSONB NOT NULL DEFAULT '[]',
  holidays TEXT[] NOT NULL DEFAULT '{}'
);

CREATE TABLE trunks (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  enabled       BOOLEAN NOT NULL DEFAULT TRUE,
  auth_mode     TEXT NOT NULL DEFAULT 'register' CHECK (auth_mode IN ('register','ip')),
  registrar     TEXT NOT NULL,
  outbound_proxy TEXT,
  username      TEXT,
  auth_username TEXT,
  password_enc  TEXT,
  transport     TEXT NOT NULL DEFAULT 'udp' CHECK (transport IN ('udp','tcp','tls')),
  from_domain   TEXT,
  match_hosts   TEXT,
  expiration    INTEGER NOT NULL DEFAULT 3600 CHECK (expiration BETWEEN 60 AND 86400),
  caller_id     TEXT,
  cid_mode      TEXT NOT NULL DEFAULT 'default' CHECK (cid_mode IN ('default','from','pai')),
  max_channels  INTEGER NOT NULL DEFAULT 4 CHECK (max_channels BETWEEN 1 AND 100),
  default_inbound TEXT NOT NULL DEFAULT 'hangup',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE trunk_numbers (
  id          SERIAL PRIMARY KEY,
  trunk_id    INTEGER NOT NULL REFERENCES trunks(id) ON DELETE CASCADE,
  number      TEXT NOT NULL,
  label       TEXT,
  schedule_id INTEGER REFERENCES schedules(id) ON DELETE SET NULL,
  dest_open   TEXT NOT NULL DEFAULT 'hangup',
  dest_closed TEXT NOT NULL DEFAULT 'hangup',
  UNIQUE (trunk_id, number)
);

CREATE TABLE outbound_rules (
  id        SERIAL PRIMARY KEY,
  trunk_id  INTEGER NOT NULL REFERENCES trunks(id) ON DELETE CASCADE,
  name      TEXT NOT NULL,
  pattern   TEXT NOT NULL,
  strip     INTEGER NOT NULL DEFAULT 0 CHECK (strip BETWEEN 0 AND 15),
  prepend   TEXT NOT NULL DEFAULT '',
  class     TEXT NOT NULL CHECK (class IN ('national','mobile','international','service','emergency')),
  enabled   BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE calls (
  id          BIGSERIAL PRIMARY KEY,
  uniqueid    TEXT NOT NULL,
  linkedid    TEXT NOT NULL,
  started     TIMESTAMPTZ NOT NULL,
  answered    TIMESTAMPTZ,
  ended       TIMESTAMPTZ NOT NULL,
  src         TEXT,
  dst         TEXT,
  clid        TEXT,
  channel     TEXT,
  dstchannel  TEXT,
  disposition TEXT NOT NULL,
  duration    INTEGER NOT NULL DEFAULT 0,
  billsec     INTEGER NOT NULL DEFAULT 0,
  lastapp     TEXT,
  dcontext    TEXT,
  direction   TEXT NOT NULL CHECK (direction IN ('internal','inbound','outbound')),
  UNIQUE (uniqueid, dstchannel, started)
);
CREATE INDEX calls_started ON calls (started DESC);
CREATE INDEX calls_linkedid ON calls (linkedid);

CREATE TABLE registrations (
  sip_username TEXT PRIMARY KEY,
  last_registered TIMESTAMPTZ,
  last_contact_uri TEXT,
  last_user_agent TEXT,
  last_ip TEXT,
  last_error TEXT,
  last_error_at TIMESTAMPTZ,
  last_error_ip TEXT
);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

CREATE TABLE audit_log (
  id       BIGSERIAL PRIMARY KEY,
  ts       TIMESTAMPTZ NOT NULL DEFAULT now(),
  user_id  INTEGER,
  username TEXT,
  ip       TEXT,
  action   TEXT NOT NULL,
  entity   TEXT,
  entity_id TEXT,
  detail   JSONB
);
CREATE INDEX audit_ts ON audit_log (ts DESC);

CREATE TABLE system_events (
  id      BIGSERIAL PRIMARY KEY,
  ts      TIMESTAMPTZ NOT NULL DEFAULT now(),
  level   TEXT NOT NULL CHECK (level IN ('info','warning','error')),
  source  TEXT NOT NULL,
  message TEXT NOT NULL,
  detail  JSONB
);
CREATE INDEX events_ts ON system_events (ts DESC);

CREATE TABLE config_revisions (
  id       SERIAL PRIMARY KEY,
  ts       TIMESTAMPTZ NOT NULL DEFAULT now(),
  username TEXT,
  reason   TEXT,
  hash     TEXT NOT NULL,
  ok       BOOLEAN NOT NULL,
  error    TEXT,
  files    JSONB NOT NULL
);

CREATE TABLE cdr_state (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  file_offset BIGINT NOT NULL DEFAULT 0,
  file_inode  TEXT
);
INSERT INTO cdr_state (id) VALUES (1);
