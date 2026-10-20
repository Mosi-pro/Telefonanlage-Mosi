'use strict';
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const config = require('./config');
const log = require('./log');

const pool = new Pool({ connectionString: config.databaseUrl, max: 10 });
pool.on('error', (e) => log.error('Datenbank-Pool-Fehler', { error: e.message }));

const query = (text, params) => pool.query(text, params);

// Fuehrt fn(client) in einer Transaktion aus. Fehler => ROLLBACK.
async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Einfache, versionierte Migrationen (migrations/NNN_name.sql), jede in einer Transaktion.
async function migrate() {
  await query('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())');
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const done = new Set((await query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
  for (const f of files) {
    if (done.has(f)) continue;
    log.info('Migration wird ausgefuehrt', { file: f });
    await tx(async (c) => {
      await c.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [f]);
    });
  }
}

async function waitForDb(maxSeconds = 60) {
  const start = Date.now();
  for (;;) {
    try { await query('SELECT 1'); return; } catch (e) {
      if (Date.now() - start > maxSeconds * 1000) throw new Error(`Datenbank nicht erreichbar: ${e.message}`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
}

module.exports = { pool, query, tx, migrate, waitForDb };
