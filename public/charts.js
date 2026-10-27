// Small SVG line charts and sparklines with a touch-friendly crosshair. No dependencies.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ESC[c]);
const finite = (p) => Number.isFinite(p[0]) && Number.isFinite(p[1]);

export const SERIES_SLOTS = 8;
export const seriesColor = (i) => `var(--series-${(i % SERIES_SLOTS) + 1})`;

export function formatValue(v) {
  if (typeof v !== 'number') return String(v ?? '');
  if (!Number.isFinite(v)) return String(v);
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e6 || a < 1e-3) return v.toExponential(3).replace('e+', 'e');
  if (Number.isInteger(v)) return v.toLocaleString('en-US');
  if (a >= 1000) return v.toLocaleString('en-US', { maximumFractionDigits: 1 });
  return String(Number(v.toPrecision(5)));
}

export function formatAxis(v) {
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e9) return `${trim(v / 1e9)}B`;
  if (a >= 1e6) return `${trim(v / 1e6)}M`;
  if (a >= 1e4) return `${trim(v / 1e3)}k`;
  if (a < 1e-3) return v.toExponential(1).replace('e+', 'e');
  return trim(v);
}

function trim(v) {
  return String(Number(v.toPrecision(3)));
}

export function formatSeconds(sec) {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return s % 60 ? `${m}m ${s % 60}s` : `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`;
}

function niceStep(range, count) {
  const raw = range / Math.max(1, count);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const nice = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10;
  return nice * mag;
}

function ticks(min, max, count) {
  if (!(max > min)) return [min];
  const step = niceStep(max - min, count);
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
    out.push(Number(v.toPrecision(12)));
  }
  return out;
}

// Debiased exponential moving average, close to the default smoothing in the W&B UI.
function ema(points, weight) {
  let value = 0;
  let norm = 0;
  return points.map(([x, y]) => {
    value = weight * value + (1 - weight) * y;
    norm = weight * norm + (1 - weight);
    return [x, value / norm];
  });
}

function nearestIndex(points, x) {
  let lo = 0;
  let hi = points.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] < x) lo = mid;
    else hi = mid;
  }
  return Math.abs(points[lo][0] - x) <= Math.abs(points[hi][0] - x) ? lo : hi;
}

/**
 * Draws a line chart into `el` and keeps it sized to its container.
 * series: [{ name, points: [[x, y], ...], color? }]
 */
export function lineChart(el, opts) {
  const {
    height = 168,
    xFormat = formatAxis,
    yFormat = formatAxis,
    valueFormat = formatValue,
    xLabel = 'Step',
    smoothing = 0,
    label = 'Line chart',
  } = opts;

  const series = opts.series
    .map((s, i) => {
      const raw = s.points.filter(finite).sort((a, b) => a[0] - b[0]);
      return { name: s.name, color: s.color || seriesColor(i), raw, pts: smoothing > 0 ? ema(raw, smoothing) : raw };
    })
    .filter((s) => s.pts.length);

  el.classList.add('chart');
  if (!series.length) {
    el.innerHTML = '<p class="chart-empty">No numeric values logged for this chart yet.</p>';
    return { destroy() {} };
  }

  let lastWidth = 0;
  let hideTimer = 0;

  const draw = () => {
    const width = Math.max(220, Math.round(el.clientWidth || 320));
    lastWidth = width;

    let xMin = Infinity;
    let xMax = -Infinity;
    let yMin = Infinity;
    let yMax = -Infinity;
    for (const s of series) {
      for (const [x, y] of s.raw) {
        if (x < xMin) xMin = x;
        if (x > xMax) xMax = x;
        if (y < yMin) yMin = y;
        if (y > yMax) yMax = y;
      }
    }
    const dataMin = yMin;
    if (xMin === xMax) {
      xMin -= 1;
      xMax += 1;
    }
    if (yMin === yMax) {
      const d = Math.abs(yMin) * 0.1 || 1;
      yMin -= d;
      yMax += d;
    }
    const pad = (yMax - yMin) * 0.06;
    yMin -= pad;
    yMax += pad;
    if (dataMin >= 0 && yMin < 0) yMin = 0;

    const yTicks = ticks(yMin, yMax, 4);
    const yLabels = yTicks.map(yFormat);
    const direct = series.length >= 2 && series.length <= 4;
    const m = {
      l: Math.round(Math.max(...yLabels.map((t) => t.length)) * 6.6 + 12),
      r: direct ? 58 : 12,
      t: 8,
      b: 24,
    };
    const iw = width - m.l - m.r;
    const ih = height - m.t - m.b;
    const sx = (x) => m.l + ((x - xMin) / (xMax - xMin)) * iw;
    const sy = (y) => m.t + (1 - (y - yMin) / (yMax - yMin)) * ih;
    const path = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p[0]).toFixed(1)} ${sy(p[1]).toFixed(1)}`).join('');
    const xTicks = ticks(xMin, xMax, Math.max(2, Math.floor(iw / 84)));

    let svg = `<svg class="chart-svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${esc(label)}">`;
    yTicks.forEach((v, i) => {
      const y = sy(v).toFixed(1);
      svg += `<line class="grid" x1="${m.l}" x2="${width - m.r}" y1="${y}" y2="${y}"/>`;
      svg += `<text class="tick" x="${m.l - 6}" y="${y}" dy="0.32em" text-anchor="end">${esc(yLabels[i])}</text>`;
    });
    svg += `<line class="axis" x1="${m.l}" x2="${width - m.r}" y1="${m.t + ih}" y2="${m.t + ih}"/>`;
    for (const v of xTicks) {
      const x = Math.min(width - m.r - 12, Math.max(m.l + 12, sx(v)));
      svg += `<text class="tick" x="${x.toFixed(1)}" y="${height - 6}" text-anchor="middle">${esc(xFormat(v))}</text>`;
    }
    for (const s of series) {
      if (smoothing > 0 && s.raw.length > 1) svg += `<path class="line raw" d="${path(s.raw)}" stroke="${s.color}"/>`;
      if (s.pts.length === 1) {
        svg += `<circle class="dot" cx="${sx(s.pts[0][0])}" cy="${sy(s.pts[0][1])}" r="4" fill="${s.color}"/>`;
      } else {
        svg += `<path class="line" d="${path(s.pts)}" stroke="${s.color}"/>`;
      }
    }
    if (direct) {
      // End-of-line labels, nudged apart so they never overlap.
      const labels = series
        .map((s) => ({ s, y: sy(s.pts[s.pts.length - 1][1]) }))
        .sort((a, b) => a.y - b.y);
      for (let i = 1; i < labels.length; i++) {
        if (labels[i].y - labels[i - 1].y < 13) labels[i].y = labels[i - 1].y + 13;
      }
      const overflow = labels.length ? labels[labels.length - 1].y - (m.t + ih) : 0;
      if (overflow > 0) labels.forEach((l) => { l.y -= overflow; });
      for (const l of labels) {
        const x = width - m.r + 6;
        svg += `<line class="dlabel-key" x1="${x}" x2="${x + 8}" y1="${l.y.toFixed(1)}" y2="${l.y.toFixed(1)}" stroke="${l.s.color}"/>`;
        svg += `<text class="dlabel" x="${x + 12}" y="${l.y.toFixed(1)}" dy="0.32em">${esc(l.s.name)}</text>`;
      }
    }
    svg += `<line class="xhair" x1="0" x2="0" y1="${m.t}" y2="${m.t + ih}" visibility="hidden"/>`;
    svg += '<g class="hover-dots"></g>';
    svg += `<rect class="hit" x="${m.l}" y="0" width="${Math.max(0, iw)}" height="${height}"/>`;
    svg += '</svg>';

    const legend = series.length >= 2
      ? `<div class="chart-legend">${series.map((s) => `<span><i class="swatch" style="background:${s.color}"></i>${esc(s.name)}</span>`).join('')}</div>`
      : '';
    el.innerHTML = `${legend}<div class="chart-plot">${svg}<div class="chart-tip" hidden></div></div>`;

    const svgEl = el.querySelector('svg');
    const xhair = svgEl.querySelector('.xhair');
    const dots = svgEl.querySelector('.hover-dots');
    const tip = el.querySelector('.chart-tip');

    const hide = () => {
      xhair.setAttribute('visibility', 'hidden');
      dots.innerHTML = '';
      tip.hidden = true;
    };

    const show = (ev) => {
      const rect = svgEl.getBoundingClientRect();
      const px = Math.min(m.l + iw, Math.max(m.l, ev.clientX - rect.left));
      const xv = xMin + ((px - m.l) / iw) * (xMax - xMin);
      let snap = null;
      for (const s of series) {
        const p = s.pts[nearestIndex(s.pts, xv)];
        if (snap === null || Math.abs(p[0] - xv) < Math.abs(snap - xv)) snap = p[0];
      }
      const rows = series.map((s) => {
        const i = nearestIndex(s.pts, snap);
        return { s, p: s.pts[i], raw: s.raw[i] };
      });
      const x = sx(snap);
      xhair.setAttribute('x1', x);
      xhair.setAttribute('x2', x);
      xhair.setAttribute('visibility', 'visible');
      dots.innerHTML = rows
        .filter((r) => r.p[0] === snap)
        .map((r) => `<circle class="hover-dot" cx="${x}" cy="${sy(r.p[1])}" r="4" fill="${r.s.color}"/>`)
        .join('');
      tip.innerHTML = `<div class="tip-x">${esc(xLabel)} ${esc(xFormat(snap))}</div>${rows.map((r) => `
        <div class="tip-row"><i class="swatch" style="background:${r.s.color}"></i><span class="tip-name">${esc(r.s.name)}</span>
        <b>${esc(valueFormat(r.p[1]))}</b>${smoothing > 0 ? `<span class="tip-raw">raw ${esc(valueFormat(r.raw[1]))}</span>` : ''}</div>`).join('')}`;
      tip.hidden = false;
      const tw = tip.offsetWidth;
      tip.style.left = `${x + 12 + tw > width ? Math.max(0, x - tw - 12) : x + 12}px`;
      tip.style.top = `${m.t}px`;
      clearTimeout(hideTimer);
      if (ev.pointerType && ev.pointerType !== 'mouse') hideTimer = setTimeout(hide, 2600);
    };

    svgEl.addEventListener('pointermove', show);
    svgEl.addEventListener('pointerdown', show);
    svgEl.addEventListener('pointerleave', (ev) => {
      if (ev.pointerType === 'mouse') hide();
    });
  };

  draw();
  const ro = new ResizeObserver(() => {
    if (Math.abs((el.clientWidth || 0) - lastWidth) > 4) draw();
  });
  ro.observe(el);
  return {
    destroy() {
      ro.disconnect();
      clearTimeout(hideTimer);
    },
  };
}

/** Returns an inline SVG sparkline string, or '' when there is too little data. */
export function sparkline(points, { width = 92, height = 30, color = '' } = {}) {
  const pts = points.filter(finite).sort((a, b) => a[0] - b[0]);
  if (pts.length < 2) return '';
  let xMin = pts[0][0];
  let xMax = pts[pts.length - 1][0];
  let yMin = Infinity;
  let yMax = -Infinity;
  for (const [, y] of pts) {
    if (y < yMin) yMin = y;
    if (y > yMax) yMax = y;
  }
  if (xMax === xMin) xMax = xMin + 1;
  if (yMax === yMin) {
    yMax += 1;
    yMin -= 1;
  }
  const p = 5;
  const sx = (x) => p + ((x - xMin) / (xMax - xMin)) * (width - p * 2);
  const sy = (y) => p + (1 - (y - yMin) / (yMax - yMin)) * (height - p * 2);
  const d = pts.map((pt, i) => `${i ? 'L' : 'M'}${sx(pt[0]).toFixed(1)} ${sy(pt[1]).toFixed(1)}`).join('');
  const last = pts[pts.length - 1];
  const stroke = color ? ` style="stroke:${color}"` : '';
  const fill = color ? ` style="fill:${color}"` : '';
  return `<svg class="spark" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" aria-hidden="true">
    <path class="spark-line" d="${d}"${stroke}/><circle class="spark-end" cx="${sx(last[0]).toFixed(1)}" cy="${sy(last[1]).toFixed(1)}" r="4"${fill}/></svg>`;
}
