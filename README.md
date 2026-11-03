# yacht-emissions
Real-time superyacht emissions dashboard (Masterarbeit, HfWU / HfT Stuttgart).

Backend (Node.js/Express, PostgreSQL) und Frontend liegen in diesem Repo und laufen als
ein Dienst auf Railway. Das Frontend liest nur das eigene Backend-JSON; Besucher lösen
nie Anbieter-Abrufe aus.

## Aufbau
| Pfad | Inhalt |
|---|---|
| `server.js` | Express-Server, API, Zeitintegration, Zeitplan der Abruflogik |
| `emissions.js` | Emissionsrate je AIS-Meldung (`CALC_VERSION`) |
| `fleet.js`, `data/fleet.csv` | Flotte (108 Yachten: IMO, MMSI, Länge, GT, Baujahr, Kategorie; recherchierte Antriebsdaten mit Quelle) – **ohne Eigentümer** |
| `lib/periods.js` | Zeitfenster: rollierend, Kalender (UTC), frei |
| `lib/owners.js` | Eigentümer-Tabellen, Sichtbarkeit, Share-Links, zentrale Maskierung |
| `lib/admin.js` | Admin-API (`/admin/api/*`) |
| `lib/security.js` | Admin-Token (konstanter Vergleich), Rate-Limit, Sicherheits-Header |
| `lib/dashboard.js` | Lesefunktionen fürs Dashboard (Flotte, Verlauf, Datenbereich), 60-s-Cache |
| `lib/`, `providers/` | Abruflogik (siehe Projektdokument 07_abruflogik) |
| `public/` | Frontend (statische Dateien, ES-Module, keine Build-Kette) |
| `public/admin/` | Admin-Seite |
| `public/vendor/leaflet/` | Leaflet 1.9.4 (BSD-2-Clause, offizielles Release) |
| `public/fonts/` | IBM Plex Sans (SIL OFL 1.1) |
| `dev/serve.js`, `dev/mock/` | Lokaler Dev-Server mit erfundenen Daten (ohne Datenbank) |
| `test/api.test.js` | API-Tests (node:test), laufen in der CI gegen Postgres |

## Sichtbarkeit (öffentlich / privat)
Schalter per Railway-Variable, ohne Codeänderung (`lib/access.js`):

| `SITE_ACCESS` | Wirkung |
|---|---|
| `private` (Standard, auch wenn nicht gesetzt) | Dashboard, API und Admin nur mit Zugang; `/health` bleibt offen |
| `public` | alles öffentlich wie bis 03.11.2026 |

Zugang im privaten Modus mit `SITE_PASSWORD` oder `ADMIN_TOKEN`: Browser-Anmeldung
(Benutzername beliebig), Link `…/?access=<Passwort>` (setzt ein Cookie für 30 Tage) oder
Kopfzeile `x-site-access` für Skripte. Passwort ändern = Variable ändern, alte Cookies
verfallen damit. Grund: Die API-Bedingungen von MyShipTracking erlauben nur interne
Nutzung (Terms 4.2/4.3); öffentlich erst nach schriftlicher Klärung.

## API
| Endpunkt | Inhalt |
|---|---|
| `GET /api/emissions/summary` | Summen je Yacht. Parameter: `period=day\|week\|month\|year`, `mode=rolling\|calendar`, `from`/`to` (`YYYY-MM-DD`, UTC, `to` inklusive). Ohne `meta` wie bisher ein Array; `meta=1` → `{ meta, rows }` mit Fenster und Datenbereich (`data_from`, `data_to`). |
| `GET /api/yacht/:mmsi/history` | Verlauf einer Yacht, gleiche Zeitparameter; `meta=1` → `{ meta, points }`; `max_points=N` verdichtet für die Anzeige |
| `GET /api/fleet` | Flotte mit Stammdaten und Belegstatus je Feld, letzte Position, Datenbereich |
| `GET /api/yachts/latest` | Letzte Meldung je Yacht |
| `GET /api/status`, `GET /health` | Abrufstatus, Rechenversion |

Alle `/api`-Antworten laufen durch die Eigentümer-Maskierung: Namen erscheinen nur bei
eingeschalteter Sichtbarkeit (Admin-Seite) oder mit gültigem Share-Schlüssel
(`x-share-key`), und nur für Zuordnungen mit Status `sourced` und Quell-URL.
Sonst Alias („Owner 07“) bzw. „Owner unknown“.

## Admin-Seite
`/admin/` – nur mit der Railway-Variable `ADMIN_TOKEN` (ohne sie ist der Admin-Bereich
gesperrt). Funktionen: Eigentümernamen global ein/aus, Share-Links anlegen/widerrufen,
Eigentümer je Yacht mit Quelle und Status eintragen. Der Token liegt nur im
sessionStorage des Browser-Tabs.

## Lokal ansehen
```bash
node dev/serve.js          # http://localhost:5173 – erfundene Yachten, Banner "Demo data"
                           # Admin: http://localhost:5173/admin/  Token: dev-admin-token
```
Mit echter Datenbank: `.env` aus `.env.example` anlegen, `npm install`, `npm start`.

## Tests
```bash
DATABASE_URL=postgresql://… DATABASE_SSL=false node --test test/api.test.js
```
Die Tests legen einen eigenen Datensatz `citest` an und räumen ihn danach wieder auf.
