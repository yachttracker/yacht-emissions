// ── Lesefunktionen für das Dashboard (nur Datenbank, keine Anbieter-APIs) ────
// Kleiner Antwort-Cache (Standard 60 s): Daten kommen nur wenige Male am Tag hinzu,
// das Dashboard soll bei vielen Besuchern die Datenbank nicht belasten.
// Gecacht werden Rohdaten VOR der Eigentümer-Maskierung; maskiert wird je Anfrage.

const SOURCES = "('live', 'history')";

function createCache(ttlMs) {
  const m = new Map();
  return async (key, fn) => {
    const hit = m.get(key);
    if (hit && Date.now() - hit.at < ttlMs) return hit.value;
    const value = await fn();
    m.set(key, { at: Date.now(), value });
    if (m.size > 500) m.delete(m.keys().next().value);
    return value;
  };
}

// Flaggen-Emoji (Regional Indicator) → ISO-3166-Alpha-2, z. B. 🇰🇾 → "KY"
function flagCode(flag) {
  if (!flag) return null;
  const cps = [...String(flag)].map(c => c.codePointAt(0));
  if (cps.length === 2 && cps.every(c => c >= 0x1F1E6 && c <= 0x1F1FF)) {
    return String.fromCharCode(...cps.map(c => c - 0x1F1E6 + 65));
  }
  return /^[A-Z]{2}$/.test(String(flag)) ? String(flag) : null;
}

// Stammdaten-Feld mit Belegstatus: sourced (belegt) | assumption (Annahme) |
// unverified (ungeklärt/ungeprüft) | provider (Anbieterangabe AIS/Datenbank)
const field = (key, label, value, status, note, unit) => ({ key, label, value, unit: unit || null, status, note: note || null });

function createDashboard({ pool, CFG, YACHTS, ttlMs = 60000 }) {
  const cache = createCache(ttlMs);

  async function dataRange() {
    return cache(`range:${CFG.dataset}`, async () => {
      const r = await pool.query(`
        SELECT MIN(timestamp) AS data_from, MAX(timestamp) AS data_to
          FROM positions WHERE dataset = $1 AND source IN ${SOURCES}`, [CFG.dataset]);
      return { data_from: r.rows[0]?.data_from || null, data_to: r.rows[0]?.data_to || null };
    });
  }

  // Flottenliste mit Stammdaten (Projektliste fleet.js + Anbieterangaben + letzte Meldung)
  async function fleet() {
    return cache(`fleet:${CFG.dataset}`, async () => {
      const [stat, last] = await Promise.all([
        pool.query(`SELECT DISTINCT ON (mmsi) mmsi, provider, imo, callsign, vessel_type, gt, built, draught,
                           length_m, beam_m, fetched_at
                      FROM vessel_static WHERE dataset = $1 ORDER BY mmsi, fetched_at DESC`, [CFG.dataset]),
        pool.query(`SELECT DISTINCT ON (mmsi) mmsi, timestamp, latitude, longitude, speed_knots, nav_status,
                           mcr_kw, mcr_estimated, calc_version, source, current_port
                      FROM positions WHERE dataset = $1 AND source IN ${SOURCES}
                     ORDER BY mmsi, timestamp DESC`, [CFG.dataset]),
      ]);
      const st = new Map(stat.rows.map(r => [String(r.mmsi), r]));
      const ls = new Map(last.rows.map(r => [String(r.mmsi), r]));
      return YACHTS.map(y => {
        const s = st.get(y.mmsi), l = ls.get(y.mmsi);
        const fleetNote = 'Project fleet list, not yet verified';
        const fields = [
          field('name', 'Name', y.name, 'unverified', fleetNote),
          field('mmsi', 'MMSI', y.mmsi, 'unverified', 'Identifier used for AIS tracking'),
          field('flag', 'Flag', flagCode(y.flag), 'unverified', fleetNote),
          field('length_m', 'Length', y.length ?? null, 'unverified', 'Approximate value, not yet verified', 'm'),
        ];
        if (Number.isFinite(y.vmax_kn)) fields.push(field('vmax_kn', 'Max. speed', y.vmax_kn, 'unverified', fleetNote, 'kn'));
        if (l && l.mcr_kw != null) {
          fields.push(field('mcr_kw', 'Engine power (MCR)', Math.round(l.mcr_kw), l.mcr_estimated ? 'assumption' : 'unverified',
            l.mcr_estimated ? 'Estimated from length (no source) until researched' : fleetNote, 'kW'));
        }
        if (s) {
          const pn = `Provider data (${s.provider}), as of ${new Date(s.fetched_at).toISOString().slice(0, 10)}`;
          if (s.imo) fields.push(field('imo', 'IMO', s.imo, 'provider', pn));
          if (s.gt != null) fields.push(field('gt', 'Gross tonnage', s.gt, 'provider', pn, 'GT'));
          if (s.built != null) fields.push(field('built', 'Year built', s.built, 'provider', pn));
          if (s.length_m != null) fields.push(field('length_provider', 'Length (provider)', s.length_m, 'provider', pn, 'm'));
          if (s.beam_m != null) fields.push(field('beam_m', 'Beam', s.beam_m, 'provider', pn, 'm'));
          if (s.draught != null) fields.push(field('draught', 'Draught', s.draught, 'provider', pn, 'm'));
        }
        return {
          mmsi: y.mmsi, name: y.name, category: 'yacht',
          flag: y.flag || null, flag_code: flagCode(y.flag), length_m: y.length ?? null,
          // Platzhalter für vorbereitete Filter (Stammdaten fehlen noch)
          propulsion: y.propulsion || null, build_year: s?.built ?? null, gt: s?.gt ?? null,
          last_seen: l?.timestamp || null,
          last_position: l ? { lat: l.latitude, lon: l.longitude, speed_knots: l.speed_knots, nav_status: l.nav_status,
                               source: l.source, current_port: l.current_port } : null,
          fields,
        };
      });
    });
  }

  // Verlauf einer Yacht im Fenster; maxPoints > 0 → zeitliche Buckets (nur Anzeige)
  async function history(mmsi, win, maxPoints) {
    const key = `hist:${CFG.dataset}:${mmsi}:${+win.t0}:${+win.t1}:${maxPoints || 0}`;
    return cache(key, async () => {
      const base = `
        SELECT p.timestamp, p.latitude, p.longitude, p.speed_knots, p.co2_kg_h, p.fuel_kg_h, p.source
          FROM positions p
         WHERE p.mmsi = $1 AND p.dataset = $2
           AND p.timestamp > $3::timestamptz AND p.timestamp <= $4::timestamptz
           AND (p.source = 'history' OR NOT EXISTS (
                 SELECT 1 FROM vessel_days v
                  WHERE v.dataset = p.dataset AND v.mmsi = p.mmsi
                    AND v.day = (p.timestamp AT TIME ZONE 'UTC')::date
                    AND v.history_status = 'done'))`;
      const params = [String(mmsi), CFG.dataset, win.t0.toISOString(), win.t1.toISOString()];
      const count = (await pool.query(`SELECT COUNT(*)::int AS n FROM (${base}) q`, params)).rows[0].n;
      if (!maxPoints || count <= maxPoints) {
        const r = await pool.query(`${base} ORDER BY p.timestamp ASC`, params);
        return { points: r.rows, points_raw: count, bucket_s: 0 };
      }
      const bucketS = Math.max(60, Math.ceil((win.t1 - win.t0) / 1000 / maxPoints));
      const r = await pool.query(`
        SELECT MIN(q.timestamp) AS timestamp,
               (ARRAY_AGG(q.latitude  ORDER BY q.timestamp DESC))[1] AS latitude,
               (ARRAY_AGG(q.longitude ORDER BY q.timestamp DESC))[1] AS longitude,
               AVG(q.speed_knots)::float8 AS speed_knots,
               AVG(q.co2_kg_h)::float8    AS co2_kg_h,
               AVG(q.fuel_kg_h)::float8   AS fuel_kg_h,
               MAX(q.source)              AS source,
               COUNT(*)::int              AS n
          FROM (${base}) q
         GROUP BY FLOOR(EXTRACT(EPOCH FROM q.timestamp) / $5)
         ORDER BY 1 ASC`, [...params, bucketS]);
      return { points: r.rows, points_raw: count, bucket_s: bucketS };
    });
  }

  async function yachtRange(mmsi) {
    return cache(`yrange:${CFG.dataset}:${mmsi}`, async () => {
      const r = await pool.query(`SELECT MIN(timestamp) AS data_from, MAX(timestamp) AS data_to
                                    FROM positions WHERE dataset = $1 AND mmsi = $2 AND source IN ${SOURCES}`,
      [CFG.dataset, String(mmsi)]);
      return { data_from: r.rows[0]?.data_from || null, data_to: r.rows[0]?.data_to || null };
    });
  }

  return { dataRange, fleet, history, yachtRange, cache, flagCode };
}

module.exports = { createDashboard, createCache, flagCode };
