require('./setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const v = require('../src/validate');

const rejects = (fn) => assert.throws(fn, v.ValidationError);

test('Namen: Konfigurations-Sonderzeichen sind verboten', () => {
  for (const bad of ['a"b', "a'b", 'a;b', 'a\nb', 'a,b', 'a(b)', 'a${x}', 'a=b', 'a#b', 'a\\b', 'a<b>']) rejects(() => v.name('n', bad));
  assert.equal(v.name('n', 'Müller & Söhne'.replace('&', 'und')), 'Müller und Söhne');
});
test('Rufnummern', () => {
  assert.equal(v.number('n', '100'), '100');
  for (const bad of ['0', '1', '1234567', 'abc', '10 0', '100;']) rejects(() => v.number('n', bad));
  assert.equal(v.phone('p', '+49301234567'), '+49301234567');
  for (const bad of ['++49', '49 30', '0301;Hangup()', 'abc']) rejects(() => v.phone('p', bad));
});
test('Wahlmuster', () => {
  assert.equal(v.dialPattern('p', '_0[2-9]X.'), '_0[2-9]X.');
  for (const bad of ['0X', '_', '_0X;', '_0X\nexten', '_${EXTEN}', '_X,1']) rejects(() => v.dialPattern('p', bad));
});
test('Passwort-Richtlinie', () => {
  rejects(() => v.password('p', 'kurz'));
  rejects(() => v.password('p', 'nurkleinbuchstaben'));
  assert.equal(v.password('p', 'Gute-Passw0rt-2026'), 'Gute-Passw0rt-2026');
});
test('Hostnamen und SIP-Benutzer', () => {
  assert.equal(v.host('h', 'sip.example.org:5060'), 'sip.example.org:5060');
  rejects(() => v.host('h', 'a b'));
  rejects(() => v.host('h', 'host;rm -rf'));
  rejects(() => v.sipUser('u', 'a b'));
  rejects(() => v.sipUser('u', 'ab'));
});
test('Zahlen und Auswahlfelder', () => {
  assert.equal(v.int('i', '5', { min: 1, max: 10 }), 5);
  rejects(() => v.int('i', '11', { min: 1, max: 10 }));
  rejects(() => v.int('i', '1.5', { min: 1, max: 10 }));
  rejects(() => v.oneOf('o', 'x', ['a', 'b']));
  rejects(() => v.mac('m', 'ZZ:00'));
});
