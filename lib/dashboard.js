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

// Anzeige der recherchierten Stammdaten aus fleet.js
const PROPULSION_LABEL = { diesel_mech: 'Diesel-mechanical', diesel_electric: 'Diesel-electric', hybrid: 'Hybrid',
                           codag: 'CODAG (diesel + gas turbine)', sail_aux: 'Sailing yacht with auxiliary engines' };
const ENGINE_CLASS_LABEL = { hs: 'High-speed diesel (> 900 rpm)', ms: 'Medium-speed diesel (300–900 rpm)', ss: 'Slow-speed diesel (≤ 300 rpm)' };
const SEGMENT_LABEL = { private: 'Private yacht', state_royal: 'State / royal yacht' };
const FACT_FIELDS = [
  ['length', 'Length', 'm'],
  ['gt', 'Gross tonnage', 'GT'],
  ['build_year', 'Year built'],
  ['propulsion', 'Propulsion', null, v => PROPULSION_LABEL[v] || v],
  ['engine', 'Engines'],
  ['mcr_kw', 'Propulsion power (model)', 'kW'],
  ['mcr_upper_kw', 'Power, upper bound', 'kW'],
  ['engine_class', 'Engine class (IMO)', null, v => ENGINE_CLASS_LABEL[v] || v],
  ['rated_rpm', 'Rated speed', 'rpm'],
  ['vmax_kn', 'Max. speed', 'kn'],
  ['draught_ref_m', 'Design draught', 'm'],
];

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
          field('mmsi', 'MMSI', y.mmsi, y.mmsi_match === 'sourced' ? 'sourced' : 'unverified',
            y.mmsi_match === 'sourced' ? 'Identifier used for AIS tracking' : 'Identifier used for AIS tracking; match to the researched yacht not yet confirmed'),
          field('flag', 'Flag', flagCode(y.flag), 'unverified', 'Derived from the MMSI country code (MID)'),
        ];
        if (y.imo) fields.push(field('imo', 'IMO', y.imo, 'sourced', 'VesselFinder / MaritimeOptima (secondary source)'));
        if (y.segment) fields.push(field('segment', 'Category', SEGMENT_LABEL[y.segment] || y.segment, 'unverified',
          y.segment === 'state_royal' ? 'Based on the owner column of Wikipedia lists, not individually verified' : fleetNote));
        // Recherchierte Stammdaten aus fleet.js (Status und Quelle je Feld)
        const facts = y.facts || {};
        for (const [key, label, unit, fmt] of FACT_FIELDS) {
          const f = facts[key];
          if (!f) continue;
          fields.push(field(key === 'length' ? 'length_m' : key, label, fmt ? fmt(f.value) : f.value, f.status, f.src, unit));
        }
        if (!facts.length && y.length != null) fields.push(field('length_m', 'Length', y.length, 'unverified', 'Approximate value, not yet verified', 'm'));
        if (!(facts.mcr_kw && facts.mcr_kw.status === 'sourced') && l && l.mcr_kw != null && l.mcr_estimated) {
          fields.push(field('mcr_kw_estimate', 'Engine power used in model', Math.round(l.mcr_kw), 'assumption',
            'Estimated from length (no source) until researched', 'kW'));
        }
        if (s) {
          const pn = `Provider data (${s.provider}), as of ${new Date(s.fetched_at).toISOString().slice(0, 10)}`;
          if (s.imo && !y.imo) fields.push(field('imo', 'IMO', s.imo, 'provider', pn));
          else if (s.imo && String(s.imo) !== String(y.imo)) fields.push(field('imo_provider', 'IMO (provider)', s.imo, 'provider', `${pn}; differs from fleet list`));
          if (s.gt != null) fields.push(field('gt_provider', 'Gross tonnage (provider)', s.gt, 'provider', pn, 'GT'));
          if (s.built != null) fields.push(field('built_provider', 'Year built (provider)', s.built, 'provider', pn));
          if (s.length_m != null) fields.push(field('length_provider', 'Length (provider)', s.length_m, 'provider', pn, 'm'));
          if (s.beam_m != null) fields.push(field('beam_m', 'Beam', s.beam_m, 'provider', pn, 'm'));
          if (s.draught != null) fields.push(field('draught', 'Draught', s.draught, 'provider', pn, 'm'));
        }
        return {
          mmsi: y.mmsi, imo: y.imo || null, name: y.name, category: 'yacht', segment: y.segment || null,
          flag: y.flag || null, flag_code: flagCode(y.flag), length_m: y.length ?? null,
          // Platzhalter für vorbereitete Filter (Stammdaten fehlen noch)
          propulsion: y.propulsion || null, build_year: y.build_year ?? s?.built ?? null, gt: y.gt ?? s?.gt ?? null,
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
