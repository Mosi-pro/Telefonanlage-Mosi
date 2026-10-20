require('./setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const { generate, redact, ConfigError } = require('../src/generator');

const ext = (n, extra = {}) => ({
  id: Number(n), number: n, display_name: `Test ${n}`, sip_username: n, sip_password: 'pw-' + n.repeat(8), enabled: true,
  allow_external: false, allow_international: false, max_out_calls: 2, hide_caller_id: false, external_cid: null, webrtc_enabled: true,
  pickup_allowed: false, pickup_group: null, voicemail_enabled: false, voicemail_pin: '', ring_timeout: 25,
  fwd_always: null, fwd_busy: null, fwd_noanswer: null, fwd_unavail: null, ...extra,
});
const base = (over = {}) => ({ settings: { tz: 'Europe/Berlin', hostName: '192.0.2.10' }, extensions: [ext('100'), ext('101')], ringGroups: [], queues: [], ivrs: [], schedules: [], trunks: [], trunkNumbers: [], outRules: [], contacts: [], sounds: [], ...over });

test('Nebenstellen erzeugen Auth/AOR/Endpoint und WebRTC-Endpoint', () => {
  const { files, expected } = generate(base());
  const pj = files['pjsip_mosi.conf'];
  assert.match(pj, /\[100\]\ntype=endpoint/);
  assert.match(pj, /\[100-web\]\ntype=endpoint/);
  assert.match(pj, /username=100-web/);       // eigener Auth-Benutzer fuer den Browser
  assert.match(pj, /webrtc=yes/);
  assert.match(pj, /acl=acl_sip/);
  assert.match(pj, /from_domain=192\.0\.2\.10/);   // JsSIP kann Container-IDs als Hostname nicht parsen
  assert.deepEqual(expected.endpoints.sort(), ['100', '100-web', '101', '101-web']);
});

test('Interner Ruf: Dial an beide Endpunkte, Busy/NoAnswer/Unavail-Behandlung', () => {
  const dp = generate(base()).files['extensions_mosi.conf'];
  assert.match(dp, /exten => 101,1,NoOp\(Nebenstelle 101\)/);
  // alle erreichbaren Kontakte (Tischtelefon, App, Browser) - nicht nur ein einzelner
  assert.match(dp, /exten => 101,1,NoOp[\s\S]*Gosub\(mosi-ds,s,1\(101\)\)\n same => n,Gosub\(mosi-dsw,s,1\(101-web\)\)[\s\S]*Dial\(\$\{MOSI_DS\},25,tT\)/);
  assert.match(dp, /\[mosi-ds\]\nexten => s,1,Set\(MOSI_C=\$\{PJSIP_DIAL_CONTACTS\(\$\{ARG1\}\)\}\)/);
  assert.match(dp, /GotoIf\(\$\["\$\{DEVICE_STATE\(PJSIP\/101\)\}"="BUSY" \| "\$\{DEVICE_STATE\(PJSIP\/101-web\)\}"="BUSY"\]\?busy\)/);
  assert.match(dp, /same => n\(busy\)/);
  assert.match(dp, /same => n\(noanswer\)/);
  assert.match(dp, /same => n\(unavail\)/);
});

test('Deaktivierte Nebenstelle erzeugt keinen Endpoint', () => {
  const { files } = generate(base({ extensions: [ext('100'), ext('101', { enabled: false })] }));
  assert.doesNotMatch(files['pjsip_mosi.conf'], /\[101\]/);
  assert.match(files['extensions_mosi.conf'], /exten => 101,1,NoOp\(Nebenstelle 101\)\n same => n,Congestion/);
});

test('Doppelte Rufnummer wird abgelehnt', () => {
  assert.throws(() => generate(base({ ringGroups: [{ number: '100', name: 'x', strategy: 'ringall', members: ['101'], timeout: 20, fallback: 'hangup' }] })), ConfigError);
});

test('Rufgruppe mit unbekanntem Mitglied wird abgelehnt', () => {
  assert.throws(() => generate(base({ ringGroups: [{ number: '700', name: 'x', strategy: 'ringall', members: ['999'], timeout: 20, fallback: 'hangup' }] })), /Mitglied 999/);
});

test('Rufgruppe ringall und hunt', () => {
  const g = (strategy) => generate(base({ ringGroups: [{ number: '700', name: 'G', strategy, members: ['100', '101'], timeout: 15, fallback: 'vm:101' }], extensions: [ext('100'), ext('101', { voicemail_enabled: true, voicemail_pin: '123456' })] })).files['extensions_mosi.conf'];
  const all = g('ringall').split('exten => 700,1')[1];
  assert.equal((all.match(/Gosub\(mosi-dsw?,s,1\(10[01](-web)?\)\)/g) || []).length, 4);   // alle Mitglieder sammeln, EIN Dial
  assert.equal((all.match(/Dial\(\$\{MOSI_DS\},15,tT\)/g) || []).length, 1);
  const hunt = g('hunt').split('exten => 700,1')[1];
  assert.equal((hunt.match(/Dial\(\$\{MOSI_DS\},15,tT\)/g) || []).length, 2);              // nacheinander je Mitglied
  assert.match(hunt, /Voicemail\(101@default,u\)/);
});

test('Voicemail-Konfiguration nur fuer aktivierte Nebenstellen', () => {
  const { files } = generate(base({ extensions: [ext('100'), ext('101', { voicemail_enabled: true, voicemail_pin: '424242' })] }));
  assert.match(files['voicemail_mosi.conf'], /^101 => 424242,Test 101/m);
  assert.doesNotMatch(files['voicemail_mosi.conf'], /^100 =>/m);
  assert.match(files['pjsip_mosi.conf'], /mailboxes=101@default/);
});

test('Weiterleitung auf externe Nummer erfordert Berechtigung', () => {
  assert.throws(() => generate(base({ extensions: [ext('100', { fwd_always: '0301234567' }), ext('101')] })), /externe Anrufe/);
  const ok = generate(base({ extensions: [ext('100', { fwd_always: '0301234567', allow_external: true }), ext('101')] }));
  assert.match(ok.files['extensions_mosi.conf'], /Goto\(mosi-out,0301234567,1\)/);
});

test('Ausgehende Regeln: Pruefung, Limits, gesperrte Praefixe', () => {
  const state = base({
    settings: { tz: 'Europe/Berlin', blockedPrefixes: ['0900', '118'] },
    trunks: [{ id: 1, name: 'T', enabled: true, auth_mode: 'register', registrar: 'sip.example.org', username: 'acc', password: 'pw', password_set: true, transport: 'udp', expiration: 3600, cid_mode: 'default', max_channels: 3, caller_id: '+4930111', default_inbound: 'hangup', match_hosts: null, outbound_proxy: null, from_domain: null }],
    outRules: [{ id: 1, trunk_id: 1, name: 'Nat', pattern: '_0[2-9]X.', strip: 0, prepend: '', class: 'national', enabled: true }],
    trunkNumbers: [{ id: 1, trunk_id: 1, number: '+4930111', label: null, schedule_id: null, dest_open: '100', dest_closed: 'hangup' }],
  });
  const { files, expected } = generate(state);
  const dp = files['extensions_mosi.conf'];
  assert.match(dp, /exten => _0\[2-9\]X\.,1,NoOp\(Ausgehend Regel 1 ueber trunk-1\)/);
  assert.match(dp, /Gosub\(mosi-outchk,s,1\(national,\$\{EXTEN\}\)\)/);
  assert.match(dp, /\$\{ARG2:0:4\}"="0900"/);
  assert.match(dp, /\$\{ARG2:0:3\}"="118"/);
  assert.match(dp, /GROUP_COUNT\(trunk-1@trk\)\}>3/);
  assert.match(dp, /Dial\(PJSIP\/\$\{MOSI_NUM\}@trunk-1,60,T\)/);
  assert.match(dp, /\[mosi-in-1\]\nexten => \+4930111,1/);
  assert.match(dp, /exten => 4930111,1/);   // Variante ohne +
  assert.deepEqual(expected.trunkRegistrations, ['trunk-1']);
  assert.match(files['pjsip_mosi.conf'], /type=registration/);
  assert.match(files['pjsip_mosi.conf'], /client_uri=sip:acc@sip\.example\.org/);
});

test('International ist standardmaessig nicht erlaubt (Berechtigungs-Variablen am Endpoint)', () => {
  const pj = generate(base()).files['pjsip_mosi.conf'];
  assert.match(pj, /set_var=MOSI_ALLOW_EXT=0/);
  assert.match(pj, /set_var=MOSI_ALLOW_INTL=0/);
  const dp = generate(base()).files['extensions_mosi.conf'];
  assert.match(dp, /"\$\{ARG1\}"="international" & "\$\{MOSI_ALLOW_INTL\}"!="1"/);
});

test('Absendernummer nur wenn sie zu einem Trunk gehoert', () => {
  const trunks = [{ id: 1, name: 'T', enabled: true, auth_mode: 'ip', registrar: '192.0.2.10', username: null, password_set: false, transport: 'udp', expiration: 3600, cid_mode: 'default', max_channels: 2, caller_id: null, default_inbound: 'hangup', match_hosts: null, outbound_proxy: null, from_domain: null }];
  const tn = [{ id: 1, trunk_id: 1, number: '0301234', label: null, schedule_id: null, dest_open: 'hangup', dest_closed: 'hangup' }];
  const good = generate(base({ trunks, trunkNumbers: tn, extensions: [ext('100', { external_cid: '0301234' })] }));
  assert.match(good.files['pjsip_mosi.conf'], /set_var=MOSI_CID=0301234/);
  const bad = generate(base({ trunks, trunkNumbers: tn, extensions: [ext('100', { external_cid: '0999999' })] }));
  assert.match(bad.files['pjsip_mosi.conf'], /set_var=MOSI_CID=\n/);
});

test('Zeitplan, IVR und Warteschlange', () => {
  const state = base({
    schedules: [{ id: 5, name: 'Büro', mode: 'auto', rules: [{ days: [1, 2, 3, 4, 5], from: '08:00', to: '17:00' }], holidays: ['12-25'] }],
    ivrs: [{ id: 1, number: '900', name: 'Menü', greeting: 'ivr-abc', options: [{ digit: '1', target: '100' }, { digit: '2', target: 'hangup' }], timeout: 5, retries: 2, fallback: '101' }],
    queues: [{ id: 1, number: '800', name: 'Q', strategy: 'ringall', members: ['100', '101'], timeout: 20, max_wait: 120, fallback: 'hangup' }],
    sounds: ['ivr-abc'],
  });
  const { files, expected } = generate(state);
  const dp = files['extensions_mosi.conf'];
  assert.match(dp, /GotoIfTime\(08:00-16:59,mon&tue&wed&thu&fri,\*,\*,Europe\/Berlin\?open\)/);
  assert.match(dp, /GotoIfTime\(\*,\*,25,dec,Europe\/Berlin\?closed\)/);
  assert.match(dp, /Background\(\/var\/lib\/mosi\/sounds\/ivr-abc\)/);
  assert.match(dp, /\[mosi-ivr-900\]/);
  assert.match(dp, /Queue\(q-800,tT,,,120\)/);
  assert.match(files['queues_mosi.conf'], /\[q-800\]/);
  assert.match(files['queues_mosi.conf'], /member => PJSIP\/101-web,0/);
  assert.deepEqual(expected.queues, ['q-800']);
});

test('Kurzwahl-Konflikte werden abgelehnt', () => {
  assert.throws(() => generate(base({ contacts: [{ name: 'a', number: '100', short_code: '*43' }] })), /reserviert/);
  assert.throws(() => generate(base({ contacts: [{ name: 'a', number: '100', short_code: '*01' }, { name: 'b', number: '101', short_code: '*01' }] })), /doppelt/);
});

test('Passwoerter werden fuer gespeicherte Revisionen geschwaerzt', () => {
  const { files } = generate(base({ extensions: [ext('100'), ext('101', { voicemail_enabled: true, voicemail_pin: '424242' })] }));
  assert.doesNotMatch(redact(files['pjsip_mosi.conf']), /pw-/);
  assert.doesNotMatch(redact(files['voicemail_mosi.conf']), /424242/);
  assert.match(files['pjsip_mosi.conf'], /pw-100100/);
});

test('Generierte Dateien enthalten keine unescapten Zeilenumbrueche aus Nutzereingaben', () => {
  const { files } = generate(base({ extensions: [ext('100', { display_name: 'Müller Hans' })] }));
  assert.match(files['pjsip_mosi.conf'], /callerid="Müller Hans" <100>/);
});
