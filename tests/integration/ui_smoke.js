// UI-Rauchtest (Chromium): echte Bedienung des Dashboards inkl. CSRF/Origin-Pruefung, Rollen und Mobilansicht.
// Aufruf: node ui_smoke.js <https-url> <admin-user> <admin-pass>
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
(async () => {
  const [base, user, pass] = process.argv.slice(2);
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--no-sandbox', '--ignore-certificate-errors', '--no-proxy-server'] });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && /Content Security Policy|Refused|Uncaught/.test(m.text())) errors.push(m.text()); }); // erwartete 4xx der Negativtests sind keine Fehler
  const ok = (n) => console.log('  OK   ' + n);

  await page.goto(base);
  await page.fill('#u', user); await page.fill('#p', pass); await page.click('button[type=submit]');
  await page.waitForSelector('.nav'); ok('Anmeldung ueber die Oberflaeche');
  const navCount = await page.locator('.nav a').count();
  assert.equal(navCount, 18); ok('Navigation: 16 Bereiche + Handy-App + Browsertelefon');

  // Nebenstelle ueber den Dialog anlegen (POST mit CSRF-Token + Origin)
  await page.goto(`${base}/#/extensions`);
  await page.click('button:has-text("Nebenstelle anlegen")');
  await page.fill('input[name=number]', '190'); await page.fill('input[name=display_name]', 'UI Test');
  await page.click('dialog button[type=submit]');
  await page.waitForSelector('td:has-text("UI Test")'); ok('Nebenstelle 190 ueber die Oberflaeche angelegt');
  await page.click('tr:has-text("UI Test") button:has-text("Verbindung")');
  await page.waitForSelector('dialog .secret input');
  const pw = await page.inputValue('dialog .secret input');
  assert.match(pw, /^[A-Za-z0-9]{24}$/); ok('Verbindungsdaten zeigen generiertes 24-Zeichen-Passwort');
  assert.equal(await page.locator('dialog .secret input').first().getAttribute('type'), 'password'); ok('Passwort ist standardmaessig verdeckt');
  await page.click('dialog button:has-text("Schliessen")');

  // Fehlerdialog bei ungueltiger Eingabe
  await page.click('button:has-text("Nebenstelle anlegen")');
  await page.fill('input[name=number]', '190'); await page.fill('input[name=display_name]', 'Doppelt');
  await page.click('dialog button[type=submit]');
  await page.waitForSelector('dialog .notice.err:not([hidden])'); ok('Doppelte Durchwahl zeigt Fehlermeldung im Dialog');
  await page.click('dialog button:has-text("Abbrechen")');

  // Benutzer mit Rolle "user" anlegen und Rechte pruefen
  await page.goto(`${base}/#/users`);
  await page.click('button:has-text("Benutzer anlegen")');
  await page.fill('input[name=username]', 'uitester'); await page.fill('input[name=display_name]', 'UI Tester');
  await page.selectOption('select[name=role]', 'user'); await page.fill('input[name=password]', 'Sicheres-Passwort-2026!');
  await page.click('dialog button[type=submit]');
  await page.waitForSelector('td:has-text("uitester")'); ok('Benutzer mit Rolle "Benutzer" angelegt');
  await page.click('button:has-text("Abmelden")');
  await page.waitForSelector('#u');
  await page.fill('#u', 'uitester'); await page.fill('#p', 'Sicheres-Passwort-2026!'); await page.click('button[type=submit]');
  await page.waitForSelector('.nav');
  const labels = await page.locator('.nav a').allTextContents();
  assert.ok(!labels.includes('Benutzer und Rollen') && !labels.includes('Externe Rufnummern') && !labels.includes('Einstellungen'), labels.join(','));
  ok('Rolle Benutzer: Admin-Bereiche sind ausgeblendet (' + labels.length + ' Eintraege)');
  const status = await page.evaluate(async () => (await fetch('/api/users', { credentials: 'same-origin' })).status);
  assert.equal(status, 403); ok('Rolle Benutzer: /api/users liefert 403');
  const csrf = await page.evaluate(async () => (await fetch('/api/extensions', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status);
  assert.ok([403].includes(csrf)); ok('Schreibende Anfrage ohne CSRF-Token wird abgelehnt (403)');

  // Mobilansicht
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(`${base}/#/extensions`);
  await page.waitForSelector('.topbar button');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
  assert.equal(overflow, false); ok('Mobilansicht: kein horizontales Scrollen der Seite');

  // Aufraeumen (Admin)
  await page.click('.topbar button'); await page.click('button:has-text("Abmelden")');
  await page.waitForSelector('#u'); await page.setViewportSize({ width: 1280, height: 900 });
  await page.fill('#u', user); await page.fill('#p', pass); await page.click('button[type=submit]'); await page.waitForSelector('.nav');
  await page.goto(`${base}/#/extensions`);
  page.once('dialog', () => {});
  await page.click('tr:has-text("UI Test") button:has-text("Löschen")'); await page.click('dialog button[type=submit]');
  await page.waitForSelector('td:has-text("UI Test")', { state: 'detached' }); ok('Aufraeumen: Nebenstelle geloescht');
  await page.goto(`${base}/#/users`);
  await page.click('tr:has-text("uitester") button:has-text("Löschen")'); await page.click('dialog button[type=submit]');
  await page.waitForSelector('td:has-text("uitester")', { state: 'detached' }); ok('Aufraeumen: Testbenutzer geloescht');

  assert.deepEqual(errors, [], errors.join('\n')); ok('Keine JavaScript-/CSP-Fehler in der Browser-Konsole');
  await browser.close();
  console.log('\nUI-Rauchtest bestanden');
})().catch((e) => { console.error('FEHLER:', e.message); process.exit(1); });
