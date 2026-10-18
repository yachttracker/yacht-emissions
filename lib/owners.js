// ── Eigentümer, Sichtbarkeit und Maskierung ─────────────────────────────────
// Grundsatz (Entscheidung 2026-10-18): Eigentümernamen verlassen den Server nur, wenn
//   (a) der globale Schalter "owner_names_visible" an ist ODER ein gültiger Share-Schlüssel
//       mitgeschickt wird, UND
//   (b) die Zuordnung Yacht → Eigentümer den Status 'sourced' (belegt) und eine Quell-URL hat.
// Sonst: stabiler Alias ("Owner 07") bzw. "Owner unknown".
// Eigentümer liegen nur in der Datenbank, nicht im öffentlichen Repo.
//
// Warum nicht vessel_static? Die Tabelle hält Anbieterangaben je (dataset, mmsi, provider)
// und wird bei jedem extended-Abruf überschrieben. Eigentümer sind eigene Recherche, gelten
// für alle Datensätze und brauchen Quelle + Status je Zuordnung → eigene Tabellen.

const crypto = require('crypto');

const STATUS = ['sourced', 'unverified'];          // sourced = belegt, unverified = ungeklärt
const UNKNOWN = 'Owner unknown';
const HIDDEN = '[owner hidden]';

async function migrateOwners(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS owners (
      id         SERIAL PRIMARY KEY,
      alias      TEXT NOT NULL UNIQUE,              -- einmal vergeben, nie neu berechnet
      name       TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS uq_owners_name ON owners (lower(name));

    -- Zuordnung Yacht → Eigentümer; Quelle und Status gehören zur Zuordnung
    -- (die Quelle belegt, dass X die Yacht Y besitzt), nicht zur Person.
    CREATE TABLE IF NOT EXISTS vessel_owner (
      mmsi       TEXT PRIMARY KEY,
      owner_id   INTEGER NOT NULL REFERENCES owners(id),
      source_url TEXT,
      status     TEXT NOT NULL DEFAULT 'unverified' CHECK (status IN ('sourced', 'unverified')),
      note       TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS app_settings (
      key        TEXT PRIMARY KEY,
      value      JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    INSERT INTO app_settings (key, value) VALUES ('owner_names_visible', 'false'::jsonb)
      ON CONFLICT (key) DO NOTHING;

    -- Share-Links: gespeichert wird nur der SHA-256-Hash des Schlüssels
    CREATE TABLE IF NOT EXISTS share_keys (
      id           SERIAL PRIMARY KEY,
      label        TEXT NOT NULL,
      key_hash     TEXT NOT NULL UNIQUE,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      revoked_at   TIMESTAMPTZ,
      last_used_at TIMESTAMPTZ
    );
  `);
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const validUrl = (u) => { try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:'; } catch { return false; } };

// ── Zwischenspeicher (kleine Tabellen, wenige Änderungen) ───────────────────
function createOwnerStore(pool, { ttlMs = 30000 } = {}) {
  let loadedAt = 0, loading = null;
  let byMmsi = new Map();       // mmsi → { owner_id, alias, name, source_url, status }
  let visible = false;
  let keyHashes = new Map();    // hash → { id, label, last_used_at }
  let hiddenAlways = [];        // Namen ohne darstellbare Zuordnung
  let allNames = [];

  async function load() {
    const [links, settings, keys, owners] = await Promise.all([
      pool.query(`SELECT v.mmsi, v.owner_id, v.source_url, v.status, o.alias, o.name
                    FROM vessel_owner v JOIN owners o ON o.id = v.owner_id`),
      pool.query(`SELECT value FROM app_settings WHERE key = 'owner_names_visible'`),
      pool.query(`SELECT id, label, key_hash, last_used_at FROM share_keys WHERE revoked_at IS NULL`),
      pool.query(`SELECT id, name FROM owners`),
    ]);
    const m = new Map();
    for (const r of links.rows) m.set(String(r.mmsi), r);
    byMmsi = m;
    const v = settings.rows[0] ? settings.rows[0].value : false;
    visible = v === true || v === 'true';
    keyHashes = new Map(keys.rows.map(r => [r.key_hash, r]));
    const shown = new Set([...m.values()].filter(displayable).map(r => r.owner_id));
    allNames = owners.rows.map(r => r.name).filter(n => n && n.trim().length >= 4);
    hiddenAlways = owners.rows.filter(r => !shown.has(r.id)).map(r => r.name).filter(n => n && n.trim().length >= 4);
    loadedAt = Date.now();
  }

  async function ensure() {
    if (Date.now() - loadedAt < ttlMs) return;
    if (!loading) loading = load().finally(() => { loading = null; });
    await loading;
  }

  // Share-Schlüssel prüfen; last_used_at höchstens alle 10 min schreiben
  async function checkShareKey(key) {
    if (!key || typeof key !== 'string' || key.length < 20 || key.length > 200) return false;
    const k = keyHashes.get(sha256(key));
    if (!k) return false;
    const last = k.last_used_at ? new Date(k.last_used_at).getTime() : 0;
    if (Date.now() - last > 600000) {
      k.last_used_at = new Date().toISOString();
      pool.query('UPDATE share_keys SET last_used_at = NOW() WHERE id = $1', [k.id]).catch(() => {});
    }
    return true;
  }

  return {
    ensure,
    invalidate: () => { loadedAt = 0; },
    isVisible: () => visible,
    checkShareKey,
    link: (mmsi) => byMmsi.get(String(mmsi)) || null,
    // Namen, die in dieser Antwort nirgends stehen dürfen
    forbiddenNames: (reveal) => (reveal ? hiddenAlways : allNames),
  };
}

function displayable(link) {
  return !!(link && link.status === 'sourced' && link.source_url && validUrl(link.source_url) && link.name);
}

// Öffentliche Eigentümerfelder einer Yacht
function ownerFields(link, reveal) {
  if (!displayable(link)) {
    return { owner: UNKNOWN, owner_alias: null, owner_known: false, owner_masked: !reveal, owner_source_url: null };
  }
  if (reveal) {
    return { owner: link.name, owner_alias: link.alias, owner_known: true, owner_masked: false, owner_source_url: link.source_url };
  }
  return { owner: link.alias, owner_alias: link.alias, owner_known: true, owner_masked: true, owner_source_url: null };
}

// ── Zentrale Maskierung jeder öffentlichen Antwort ──────────────────────────
// 1. Jedes Objekt mit mmsi bekommt die Eigentümerfelder aus der Datenbank (überschreibt
//    z. B. positions.owner, falls es doch einmal mitkommt).
// 2. Objekte ohne mmsi verlieren ein Feld "owner".
// 3. Sicherheitsnetz: Jeder Text, der einen nicht freigegebenen Namen enthält, wird ersetzt.
function maskPayload(body, store, reveal) {
  const names = store.forbiddenNames(reveal).map(n => n.toLowerCase());
  const scrub = (s) => {
    if (!names.length) return s;
    const low = s.toLowerCase();
    if (!names.some(n => low.includes(n))) return s;
    let out = s;
    for (const n of store.forbiddenNames(reveal)) {
      out = out.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), HIDDEN);
    }
    return out;
  };
  const walk = (v, depth) => {
    if (depth > 8 || v === null || v === undefined) return v;
    if (typeof v === 'string') return scrub(v);
    if (Array.isArray(v)) return v.map(x => walk(x, depth + 1));
    if (v instanceof Date) return v;
    if (typeof v === 'object') {
      const out = {};
      for (const [k, x] of Object.entries(v)) {
        if (k === 'owner' || k.startsWith('owner_')) continue;   // nur aus der Datenbank setzen
        out[k] = walk(x, depth + 1);
      }
      if (out.mmsi !== undefined && out.mmsi !== null && /^\d{9}$/.test(String(out.mmsi))) {
        Object.assign(out, ownerFields(store.link(out.mmsi), reveal));
      }
      return out;
    }
    return v;
  };
  return walk(body, 0);
}

// Express-Middleware für /api: Sichtbarkeit bestimmen, res.json maskieren, nicht cachen
function publicApi(store) {
  return async (req, res, next) => {
    try {
      await store.ensure();
      const key = req.get('x-share-key');
      const viaKey = key ? await store.checkShareKey(key) : false;
      const reveal = store.isVisible() || viaKey;
      req.ownerView = { reveal, via: store.isVisible() ? 'global' : viaKey ? 'share_key' : 'masked',
                        share_key: key ? (viaKey ? 'valid' : 'invalid') : 'none' };
      res.set('Cache-Control', 'no-store');
      res.set('Vary', 'x-share-key');
      const json = res.json.bind(res);
      res.json = (body) => json(maskPayload(body, store, reveal));
      next();
    } catch (err) {
      res.status(500).json({ error: 'owner store unavailable' });
    }
  };
}

// ── Schreibfunktionen für die Admin-Seite ───────────────────────────────────
// Alias: zufällige, freie Nummer (kein Rückschluss auf Reihenfolge, Name oder Rang)
async function allocateAlias(pool) {
  const used = new Set((await pool.query('SELECT alias FROM owners')).rows.map(r => r.alias));
  for (const width of [2, 3, 4]) {
    const max = 10 ** width - 1;
    const free = [];
    for (let i = 1; i <= max; i++) {
      const a = `Owner ${String(i).padStart(width, '0')}`;
      if (!used.has(a)) free.push(a);
    }
    // Erst zur nächsten Stellenzahl wechseln, wenn die Auswahl klein wird (Zufall bleibt groß)
    if (free.length >= Math.ceil(max * 0.2)) return free[crypto.randomInt(free.length)];
  }
  throw new Error('no free alias number');
}

async function upsertVesselOwner(pool, mmsi, { name, source_url, status, note }) {
  name = String(name || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 200) throw new Error('name: 2–200 characters');
  status = STATUS.includes(status) ? status : 'unverified';
  source_url = source_url ? String(source_url).trim() : null;
  if (source_url && (!validUrl(source_url) || source_url.length > 1000)) throw new Error('source_url must be a valid http(s) URL');
  if (status === 'sourced' && !source_url) throw new Error('status "sourced" requires a source URL');
  note = note ? String(note).slice(0, 2000) : null;

  let owner = (await pool.query('SELECT id, alias FROM owners WHERE lower(name) = lower($1)', [name])).rows[0];
  for (let attempt = 0; !owner && attempt < 5; attempt++) {
    const alias = await allocateAlias(pool);
    const r = await pool.query(`INSERT INTO owners (alias, name) VALUES ($1, $2)
                                ON CONFLICT DO NOTHING RETURNING id, alias`, [alias, name]);
    owner = r.rows[0] || (await pool.query('SELECT id, alias FROM owners WHERE lower(name) = lower($1)', [name])).rows[0];
  }
  if (!owner) throw new Error('owner could not be created');
  await pool.query(`
    INSERT INTO vessel_owner (mmsi, owner_id, source_url, status, note, updated_at)
    VALUES ($1, $2, $3, $4, $5, NOW())
    ON CONFLICT (mmsi) DO UPDATE SET owner_id = EXCLUDED.owner_id, source_url = EXCLUDED.source_url,
      status = EXCLUDED.status, note = EXCLUDED.note, updated_at = NOW()`,
  [String(mmsi), owner.id, source_url, status, note]);
  return { mmsi: String(mmsi), owner_id: owner.id, alias: owner.alias, name, source_url, status, note };
}

async function removeVesselOwner(pool, mmsi) {
  // Der Eigentümer-Datensatz bleibt bestehen, damit sein Alias stabil bleibt
  const r = await pool.query('DELETE FROM vessel_owner WHERE mmsi = $1', [String(mmsi)]);
  return { removed: r.rowCount };
}

async function setVisible(pool, visible) {
  await pool.query(`INSERT INTO app_settings (key, value, updated_at) VALUES ('owner_names_visible', $1::jsonb, NOW())
                    ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
  [visible ? 'true' : 'false']);
}

async function createShareKey(pool, label) {
  label = String(label || '').trim().slice(0, 100);
  if (!label) throw new Error('label is required');
  const key = crypto.randomBytes(32).toString('base64url');
  const r = await pool.query('INSERT INTO share_keys (label, key_hash) VALUES ($1, $2) RETURNING id, label, created_at',
    [label, sha256(key)]);
  return { ...r.rows[0], key };          // Klartext nur in dieser einen Antwort
}

async function revokeShareKey(pool, id) {
  const r = await pool.query('UPDATE share_keys SET revoked_at = NOW() WHERE id = $1 AND revoked_at IS NULL', [Number(id)]);
  return { revoked: r.rowCount };
}

module.exports = {
  migrateOwners, createOwnerStore, publicApi, maskPayload, ownerFields,
  upsertVesselOwner, removeVesselOwner, setVisible, createShareKey, revokeShareKey,
  STATUS, UNKNOWN, HIDDEN, sha256,
};
