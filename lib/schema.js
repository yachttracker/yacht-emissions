// ── Datenbankschema für Abruflogik (idempotent, läuft bei jedem Start) ──────
// positions.source   : 'live' (Sammelabruf, Karte) | 'history' (Tageshistorie)
// positions.dataset  : 'prod' | 'mock' | 'trial' – getrennte Datenbestände
// positions.observed : true = gemessen; false = interpoliert (für spätere IMO-4-artige Lückenfüllung)
// vessel_days        : je Yacht und UTC-Tag Erkennung + Historienstatus
// credit_log         : jeder Abruf mit tatsächlich berechneten Credits
async function migrate(pool) {
  await pool.query(`
    ALTER TABLE positions ADD COLUMN IF NOT EXISTS source   TEXT    NOT NULL DEFAULT 'live';
    ALTER TABLE positions ADD COLUMN IF NOT EXISTS dataset  TEXT    NOT NULL DEFAULT 'prod';
    ALTER TABLE positions ADD COLUMN IF NOT EXISTS observed BOOLEAN NOT NULL DEFAULT true;
    ALTER TABLE positions ADD COLUMN IF NOT EXISTS cog      DOUBLE PRECISION;

    -- Dubletten entfernen, bevor der Unique-Index angelegt wird
    DELETE FROM positions a USING positions b
     WHERE a.id > b.id AND a.mmsi = b.mmsi AND a.timestamp = b.timestamp
       AND a.source = b.source AND a.dataset = b.dataset;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_positions_key
      ON positions(dataset, mmsi, timestamp, source);

    CREATE TABLE IF NOT EXISTS vessel_days (
      dataset         TEXT    NOT NULL DEFAULT 'prod',
      mmsi            TEXT    NOT NULL,
      day             DATE    NOT NULL,
      live_polls      INTEGER NOT NULL DEFAULT 0,
      live_hits       INTEGER NOT NULL DEFAULT 0,
      moved           BOOLEAN NOT NULL DEFAULT false,
      moved_reason    TEXT,
      history_status  TEXT    NOT NULL DEFAULT 'none',   -- none | done | empty | failed
      history_points  INTEGER,
      history_credits INTEGER,
      history_max_sog DOUBLE PRECISION,
      history_moved   BOOLEAN,                           -- Kontrolle der Erkennung
      history_at      TIMESTAMPTZ,
      ext             JSONB,                             -- letzte extended-Felder (Kalibrierung)
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (dataset, mmsi, day)
    );

    CREATE TABLE IF NOT EXISTS credit_log (
      id          SERIAL PRIMARY KEY,
      ts          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      provider    TEXT NOT NULL,
      dataset     TEXT NOT NULL,
      kind        TEXT NOT NULL,          -- live | live_ext | history
      mmsi        TEXT,
      day_from    DATE,
      day_to      DATE,
      ids         INTEGER,
      credits     INTEGER NOT NULL,
      expected    INTEGER,
      http_status INTEGER,
      dry_run     BOOLEAN NOT NULL DEFAULT false,
      note        TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_credit_log_ts ON credit_log(ts);

    -- AIS-/Datenbank-Stammdaten aus dem täglichen extended-Abruf (MST). Quelle der Werte:
    -- Anbieterdatenbank bzw. AIS-Eigenangaben → für die Arbeit als "Anbieterangabe" kennzeichnen.
    CREATE TABLE IF NOT EXISTS vessel_static (
      dataset      TEXT NOT NULL DEFAULT 'prod',
      mmsi         TEXT NOT NULL,
      provider     TEXT NOT NULL,
      imo          TEXT,
      callsign     TEXT,
      vessel_type  TEXT,
      ais_type     TEXT,
      flag         TEXT,
      gt           DOUBLE PRECISION,
      dwt          DOUBLE PRECISION,
      built        INTEGER,
      draught      DOUBLE PRECISION,
      length_m     DOUBLE PRECISION,   -- size_a + size_b
      beam_m       DOUBLE PRECISION,   -- size_c + size_d
      raw          JSONB,
      fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (dataset, mmsi, provider)
    );

    -- Hafen/Anker je Live-Meldung (aus extended), für Betriebsphasen und Landstrom-Szenario
    ALTER TABLE positions ADD COLUMN IF NOT EXISTS current_port TEXT;
  `);
}

module.exports = { migrate };
