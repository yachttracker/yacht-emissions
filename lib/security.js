// ── Zugriffsschutz: Admin-Token, Rate-Limit, Sicherheits-Header ─────────────
// Ohne neue Abhängigkeiten. Rate-Limit im Speicher (eine Railway-Instanz, Annahme);
// nach einem Neustart beginnt die Zählung neu.

const crypto = require('crypto');

// Feste Fenster je Schlüssel (z. B. IP). Gibt { ok, remaining, retryAfterS } zurück.
function createLimiter({ windowMs, max }) {
  const hits = new Map();
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.reset <= now) hits.delete(k);
  }, Math.min(windowMs, 60000));
  if (timer.unref) timer.unref();
  return {
    hit(key) {
      const now = Date.now();
      let e = hits.get(key);
      if (!e || e.reset <= now) { e = { n: 0, reset: now + windowMs }; hits.set(key, e); }
      e.n += 1;
      return { ok: e.n <= max, remaining: Math.max(0, max - e.n), retryAfterS: Math.ceil((e.reset - now) / 1000) };
    },
    peek(key) {
      const e = hits.get(key);
      return !e || e.reset <= Date.now() ? 0 : e.n;
    },
  };
}

function rateLimit(limiter, { message = 'too many requests' } = {}) {
  return (req, res, next) => {
    const r = limiter.hit(req.ip || 'unknown');
    if (!r.ok) {
      res.set('Retry-After', String(r.retryAfterS));
      return res.status(429).json({ error: message });
    }
    next();
  };
}

// Konstanter Zeitvergleich über SHA-256 (gleiche Länge unabhängig von der Eingabe)
function tokenEquals(given, expected) {
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(String(expected || '')).digest();
  return crypto.timingSafeEqual(a, b) && !!given;
}

// Admin-Schutz: ohne ADMIN_TOKEN deaktiviert; Fehlversuche je IP begrenzt.
// Annahme: 10 Fehlversuche je 15 min sind für Paul unkritisch und bremsen Raten aus.
function createAdminGuard({ getToken = () => process.env.ADMIN_TOKEN, failMax = 10, failWindowMs = 15 * 60000,
  reqMax = 120, reqWindowMs = 60000 } = {}) {
  const fails = createLimiter({ windowMs: failWindowMs, max: failMax });
  const reqs = createLimiter({ windowMs: reqWindowMs, max: reqMax });
  return function requireAdmin(req, res, next) {
    const token = getToken();
    if (!token) return res.status(403).json({ error: 'admin disabled: ADMIN_TOKEN not set' });
    const ip = req.ip || 'unknown';
    if (fails.peek(ip) >= failMax) {
      res.set('Retry-After', String(Math.ceil(failWindowMs / 1000)));
      return res.status(429).json({ error: 'too many failed attempts, try again later' });
    }
    const r = reqs.hit(ip);
    if (!r.ok) { res.set('Retry-After', String(r.retryAfterS)); return res.status(429).json({ error: 'too many requests' }); }
    if (!tokenEquals(req.get('x-admin-token'), token)) {
      fails.hit(ip);
      return res.status(403).json({ error: 'forbidden' });
    }
    res.set('Cache-Control', 'no-store');
    next();
  };
}

// Sicherheits-Header für alle Antworten. CSP: Skripte und Styles nur vom eigenen Server
// (Leaflet liegt in public/vendor), Kacheln von OpenStreetMap.
const TILE_HOSTS = 'https://tile.openstreetmap.org';
function securityHeaders(req, res, next) {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');   // Share-Schlüssel nie im Referer
  res.set('X-Frame-Options', 'DENY');
  res.set('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  res.set('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",        // Leaflet setzt Inline-Styles
    `img-src 'self' data: ${TILE_HOSTS}`,
    "connect-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
    "form-action 'self'",
  ].join('; '));
  next();
}

module.exports = { createLimiter, rateLimit, tokenEquals, createAdminGuard, securityHeaders, TILE_HOSTS };
