'use strict';
// Strikte Eingabevalidierung. Alles, was spaeter in Asterisk-Konfiguration landet,
// wird hier gegen enge Whitelists geprueft (Schutz vor Konfigurations-/Command-Injection).

class ValidationError extends Error {
  constructor(msg, field) { super(msg); this.status = 400; this.field = field; }
}
const fail = (field, msg) => { throw new ValidationError(msg, field); };

const str = (field, v, { min = 1, max = 100, re, optional = false, label } = {}) => {
  if (v === undefined || v === null || v === '') {
    if (optional) return null;
    fail(field, `${label || field} ist erforderlich`);
  }
  if (typeof v !== 'string') fail(field, `${label || field} muss Text sein`);
  const s = v.trim();
  if (s.length < min || s.length > max) fail(field, `${label || field}: ${min}-${max} Zeichen erforderlich`);
  // Steuerzeichen und Zeilenumbrueche sind niemals erlaubt
  if (/[\u0000-\u001f\u007f]/.test(s)) fail(field, `${label || field} enthaelt ungueltige Zeichen`);
  if (re && !re.test(s)) fail(field, `${label || field} hat ein ungueltiges Format`);
  return s;
};

// Anzeigenamen/Freitext: Konfigurationsrelevante Zeichen sind verboten.
const NAME_RE = /^[^"'\\;#=\[\]{}$<>|&`,()]+$/;
const name = (field, v, opts = {}) => str(field, v, { max: 60, re: NAME_RE, label: 'Name', ...opts });
const text = (field, v, opts = {}) => str(field, v, { max: 500, optional: true, ...opts });

const number = (field, v, { optional = false } = {}) =>
  str(field, v, { min: 2, max: 6, re: /^[1-9][0-9]{1,5}$/, optional, label: 'Rufnummer/Durchwahl' });
// Externe/Ziel-Rufnummer (Kontakte, Weiterleitung, Trunk-Nummern)
const phone = (field, v, { optional = false, label } = {}) =>
  str(field, v, { min: 1, max: 25, re: /^\+?[0-9*#]{1,24}$/, optional, label: label || 'Rufnummer' });
const sipUser = (field, v) => str(field, v, { min: 3, max: 32, re: /^[A-Za-z0-9._-]+$/, label: 'SIP-Benutzername' });
const host = (field, v, { optional = false } = {}) =>
  str(field, v, { max: 253, re: /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?$/, optional, label: 'Hostname/Adresse' });
const bool = (field, v, def = false) => (v === undefined || v === null ? def : v === true || v === 'true');
const int = (field, v, { min, max, def } = {}) => {
  if ((v === undefined || v === null || v === '') && def !== undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) fail(field, `${field}: ganze Zahl zwischen ${min} und ${max} erforderlich`);
  return n;
};
const oneOf = (field, v, list, def) => {
  if ((v === undefined || v === null || v === '') && def !== undefined) return def;
  if (!list.includes(v)) fail(field, `${field}: erlaubt sind ${list.join(', ')}`);
  return v;
};
// Asterisk-Dialplan-Muster (z.B. _0[1-9]X.) - eng begrenzt
const dialPattern = (field, v) =>
  str(field, v, { min: 2, max: 40, re: /^_[0-9XZN\[\]\-+*#.!]+$/, label: 'Wahlmuster (Asterisk, mit fuehrendem _)' });
const mac = (field, v) =>
  str(field, v, { optional: true, re: /^([0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}$/, label: 'MAC-Adresse' });
const email = (field, v) => str(field, v, { optional: true, max: 120, re: /^[^\s@"<>]+@[^\s@"<>]+\.[^\s@"<>]+$/, label: 'E-Mail' });
const username = (field, v) => str(field, v, { min: 3, max: 40, re: /^[A-Za-z0-9._@-]+$/, label: 'Benutzername' });

function password(field, v) {
  if (typeof v !== 'string' || v.length < 12) fail(field, 'Passwort: mindestens 12 Zeichen erforderlich');
  if (v.length > 200) fail(field, 'Passwort zu lang');
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) => r.test(v)).length;
  if (classes < 3) fail(field, 'Passwort: mindestens 3 von 4 Zeichenklassen (Klein-, Grossbuchstaben, Ziffern, Sonderzeichen)');
  return v;
}

module.exports = { ValidationError, fail, str, name, text, number, phone, sipUser, host, bool, int, oneOf, dialPattern, mac, email, username, password };
