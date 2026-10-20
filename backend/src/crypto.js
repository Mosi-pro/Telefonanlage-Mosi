'use strict';
const crypto = require('crypto');
const config = require('./config');

// Schluessel fuer die Verschluesselung von SIP-Zugangsdaten in der Datenbank.
const KEY = Buffer.from(crypto.hkdfSync('sha256', config.appSecret, 'mosi-pbx', 'secrets-at-rest', 32));

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const enc = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}

function decrypt(blob) {
  if (!blob) return '';
  const [v, iv, tag, data] = blob.split('.');
  if (v !== 'v1') throw new Error('Unbekanntes Verschluesselungsformat');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8');
}

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
function randomString(len, alphabet = ALPHABET) {
  let out = '';
  while (out.length < len) {
    const b = crypto.randomBytes(len * 2);
    for (const x of b) {
      if (x < 256 - (256 % alphabet.length)) out += alphabet[x % alphabet.length];
      if (out.length === len) break;
    }
  }
  return out;
}
const sipPassword = () => randomString(24);
const voicemailPin = () => randomString(6, '0123456789');
const token = () => crypto.randomBytes(32).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

module.exports = { encrypt, decrypt, randomString, sipPassword, voicemailPin, token, sha256 };
