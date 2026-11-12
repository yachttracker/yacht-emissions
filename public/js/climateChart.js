// ── Nachwirkung: Strahlungsantrieb der im Zeitraum emittierten Mengen, 0–100 Jahre ──
// SVG ohne Bibliothek. Linien je Stoff und Summe; kühlende Anteile unter der Nulllinie.
import { h, s, clear } from './dom.js';
import { afterEffect } from './climate.js';

const SERIES = [
  { key: 'total', label: 'Total', cls: 'cc-total' },
  { key: 'co2', label: 'CO₂', cls: 'cc-co2' },
  { key: 'nox', label: 'NOₓ (ozone, methane)', cls: 'cc-nox' },
  { key: 'so2', label: 'SO₂ (sulphate)', cls: 'cc-so2' },
  { key: 'n2o', label: 'N₂O', cls: 'cc-n2o' },
];
// Dichte Stützstellen am Anfang, damit kurzlebige Anteile sichtbar sind
const TS = [0, 0.02, 0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 1, 1.5, 2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100];

function niceStep(span) {
  const raw = span / 4, p = 10 ** Math.floor(Math.log10(raw || 1));
  return [1, 2, 2.5, 5, 10].map(m => m * p).find(st => st >= raw);
}
const nW = (w) => w * 1e9;
const fmtN = (v) => (Math.abs(v) < 0.05 ? '0' : new Intl.NumberFormat('en-GB', { maximumFractionDigits: Math.abs(v) >= 10 ? 0 : 1 }).format(v));

export function renderAfterEffect(el, { row, years, params }) {
  clear(el);
  const data = TS.map(t => ({ t, v: afterEffect(row, years, t, params) }));
  const all = data.flatMap(d => SERIES.map(sr => nW(d.v[sr.key])));
  let lo = Math.min(0, ...all), hi = Math.max(0, ...all);
  if (hi - lo < 1e-6) { hi = 1; lo = -1; }
  const step = niceStep(hi - lo);
  lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
  const W = 360, H = 214, L = 40, R = 8, T = 8, B = 38;
  // Wurzel-Skala: kurzlebige Anteile (Tage bis Jahre) bleiben sichtbar, 100 Jahre passen trotzdem hinein
  const x = (t) => L + Math.sqrt(t / 100) * (W - L - R);
  const y = (v) => T + (hi - v) / (hi - lo) * (H - T - B);
  const grid = [];
  for (let v = lo; v <= hi + step / 2; v += step) {
    grid.push(s('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), class: Math.abs(v) < step / 2 ? 'cc-zero' : 'cc-grid' }),
      s('text', { x: L - 4, y: y(v) + 3.5, 'text-anchor': 'end', class: 'cc-tick' }, fmtN(v)));
  }
  for (const t of [0, 1, 5, 10, 25, 50, 100]) {
    grid.push(s('text', { x: x(t), y: H - 22, 'text-anchor': 'middle', class: 'cc-tick' }, String(t)));
  }
  const lines = SERIES.slice().reverse().map(sr => s('polyline', {
    class: `cc-line ${sr.cls}`, fill: 'none',
    points: data.map(d => `${x(d.t).toFixed(1)},${y(nW(d.v[sr.key])).toFixed(1)}`).join(' ') }));
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', role: 'img',
    'aria-label': 'Radiative forcing of the emissions in this period over the next 100 years, by substance' },
  grid, lines,
  s('text', { x: L, y: H - 4, class: 'cc-tick' }, 'years after the period (square-root scale) →'));
  const start = data[0].v, end = data[data.length - 1].v;
  el.append(svg,
    h('ul', { class: 'cc-legend' }, SERIES.map(sr => h('li', {},
      h('span', { class: `cc-swatch ${sr.cls}` }), `${sr.label}: ${fmtN(nW(start[sr.key]))} → ${fmtN(nW(end[sr.key]))}`))),
    h('p', { class: 'fine' }, 'Values in nW m⁻²: at the end of the period → after 100 years. ',
      'Sulphate fades within days, the NOₓ effects within about a decade; about a fifth of the CO₂ stays for centuries.'));
}
