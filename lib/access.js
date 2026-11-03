// ── Sichtbarkeit der Seite: öffentlich oder nur mit Zugang ───────────────────
// Schalter per Railway-Variable SITE_ACCESS, ohne Codeänderung umschaltbar:
//   SITE_ACCESS=public   → Dashboard und API öffentlich (Stand bis 03.11.2026)
//   SITE_ACCESS=private  → nur mit Zugang (Standard, auch wenn die Variable fehlt)
// Hintergrund (03.11.2026): Die API-Bedingungen von MyShipTracking erlauben nur interne
// Nutzung (Terms 4.2/4.3, https://api.myshiptracking.com/docs/terms). Bis zur Klärung
// bleibt die Seite privat. Fehlt die Variable oder ist sie unbekannt, gilt "private"
// (lieber versehentlich zu als versehentlich offen).
//
// Zugang im privaten Modus (jede Variante reicht):
//   1. Browser-Anmeldung (HTTP Basic): Benutzername beliebig, Passwort = SITE_PASSWORD oder ADMIN_TOKEN
//   2. Link mit ?access=<Passwort>: setzt ein Cookie (30 Tage) und entfernt den Parameter aus der Adresse
//   3. Kopfzeile x-site-access: <Passwort> (Skripte)
// Immer offen: /health (Railway-Healthcheck, enthält nur Status und Rechenversion).
// Passwortwechsel = Variable ändern; bestehende Cookies werden damit ungültig.

const crypto = require('crypto');
const { createLimiter } = require('./security');

// Konstanter Zeitvergleich ohne Hash: bei gleicher Länge timingSafeEqual; verrät höchstens
// die Länge (unkritisch bei zufälligen Passwörtern fester Länge, Annahme).
function safeEqual(given, expected) {
  if (typeof given !== 'string' || typeof expected !== 'string' || !given || !expected) return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) { crypto.timingSafeEqual(b, b); return false; }
  return crypto.timingSafeEqual(a, b);
}

const COOKIE = 'ye_access';
const COOKIE_MAX_AGE_S = 30 * 24 * 3600;
const OPEN_PATHS = new Set(['/health']);

function siteMode(raw = process.env.SITE_ACCESS) {
  return String(raw || '').trim().toLowerCase() === 'public' ? 'public' : 'private';
}

function credentials(env = process.env) {
  return [env.SITE_PASSWORD, env.ADMIN_TOKEN].filter(v => typeof v === 'string' && v.length > 0);
}

// Cookie-Wert: HMAC über das Passwort, damit das Passwort selbst nie im Cookie steht
const cookieValue = (secret) => crypto.createHmac('sha256', secret).update('ye-site-access-v1').digest('base64url');

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function basicPassword(req) {
  const h = req.get('authorization') || '';
  if (!/^Basic\s+/i.test(h)) return null;
  const decoded = Buffer.from(h.replace(/^Basic\s+/i, ''), 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  return i >= 0 ? decoded.slice(i + 1) : null;
}

const matches = (given, secrets) => !!given && secrets.some(s => safeEqual(given, s));

// failMax: Fehlversuche je IP und Zeitfenster (Annahme: 20 je 15 min bremst Raten, stört Paul nicht)
function createSiteGate({ getMode = () => siteMode(), getSecrets = () => credentials(),
  failMax = 20, failWindowMs = 15 * 60000 } = {}) {
  const fails = createLimiter({ windowMs: failWindowMs, max: failMax });

  return function siteGate(req, res, next) {
    if (getMode() === 'public' || OPEN_PATHS.has(req.path)) return next();

    res.set('X-Robots-Tag', 'noindex, nofollow');
    res.set('Cache-Control', 'no-store');
    const secrets = getSecrets();
    const isApi = req.path.startsWith('/api') || req.path.startsWith('/admin/api');
    if (!secrets.length) {
      const msg = 'site is private: SITE_PASSWORD or ADMIN_TOKEN not set';
      return isApi ? res.status(503).json({ error: msg }) : res.status(503).type('text').send(msg);
    }

    // Gültiges Cookie
    const c = readCookie(req, COOKIE);
    if (c && secrets.some(s => safeEqual(c, cookieValue(s)))) return next();

    const ip = req.ip || 'unknown';
    if (fails.peek(ip) >= failMax) {
      res.set('Retry-After', String(Math.ceil(failWindowMs / 1000)));
      return res.status(429).json({ error: 'too many failed attempts, try again later' });
    }

    const fromQuery = typeof req.query.access === 'string' ? req.query.access : null;
    const given = fromQuery || req.get('x-site-access') || basicPassword(req);
    if (matches(given, secrets)) {
      const secret = secrets.find(s => safeEqual(given, s));
      const secure = req.secure ? '; Secure' : '';
      res.append('Set-Cookie', `${COOKIE}=${cookieValue(secret)}; Max-Age=${COOKIE_MAX_AGE_S}; Path=/; HttpOnly; SameSite=Lax${secure}`);
      // Seitenaufruf mit ?access=…: Parameter aus der Adresse entfernen (nicht in Verlauf/Lesezeichen)
      if (fromQuery && req.method === 'GET' && !isApi) {
        const url = new URL(req.originalUrl, 'http://x');
        url.searchParams.delete('access');
        return res.redirect(303, url.pathname + url.search);
      }
      return next();
    }

    if (given) fails.hit(ip);
    res.set('WWW-Authenticate', 'Basic realm="Yacht emissions (private)", charset="UTF-8"');
    return isApi
      ? res.status(401).json({ error: 'private: access required' })
      : res.status(401).type('text').send('This dashboard is currently private.');
  };
}

module.exports = { createSiteGate, siteMode, credentials, cookieValue, safeEqual, COOKIE };
