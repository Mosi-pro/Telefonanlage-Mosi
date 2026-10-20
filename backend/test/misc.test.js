require('./setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('../src/crypto');
const cdr = require('../src/cdr');

test('Verschluesselung: Roundtrip, unterschiedliche IVs, Manipulation erkannt', () => {
  const a = crypto.encrypt('geheim'); const b = crypto.encrypt('geheim');
  assert.notEqual(a, b);
  assert.equal(crypto.decrypt(a), 'geheim');
  const parts = a.split('.'); parts[3] = Buffer.from('xxxxxx').toString('base64');
  assert.throws(() => crypto.decrypt(parts.join('.')));
});
test('Zufallspasswoerter: Laenge, Zeichensatz, Eindeutigkeit', () => {
  const set = new Set(Array.from({ length: 200 }, () => crypto.sipPassword()));
  assert.equal(set.size, 200);
  for (const p of set) assert.match(p, /^[A-Za-z0-9]{24}$/);
  assert.match(crypto.voicemailPin(), /^[0-9]{6}$/);
});
test('CDR-CSV: Anfuehrungszeichen und Kommas in Feldern', () => {
  const rows = cdr.parseCsv('"2026-10-20 10:00:00","","2026-10-20 10:00:05","100","101","""Test, Eins"" <100>","PJSIP/100-0001","PJSIP/101-0002","ANSWERED",5,3,"1.1","1.1","Dial","mosi-internal"\n');
  assert.equal(rows.length, 1);
  assert.equal(rows[0][5], '"Test, Eins" <100>');
  assert.equal(rows[0].length, 15);
});
test('CDR-Richtung', () => {
  assert.equal(cdr.direction('PJSIP/100-0001', 'PJSIP/trunk-1-0002', 'mosi-internal'), 'outbound');
  assert.equal(cdr.direction('PJSIP/trunk-1-0002', 'PJSIP/100-0001', 'mosi-in-1'), 'inbound');
  assert.equal(cdr.direction('PJSIP/100-0001', 'PJSIP/101-0002', 'mosi-internal'), 'internal');
  assert.equal(cdr.direction('PJSIP/trunk-1-0002', '', 'mosi-in-1'), 'inbound');
});
