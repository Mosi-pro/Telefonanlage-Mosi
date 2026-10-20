'use strict';
// Liest die von Asterisk (cdr_custom) geschriebene CSV, speichert Eintraege dauerhaft in PostgreSQL.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const db = require('./db');
const log = require('./log');

const FILE = path.join(config.asterisk.logDir, 'cdr-custom', 'Mosi.csv');
const ROTATE_BYTES = 10 * 1024 * 1024;

function parseCsv(text) {
  const rows = []; let row = []; let cur = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch !== '\r') cur += ch;
  }
  return rows;
}

function direction(channel, dstchannel, dcontext) {
  if (/^PJSIP\/trunk-\d+-/.test(dstchannel || '')) return 'outbound';
  if (/^PJSIP\/trunk-\d+-/.test(channel || '') || /^mosi-in-/.test(dcontext || '')) return 'inbound';
  return 'internal';
}

async function ingest() {
  let st;
  try { st = fs.statSync(FILE); } catch { return 0; }
  const state = (await db.query('SELECT file_offset, file_inode FROM cdr_state WHERE id = 1')).rows[0];
  let offset = Number(state.file_offset);
  if (state.file_inode !== String(st.ino) || st.size < offset) offset = 0; // Datei wurde rotiert/ersetzt
  if (st.size === offset) { await maybeRotate(st, offset); return 0; }

  const fd = fs.openSync(FILE, 'r');
  const buf = Buffer.alloc(st.size - offset);
  fs.readSync(fd, buf, 0, buf.length, offset);
  fs.closeSync(fd);
  const lastNl = buf.lastIndexOf(0x0a);
  if (lastNl < 0) return 0;
  const consumed = buf.subarray(0, lastNl + 1);
  const rows = parseCsv(consumed.toString('utf8'));

  let n = 0;
  await db.tx(async (c) => {
    for (const r of rows) {
      if (r.length < 15 || !Number.isFinite(Number(r[0])) || !Number.isFinite(Number(r[2]))) { log.warn('CDR-Zeile uebersprungen', { columns: r.length }); continue; }
      const [start, answer, end, src, dst, clid, channel, dstchannel, disposition, duration, billsec, uniqueid, linkedid, lastapp, dcontext] = r;
      const res = await c.query(
        `INSERT INTO calls (uniqueid, linkedid, started, answered, ended, src, dst, clid, channel, dstchannel, disposition, duration, billsec, lastapp, dcontext, direction)
         VALUES ($1,$2,to_timestamp($3::float8),CASE WHEN $4::float8 > 0 THEN to_timestamp($4::float8) END,to_timestamp($5::float8),$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT DO NOTHING`,
        [uniqueid, linkedid, start, answer, end, src, dst, clid, channel, dstchannel || '', disposition, parseInt(duration, 10) || 0, parseInt(billsec, 10) || 0,
          lastapp, dcontext, direction(channel, dstchannel, dcontext)]);
      n += res.rowCount;
    }
    await c.query('UPDATE cdr_state SET file_offset = $1, file_inode = $2 WHERE id = 1', [offset + consumed.length, String(st.ino)]);
  });
  return n;
}

async function maybeRotate(st, offset) {
  if (st.size < ROTATE_BYTES || offset !== st.size) return;
  try {
    fs.renameSync(FILE, `${FILE}.1`);
    await db.query('UPDATE cdr_state SET file_offset = 0, file_inode = NULL WHERE id = 1');
    log.info('CDR-Datei rotiert');
  } catch (e) { log.warn('CDR-Rotation fehlgeschlagen', { error: e.message }); }
}

let timer = null;
let lastRun = { at: null, error: null };
function start() {
  const tick = async () => {
    try { await ingest(); lastRun = { at: new Date(), error: null }; } catch (e) { lastRun = { at: new Date(), error: e.message }; log.error('CDR-Import fehlgeschlagen', { error: e.message }); }
  };
  timer = setInterval(tick, 3000);
  tick();
}
const stop = () => clearInterval(timer);
const status = () => lastRun;

module.exports = { start, stop, ingest, status, parseCsv, direction };
