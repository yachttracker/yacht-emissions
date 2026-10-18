// ── Karten (Leaflet 1.9.4, lokal in vendor/; Kacheln: OpenStreetMap) ─────────
// Leaflet wird erst geladen, wenn eine Karte gebraucht wird.

import { h, clear } from './dom.js';
import * as fmt from './format.js';

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
let loading = null;

function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (loading) return loading;
  loading = new Promise((resolve, reject) => {
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = '/vendor/leaflet/leaflet.css';
    document.head.append(css);
    const js = document.createElement('script');
    js.src = '/vendor/leaflet/leaflet.js';
    js.onload = () => resolve(window.L);
    js.onerror = () => { loading = null; reject(new Error('Map library failed to load.')); };
    document.head.append(js);
  });
  return loading;
}

function baseMap(L, el) {
  const map = L.map(el, { worldCopyJump: true, zoomControl: true, attributionControl: true, scrollWheelZoom: false });
  L.tileLayer(TILE_URL, { maxZoom: 18, attribution: ATTRIBUTION }).addTo(map);
  map.attributionControl.setPrefix(false);
  // Mausrad erst nach Klick in die Karte (Seite bleibt scrollbar)
  map.on('click', () => map.scrollWheelZoom.enable());
  map.on('mouseout', () => map.scrollWheelZoom.disable());
  return map;
}

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#2a78d6';

// Übersicht: ein Kreis je Yacht an der letzten Position; Fläche ∝ Metrik im Zeitraum
export async function renderFleetMap(el, { yachts, valueOf, metricLabel, onSelect, selected }) {
  let L;
  try { L = await loadLeaflet(); } catch (e) { clear(el).append(h('p', { class: 'map-error' }, e.message)); return null; }
  if (el._map) { el._map.remove(); el._map = null; }
  clear(el);
  const map = baseMap(L, el);
  el._map = map;
  const color = cssVar('--cat-yacht');
  const ring = cssVar('--surface');
  const withPos = yachts.filter(y => y.last_position && Number.isFinite(y.last_position.lat));
  const max = Math.max(1, ...withPos.map(valueOf).filter(Number.isFinite));
  const bounds = [];
  for (const y of withPos) {
    const v = valueOf(y);
    const r = Number.isFinite(v) && v > 0 ? 6 + 18 * Math.sqrt(v / max) : 5;
    const ll = [y.last_position.lat, y.last_position.lon];
    bounds.push(ll);
    const m = L.circleMarker(ll, {
      radius: r, color: ring, weight: 2, fillColor: color,
      fillOpacity: Number.isFinite(v) && v > 0 ? 0.85 : 0.35, className: y.mmsi === selected ? 'is-selected' : '',
    }).addTo(map);
    const tipEl = h('div', { class: 'map-tip' },
      h('strong', {}, y.owner || 'Owner unknown'),
      h('span', {}, y.flag_code ? `${y.name}, ${y.flag_code}` : y.name),
      h('span', {}, Number.isFinite(v) ? `${metricLabel}: ${fmt.mass(v).text}` : `${metricLabel}: no data in period`),
      h('span', { class: 'muted' }, `Last position ${fmt.ago(y.last_seen)}`));
    m.bindTooltip(tipEl, { direction: 'top', offset: [0, -r] });
    m.on('click', () => onSelect && onSelect(y.mmsi));
    m.on('keypress', (e) => { if (e.originalEvent.key === 'Enter') onSelect && onSelect(y.mmsi); });
  }
  if (bounds.length) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 8 });
  else map.setView([40, 10], 3);
  setTimeout(() => map.invalidateSize(), 50);
  return { map, shown: withPos.length };
}

// Detailkarte: Route im Zeitraum + letzte Position
export async function renderRouteMap(el, { points, last }) {
  let L;
  try { L = await loadLeaflet(); } catch (e) { clear(el).append(h('p', { class: 'map-error' }, e.message)); return; }
  if (el._map) { el._map.remove(); el._map = null; }
  clear(el);
  const map = baseMap(L, el);
  el._map = map;
  const color = cssVar('--cat-yacht');
  const ring = cssVar('--surface');
  const pts = points.filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lon)).map(p => [p.lat, p.lon]);
  if (pts.length > 1) L.polyline(pts, { color, weight: 2, opacity: 0.9, lineJoin: 'round' }).addTo(map);
  const end = last && Number.isFinite(last.lat) ? [last.lat, last.lon] : pts[pts.length - 1];
  if (end) L.circleMarker(end, { radius: 7, color: ring, weight: 2, fillColor: color, fillOpacity: 1 }).addTo(map)
    .bindTooltip('Last known position', { direction: 'top', offset: [0, -7] });
  if (pts.length > 1) map.fitBounds(pts, { padding: [24, 24], maxZoom: 11 });
  else if (end) map.setView(end, 9);
  else map.setView([40, 10], 3);
  setTimeout(() => map.invalidateSize(), 50);
}
