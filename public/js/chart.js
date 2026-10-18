// ── Zeitverlauf der Emissionsrate (SVG, ohne Bibliothek) ─────────────────────
// Darstellung wie die Zeitintegration im Backend: Eine Rate gilt ab ihrer Meldung bis
// zur nächsten, höchstens bis zur Lückengrenze (live 7 h, Historie 1 h). Längere Lücken
// werden als Unterbrechung gezeichnet, nicht als Null.

import { h, s, clear } from './dom.js';
import * as fmt from './format.js';

const HOUR = 3600000, DAY = 24 * HOUR;
const X_STEPS = [HOUR, 3 * HOUR, 6 * HOUR, 12 * HOUR, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 91 * DAY];

// Glatte Achsenteilung: 3–5 Schritte zu 1, 2, 2,5 oder 5 × 10^n
function niceScale(v) {
  if (!(v > 0)) return { max: 1, step: 0.25 };
  const raw = v / 4;
  const p = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * p).find(st => st >= raw);
  return { max: Math.ceil(v / step) * step, step };
}

function xTicks(t0, t1, width) {
  const maxTicks = Math.max(2, Math.floor(width / 90));
  const step = X_STEPS.find(st => (t1 - t0) / st <= maxTicks) || X_STEPS[X_STEPS.length - 1];
  const ticks = [];
  if (step >= 30 * DAY) {
    const d = new Date(t0); let y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
    const every = step >= 91 * DAY ? 3 : 1;
    for (;;) {
      const t = Date.UTC(y, m, 1);
      if (t > t1) break;
      if (m % every === 0) ticks.push(t);
      m += 1; if (m > 11) { m = 0; y += 1; }
    }
  } else {
    let t = Math.ceil(t0 / step) * step;
    for (; t <= t1; t += step) ticks.push(t);
  }
  const label = (t) => {
    const d = new Date(t);
    if (step >= 30 * DAY) return d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' }) + (d.getUTCMonth() === 0 ? ` ${d.getUTCFullYear()}` : '');
    if (step >= DAY) return fmt.dateShort(d);
    return fmt.time(d);
  };
  return ticks.map(t => ({ t, label: label(t) }));
}

// Segmente mit konstanter Rate: [{a, b, v, p}] ; Lücken trennen die Pfade
function segments(points, t0, t1, gapMs) {
  const segs = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i], next = points[i + 1];
    const limit = p.t + gapMs(p);
    const end = Math.min(next ? next.t : t1, limit, t1);
    const start = Math.max(p.t, t0);
    if (end > start && Number.isFinite(p.co2)) segs.push({ a: start, b: end, v: p.co2, p });
  }
  return segs;
}

export function renderRateChart(container, { points, t0, t1, gapMs, label = 'CO₂ emission rate' }) {
  clear(container);
  const root = h('div', { class: 'chart', tabindex: '0', role: 'group',
    'aria-label': `${label}. Use left and right arrow keys to read values.` });
  const tip = h('div', { class: 'chart-tip', role: 'status', 'aria-live': 'polite' });
  container.append(root);
  const segs = segments(points, t0, t1, gapMs);
  if (!segs.length) {
    root.append(h('p', { class: 'chart-empty' }, 'No reports in this period.'));
    return;
  }
  const H = 200, M = { t: 24, r: 12, b: 26, l: 44 };

  function draw() {
    const W = Math.max(260, Math.round(root.clientWidth || container.clientWidth || 360));
    clear(root);
    const iw = W - M.l - M.r, ih = H - M.t - M.b;
    const peak = Math.max(...segs.map(x => x.v));
    const unitKg = peak < 1000;
    const sc = niceScale(unitKg ? peak : peak / 1000);
    const vmax = unitKg ? sc.max : sc.max * 1000;
    const stepV = unitKg ? sc.step : sc.step * 1000;
    const x = (t) => M.l + ((t - t0) / (t1 - t0)) * iw;
    const y = (v) => M.t + ih - (v / vmax) * ih;
    const svg = s('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, class: 'chart-svg', 'aria-hidden': 'true' });

    // Raster und Achsen (Haarlinien)
    for (let v = 0; v <= vmax + stepV / 1000; v += stepV) {
      const yy = Math.round(y(v)) + 0.5;
      svg.append(s('line', { x1: M.l, x2: W - M.r, y1: yy, y2: yy, class: v === 0 ? 'axis-base' : 'grid' }));
      svg.append(s('text', { x: M.l - 8, y: yy + 4, 'text-anchor': 'end', class: 'tick' },
        unitKg ? fmt.int(v) : fmt.dec1(v / 1000)));
    }
    svg.append(s('text', { x: 0, y: 11, 'text-anchor': 'start', class: 'tick unit' }, unitKg ? 'kg/h' : 't/h'));
    for (const tk of xTicks(t0, t1, iw)) {
      const xx = Math.round(x(tk.t)) + 0.5;
      svg.append(s('line', { x1: xx, x2: xx, y1: M.t + ih, y2: M.t + ih + 4, class: 'axis-base' }));
      svg.append(s('text', { x: xx, y: H - 8, 'text-anchor': 'middle', class: 'tick' }, tk.label));
    }

    // Stufenpfade je zusammenhängendem Abschnitt
    const runs = [];
    for (const sg of segs) {
      const last = runs[runs.length - 1];
      if (last && Math.abs(last[last.length - 1].b - sg.a) < 1000) last.push(sg); else runs.push([sg]);
    }
    for (const run of runs) {
      let line = '', area = '';
      run.forEach((sg, i) => {
        const xa = x(sg.a).toFixed(1), xb = x(sg.b).toFixed(1), yv = y(sg.v).toFixed(1);
        line += `${i === 0 ? 'M' : 'L'}${xa},${yv}L${xb},${yv}`;
        area += `${i === 0 ? `M${xa},${y(0).toFixed(1)}L` : 'L'}${xa},${yv}L${xb},${yv}`;
      });
      area += `L${x(run[run.length - 1].b).toFixed(1)},${y(0).toFixed(1)}Z`;
      svg.append(s('path', { d: area, class: 'rate-area' }));
      svg.append(s('path', { d: line, class: 'rate-line' }));
    }

    // Fadenkreuz
    const cross = s('line', { y1: M.t, y2: M.t + ih, class: 'crosshair', visibility: 'hidden' });
    const dot = s('circle', { r: 4.5, class: 'rate-dot', visibility: 'hidden' });
    svg.append(cross, dot);
    root.append(svg, tip);

    let idx = -1;
    const show = (i) => {
      idx = Math.max(0, Math.min(segs.length - 1, i));
      const sg = segs[idx];
      const tx = x(Math.max(sg.a, Math.min(sg.b, sg.a + (sg.b - sg.a) / 2)));
      cross.setAttribute('x1', tx); cross.setAttribute('x2', tx); cross.setAttribute('visibility', 'visible');
      dot.setAttribute('cx', tx); dot.setAttribute('cy', y(sg.v)); dot.setAttribute('visibility', 'visible');
      clear(tip);
      tip.append(
        h('strong', {}, fmt.rate(sg.v)),
        h('span', {}, `${fmt.dateTime(sg.p.t)}`),
        h('span', {}, sg.p.speed !== null ? `Speed ${fmt.dec1(sg.p.speed)} kn` : ''),
        h('span', { class: 'muted' }, sg.p.n > 1 ? `Average of ${sg.p.n} reports` : sg.p.source === 'history' ? 'Track history' : 'Live report'),
      );
      tip.style.left = `${Math.min(Math.max(tx, 90), W - 90)}px`;
      tip.classList.add('on');
    };
    const hide = () => { cross.setAttribute('visibility', 'hidden'); dot.setAttribute('visibility', 'hidden'); tip.classList.remove('on'); };
    const nearest = (px) => {
      const t = t0 + ((px - M.l) / iw) * (t1 - t0);
      let best = 0, bd = Infinity;
      segs.forEach((sg, i) => { const dd = t < sg.a ? sg.a - t : t > sg.b ? t - sg.b : 0; if (dd < bd) { bd = dd; best = i; } });
      return best;
    };
    svg.addEventListener('pointermove', (e) => { const r = svg.getBoundingClientRect(); show(nearest(e.clientX - r.left)); });
    svg.addEventListener('pointerleave', hide);
    root.onkeydown = (e) => {
      if (e.key === 'ArrowRight') { show(idx + 1); e.preventDefault(); }
      else if (e.key === 'ArrowLeft') { show(idx < 0 ? segs.length - 1 : idx - 1); e.preventDefault(); }
      else if (e.key === 'Escape') hide();
    };
    root.onblur = hide;
  }
  draw();
  if ('ResizeObserver' in window) {
    let w = root.clientWidth;
    const ro = new ResizeObserver(() => { if (Math.abs(root.clientWidth - w) > 4) { w = root.clientWidth; draw(); } });
    ro.observe(root);
  }
}
