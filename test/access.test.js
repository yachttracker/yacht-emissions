// ── Tests Sichtbarkeits-Schalter (lib/access.js), ohne Datenbank und ohne Express ──
// Lauf: node --test test/access.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSiteGate, siteMode, cookieValue, COOKIE } = require('../lib/access');

const PW = 'site-password-0123456789abcdef';
const ADMIN = 'admin-token-0123456789abcdef';

function req({ path = '/', method = 'GET', query = {}, headers = {}, ip = '1.2.3.4', originalUrl } = {}) {
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { path, method, query, headers: h, ip, secure: true, originalUrl: originalUrl || path,
           get: (n) => h[n.toLowerCase()] };
}
function res() {
  const r = { statusCode: 200, headers: {}, cookies: [], body: null, redirected: null };
  r.set = (k, v) => { r.headers[k.toLowerCase()] = v; return r; };
  r.append = (k, v) => { if (k === 'Set-Cookie') r.cookies.push(v); return r; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.type = () => r;
  r.send = (b) => { r.body = b; return r; };
  r.json = (b) => { r.body = b; return r; };
  r.redirect = (c, u) => { r.statusCode = c; r.redirected = u; return r; };
  return r;
}
function run(gate, rq) {
  const rs = res(); let passed = false;
  gate(rq, rs, () => { passed = true; });
  return { rs, passed };
}
const gateWith = (mode, secrets = [PW, ADMIN], opts = {}) =>
  createSiteGate({ getMode: () => mode, getSecrets: () => secrets, ...opts });

test('Modus: nur "public" öffnet, alles andere ist privat', () => {
  assert.equal(siteMode('public'), 'public');
  assert.equal(siteMode(' Public '), 'public');
  assert.equal(siteMode(undefined), 'private');
  assert.equal(siteMode(''), 'private');
  assert.equal(siteMode('off'), 'private');
  assert.equal(siteMode('private'), 'private');
});

test('public: alles durchgelassen, kein Cookie', () => {
  const { passed, rs } = run(gateWith('public'), req({ path: '/api/fleet' }));
  assert.ok(passed); assert.equal(rs.cookies.length, 0);
});

test('private: Seite und API ohne Zugang gesperrt (401, noindex)', () => {
  const g = gateWith('private');
  for (const path of ['/', '/index.html', '/js/main.js', '/api/fleet', '/api/review', '/admin/', '/admin/api/state']) {
    const { passed, rs } = run(g, req({ path }));
    assert.equal(passed, false, path);
    assert.equal(rs.statusCode, 401, path);
    assert.match(rs.headers['www-authenticate'], /^Basic/);
    assert.equal(rs.headers['x-robots-tag'], 'noindex, nofollow');
  }
});

test('private: /health bleibt offen (Railway-Healthcheck)', () => {
  assert.ok(run(gateWith('private'), req({ path: '/health' })).passed);
});

test('private: Basic-Anmeldung mit SITE_PASSWORD oder ADMIN_TOKEN', () => {
  const g = gateWith('private');
  for (const pw of [PW, ADMIN]) {
    const auth = 'Basic ' + Buffer.from(`egal:${pw}`).toString('base64');
    const { passed, rs } = run(g, req({ path: '/api/fleet', headers: { Authorization: auth } }));
    assert.ok(passed); assert.match(rs.cookies[0], new RegExp(`^${COOKIE}=`));
    assert.match(rs.cookies[0], /HttpOnly/); assert.match(rs.cookies[0], /Secure/);
  }
  const bad = 'Basic ' + Buffer.from('egal:falsch-falsch-falsch').toString('base64');
  assert.equal(run(g, req({ headers: { Authorization: bad } })).rs.statusCode, 401);
});

test('private: Cookie gilt; nach Passwortwechsel ungültig; Passwort steht nicht im Cookie', () => {
  const cookie = `${COOKIE}=${cookieValue(PW)}`;
  assert.ok(!cookie.includes(PW));
  assert.ok(run(gateWith('private'), req({ headers: { Cookie: `x=1; ${cookie}` } })).passed);
  assert.equal(run(gateWith('private', ['neues-passwort-0123456789']), req({ headers: { Cookie: cookie } })).passed, false);
});

test('private: Link ?access=… setzt Cookie und entfernt den Parameter (Seite) bzw. lässt API durch', () => {
  const g = gateWith('private');
  const page = run(g, req({ path: '/', query: { access: PW, period: 'month' }, originalUrl: `/?access=${PW}&period=month` }));
  assert.equal(page.passed, false); assert.equal(page.rs.statusCode, 303);
  assert.equal(page.rs.redirected, '/?period=month'); assert.equal(page.rs.cookies.length, 1);
  const api = run(g, req({ path: '/api/review', query: { access: PW } }));
  assert.ok(api.passed);
});

test('private: Kopfzeile x-site-access für Skripte', () => {
  assert.ok(run(gateWith('private'), req({ path: '/api/identity', headers: { 'x-site-access': ADMIN } })).passed);
});

test('private ohne Passwort-Variablen: 503 statt offen', () => {
  const { passed, rs } = run(gateWith('private', []), req({ path: '/api/fleet' }));
  assert.equal(passed, false); assert.equal(rs.statusCode, 503);
});

test('private: Fehlversuche je IP begrenzt', () => {
  const g = gateWith('private', [PW], { failMax: 3 });
  for (let i = 0; i < 3; i++) assert.equal(run(g, req({ query: { access: 'falsch' } })).rs.statusCode, 401);
  assert.equal(run(g, req({ query: { access: PW } })).rs.statusCode, 429);          // gesperrt, auch mit richtigem Passwort
  assert.ok(run(g, req({ path: '/api/fleet', query: { access: PW }, ip: '5.6.7.8' })).passed);           // andere IP unberührt
});
