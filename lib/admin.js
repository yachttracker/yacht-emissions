// ── Admin-API für die Seite /admin (alle Routen mit x-admin-token) ──────────
// Funktionen (Entscheidung 2026-10-18):
//   (a) globaler Schalter "Owner names visible" (Standard aus)
//   (b) Share-Links mit Schlüssel anlegen, auflisten, widerrufen
//   (c) Eigentümer je Yacht eintragen (Name, Quell-URL, Status)
// Antworten hier sind NICHT maskiert (nur für Paul mit Token).

const owners = require('./owners');

function mountAdmin(app, { pool, store, YACHTS, requireAdmin, CFG }) {
  const fail = (res, err, status = 400) => res.status(status).json({ error: err.message || String(err) });
  const known = new Set(YACHTS.map(y => y.mmsi));

  app.get('/admin/api/state', requireAdmin, async (_, res) => {
    try {
      const [settings, keys, links] = await Promise.all([
        pool.query(`SELECT value, updated_at FROM app_settings WHERE key = 'owner_names_visible'`),
        pool.query(`SELECT id, label, created_at, revoked_at, last_used_at FROM share_keys ORDER BY created_at DESC`),
        pool.query(`SELECT v.mmsi, v.source_url, v.status, v.note, v.updated_at, o.id AS owner_id, o.alias, o.name
                      FROM vessel_owner v JOIN owners o ON o.id = v.owner_id`),
      ]);
      const byMmsi = new Map(links.rows.map(r => [String(r.mmsi), r]));
      const allOwners = (await pool.query('SELECT id, alias, name FROM owners ORDER BY lower(name)')).rows;
      const s = settings.rows[0];
      res.json({
        dataset: CFG.dataset,
        owner_names_visible: s ? (s.value === true || s.value === 'true') : false,
        settings_updated_at: s ? s.updated_at : null,
        share_keys: keys.rows,
        owners: allOwners,
        vessels: YACHTS.map(y => ({ mmsi: y.mmsi, name: y.name, flag: y.flag || null, owner: byMmsi.get(y.mmsi) || null })),
      });
    } catch (err) { fail(res, err, 500); }
  });

  app.put('/admin/api/settings', requireAdmin, async (req, res) => {
    try {
      const v = req.body && req.body.owner_names_visible;
      if (typeof v !== 'boolean') throw new Error('owner_names_visible must be true or false');
      await owners.setVisible(pool, v);
      store.invalidate();
      console.log(`[ADMIN] owner_names_visible = ${v}`);
      res.json({ owner_names_visible: v });
    } catch (err) { fail(res, err); }
  });

  app.post('/admin/api/share-keys', requireAdmin, async (req, res) => {
    try {
      const k = await owners.createShareKey(pool, req.body && req.body.label);
      store.invalidate();
      console.log(`[ADMIN] Share-Link angelegt: #${k.id} "${k.label}"`);
      res.status(201).json(k);
    } catch (err) { fail(res, err); }
  });

  app.post('/admin/api/share-keys/:id/revoke', requireAdmin, async (req, res) => {
    try {
      const r = await owners.revokeShareKey(pool, req.params.id);
      store.invalidate();
      console.log(`[ADMIN] Share-Link #${req.params.id} widerrufen`);
      res.json(r);
    } catch (err) { fail(res, err); }
  });

  app.put('/admin/api/vessels/:mmsi/owner', requireAdmin, async (req, res) => {
    try {
      if (!known.has(req.params.mmsi)) return fail(res, new Error('mmsi not in fleet'), 404);
      const r = await owners.upsertVesselOwner(pool, req.params.mmsi, req.body || {});
      store.invalidate();
      console.log(`[ADMIN] Eigentümer für ${req.params.mmsi} gesetzt (${r.alias}, ${r.status})`);
      res.json(r);
    } catch (err) { fail(res, err); }
  });

  app.delete('/admin/api/vessels/:mmsi/owner', requireAdmin, async (req, res) => {
    try {
      const r = await owners.removeVesselOwner(pool, req.params.mmsi);
      store.invalidate();
      res.json(r);
    } catch (err) { fail(res, err); }
  });
}

module.exports = { mountAdmin };
