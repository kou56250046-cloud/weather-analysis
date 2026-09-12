// SVG のグラフ部品。外部ライブラリを使わない。
//
// 決めごと:
//   - 線は 2px、点は 8px 以上。グリッドと軸は控えめに
//   - 欠測は線でつながない。飛ばすと「そこは観測できていない」が消える
//   - 系列が2本以上なら必ず凡例を出す。4本までは直接ラベルも付ける
//   - 目盛りは「きりの良い数」に丸める。0.37 刻みの軸を作らない
import { el } from './dom.js';
import { bindTip, bindTipArea } from './tip.js';

// 上端の余白は、単位ラベルを一番上の目盛りの上に置ける高さにしてある
export const PAD = { top: 22, right: 16, bottom: 26, left: 40 };

/** きりの良い目盛り間隔を選ぶ */
export function niceStep(range, targetTicks = 5) {
  if (!(range > 0)) return 1;
  const rough = range / targetTicks;
  const mag = 10 ** Math.floor(Math.log10(rough));
  const norm = rough / mag;
  const step = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10;
  return step * mag;
}

/** 値域から、きりの良い下限・上限・目盛り列を作る */
export function niceScale(min, max, targetTicks = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1, ticks: [0, 1] };
  if (min === max) { min -= 1; max += 1; }
  const step = niceStep(max - min, targetTicks);
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks = [];
  // 浮動小数の誤差で最後の目盛りが落ちないよう、わずかに余裕を持たせる
  for (let v = lo; v <= hi + step * 1e-9; v += step) ticks.push(round(v, 6));
  return { min: lo, max: hi, ticks };
}

function round(n, d) { const f = 10 ** d; return Math.round(n * f) / f; }

/**
 * 描画領域を用意する。
 * @returns {{svg, plot, x, y, w, h, innerW, innerH}}
 */
export function frame({ width = 720, height = 260, pad = PAD, xDomain, yDomain, label = '' }) {
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;

  const svg = el('svg', {
    viewBox: `0 0 ${width} ${height}`,
    role: 'img',
    'aria-label': label,
    preserveAspectRatio: 'xMidYMid meet',
  });
  const plot = el('g', { transform: `translate(${pad.left},${pad.top})` });
  svg.appendChild(plot);

  const [x0, x1] = xDomain;
  const [y0, y1] = yDomain;
  const x = (v) => (x1 === x0 ? innerW / 2 : ((v - x0) / (x1 - x0)) * innerW);
  const y = (v) => (y1 === y0 ? innerH / 2 : innerH - ((v - y0) / (y1 - y0)) * innerH);

  return { svg, plot, x, y, width, height, innerW, innerH, pad };
}

/** 横方向のグリッドと y 軸ラベル */
export function yAxis(f, ticks, { format = (v) => String(v), unit = '' } = {}) {
  const g = el('g');
  for (const t of ticks) {
    const yy = f.y(t);
    g.appendChild(el('line', {
      x1: 0, x2: f.innerW, y1: yy, y2: yy,
      stroke: 'var(--grid)', 'stroke-width': 1,
    }));
    g.appendChild(el('text', {
      x: -8, y: yy + 3.5, 'text-anchor': 'end',
      fill: 'var(--text-muted)', 'font-size': 10.5,
    }, format(t)));
  }
  if (unit) {
    // 一番上の目盛りは plot の上端に来る。単位はその上に逃がす
    g.appendChild(el('text', {
      x: -8, y: -9, 'text-anchor': 'end',
      fill: 'var(--text-muted)', 'font-size': 10,
    }, unit));
  }
  f.plot.appendChild(g);
  return g;
}

/** x 軸のラベル。間引いて重なりを避ける */
export function xAxisLabels(f, items, { every = 1, format = (d) => d } = {}) {
  const g = el('g');
  items.forEach((item, i) => {
    if (i % every !== 0) return;
    g.appendChild(el('text', {
      x: f.x(i), y: f.innerH + 16, 'text-anchor': 'middle',
      fill: 'var(--text-muted)', 'font-size': 10.5,
    }, format(item, i)));
  });
  g.appendChild(el('line', {
    x1: 0, x2: f.innerW, y1: f.innerH, y2: f.innerH,
    stroke: 'var(--axis)', 'stroke-width': 1,
  }));
  f.plot.appendChild(g);
  return g;
}

/**
 * 折れ線。null を含む区間で線を切る。
 * @param {Array<{x:number, y:number|null}>} points
 */
export function line(f, points, { stroke = 'var(--series-1)', width = 2, dash = null, opacity = 1 } = {}) {
  const segments = [];
  let current = [];
  for (const p of points) {
    if (p.y === null || p.y === undefined || !Number.isFinite(p.y)) {
      if (current.length) segments.push(current);
      current = [];
      continue;
    }
    current.push(`${f.x(p.x).toFixed(2)},${f.y(p.y).toFixed(2)}`);
  }
  if (current.length) segments.push(current);

  const g = el('g');
  for (const seg of segments) {
    if (seg.length === 1) {
      // 1点だけ残った区間は線にならないので点で示す
      const [cx, cy] = seg[0].split(',');
      g.appendChild(el('circle', { cx, cy, r: 2.2, fill: stroke, opacity }));
      continue;
    }
    g.appendChild(el('polyline', {
      points: seg.join(' '),
      fill: 'none',
      stroke,
      'stroke-width': width,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'stroke-dasharray': dash,
      opacity,
    }));
  }
  f.plot.appendChild(g);
  return g;
}

/** 上下の帯（予測区間・平年の幅） */
export function band(f, points, { fill = 'var(--series-1)', opacity = 0.16 } = {}) {
  const valid = points.filter((p) => p.low !== null && p.high !== null
    && Number.isFinite(p.low) && Number.isFinite(p.high));
  if (valid.length < 2) return null;
  const top = valid.map((p) => `${f.x(p.x).toFixed(2)},${f.y(p.high).toFixed(2)}`);
  const bottom = valid.slice().reverse().map((p) => `${f.x(p.x).toFixed(2)},${f.y(p.low).toFixed(2)}`);
  const g = el('polygon', {
    points: [...top, ...bottom].join(' '),
    fill,
    opacity,
    stroke: 'none',
  });
  f.plot.appendChild(g);
  return g;
}

/**
 * 棒。データ端を 4px 丸め、棒の間に 2px の隙間を空ける。
 * @param {Array<{x:number, value:number|null, color?:string, tip?:object}>} items
 */
export function bars(f, items, { color = 'var(--series-1)', baseline = 0, gap = 2 } = {}) {
  const g = el('g');
  const slot = f.innerW / Math.max(1, items.length);
  const w = Math.max(1, slot - gap);
  const yBase = f.y(baseline);

  items.forEach((item, i) => {
    if (item.value === null || item.value === undefined || !Number.isFinite(item.value)) return;
    const yv = f.y(item.value);
    const top = Math.min(yv, yBase);
    const h = Math.abs(yv - yBase);
    const cx = slot * i + slot / 2;
    const rect = el('rect', {
      x: cx - w / 2, y: top, width: w, height: Math.max(0.8, h),
      rx: Math.min(4, w / 2),
      fill: item.color ?? color,
    });
    g.appendChild(rect);
    if (item.tip) {
      // 当たり判定は棒より広く取る。細い棒でも触れる
      const hit = el('rect', {
        x: slot * i, y: 0, width: slot, height: f.innerH,
        fill: 'transparent',
      });
      bindTip(hit, () => item.tip);
      g.appendChild(hit);
    }
  });
  f.plot.appendChild(g);
  return g;
}

/** 点。重なる図では 2px の下地リングを付けて分離する */
export function dots(f, items, { color = 'var(--series-1)', r = 4, ring = true } = {}) {
  const g = el('g');
  for (const item of items) {
    if (item.y === null || item.y === undefined || !Number.isFinite(item.y)) continue;
    const cx = f.x(item.x);
    const cy = f.y(item.y);
    if (ring) {
      g.appendChild(el('circle', { cx, cy, r: r + 2, fill: 'var(--surface-1)' }));
    }
    const dot = el('circle', { cx, cy, r, fill: item.color ?? color });
    g.appendChild(dot);
    if (item.tip) {
      const hit = el('circle', { cx, cy, r: Math.max(11, r + 7), fill: 'transparent' });
      bindTip(hit, () => item.tip);
      g.appendChild(hit);
    }
  }
  f.plot.appendChild(g);
  return g;
}

/**
 * 直接ラベル。系列の右端に名前を置く。
 *
 * 値が近い系列どうしはラベルが重なって読めなくなるので、
 * 既に置いたラベルの位置を覚えておき、近すぎるときは上下にずらす。
 * ずらした分は細い引き出し線で元の位置とつなぐ。
 */
export function directLabel(f, x, y, text, { color = 'var(--text-primary)', dx = 6, minGap = 13 } = {}) {
  f._labelYs ??= [];
  const anchorY = f.y(y);
  let ly = anchorY;
  // 空いている位置が見つかるまで、上下交互に探す
  for (let step = 0; step < 40; step++) {
    const candidate = anchorY + (step % 2 === 0 ? 1 : -1) * Math.ceil(step / 2) * minGap;
    if (f._labelYs.every((prev) => Math.abs(prev - candidate) >= minGap)) { ly = candidate; break; }
  }
  f._labelYs.push(ly);

  const g = el('g');
  if (Math.abs(ly - anchorY) > 2) {
    g.appendChild(el('line', {
      x1: f.x(x) + 2, y1: anchorY, x2: f.x(x) + dx - 1, y2: ly,
      stroke: color, 'stroke-width': 1, opacity: 0.6,
    }));
  }
  g.appendChild(el('text', {
    x: f.x(x) + dx, y: ly + 3.5,
    'text-anchor': 'start',
    fill: color,
    'font-size': 11,
    'font-weight': 600,
  }, text));
  f.plot.appendChild(g);
  return g;
}

/** 基準線（0 や平年） */
export function refLine(f, value, { label = '', dash = '4 3', color = 'var(--axis)' } = {}) {
  const yy = f.y(value);
  f.plot.appendChild(el('line', {
    x1: 0, x2: f.innerW, y1: yy, y2: yy,
    stroke: color, 'stroke-width': 1.5, 'stroke-dasharray': dash,
  }));
  if (label) {
    f.plot.appendChild(el('text', {
      x: f.innerW - 2, y: yy - 4, 'text-anchor': 'end',
      fill: 'var(--text-muted)', 'font-size': 10,
    }, label));
  }
}

/**
 * ヒートマップ。行 × 列の格子。逐次配色は1色の濃淡だけ。
 * @param {{rows:string[], cols:string[], values:(number|null)[][]}} data
 */
export function heatmap(container, data, {
  cellH = 26, labelW = 128, min = null, max = null,
  format = (v) => v.toFixed(2), tipFor = null, lowIsGood = true,
} = {}) {
  const flat = data.values.flat().filter((v) => v !== null && Number.isFinite(v));
  if (flat.length === 0) return el('p', { class: 'empty' }, 'データがまだ足りない');
  const lo = min ?? Math.min(...flat);
  const hi = max ?? Math.max(...flat);

  const cellW = 46;
  const width = labelW + cellW * data.cols.length + 8;
  const height = 22 + cellH * data.rows.length + 6;

  const svg = el('svg', {
    viewBox: `0 0 ${width} ${height}`,
    width,
    height,
    role: 'img',
    'aria-label': '誤差のヒートマップ',
  });

  data.cols.forEach((c, j) => {
    svg.appendChild(el('text', {
      x: labelW + cellW * j + cellW / 2, y: 14, 'text-anchor': 'middle',
      fill: 'var(--text-muted)', 'font-size': 10.5,
    }, c));
  });

  data.rows.forEach((rname, i) => {
    const y = 22 + cellH * i;
    svg.appendChild(el('text', {
      x: labelW - 8, y: y + cellH / 2 + 3.5, 'text-anchor': 'end',
      fill: 'var(--text-secondary)', 'font-size': 11,
    }, rname));

    data.cols.forEach((cname, j) => {
      const v = data.values[i][j];
      const x = labelW + cellW * j;
      if (v === null || v === undefined || !Number.isFinite(v)) {
        svg.appendChild(el('rect', {
          x: x + 1, y: y + 1, width: cellW - 2, height: cellH - 2, rx: 3,
          fill: 'none', stroke: 'var(--grid)', 'stroke-width': 1,
        }));
        return;
      }
      // 誤差は小さいほど良いので、良い方を薄くする
      const t = hi === lo ? 0.5 : (v - lo) / (hi - lo);
      const shade = lowIsGood ? t : 1 - t;
      const cell = el('rect', {
        x: x + 1, y: y + 1, width: cellW - 2, height: cellH - 2, rx: 3,
        fill: rampColor(shade),
      });
      svg.appendChild(cell);
      svg.appendChild(el('text', {
        x: x + cellW / 2, y: y + cellH / 2 + 3.5, 'text-anchor': 'middle',
        fill: shade > 0.62 ? '#fff' : 'var(--text-primary)',
        'font-size': 10.5,
      }, format(v)));
      if (tipFor) bindTip(cell, () => tipFor(i, j, v));
    });
  });

  container.appendChild(svg);
  return svg;
}

/** 逐次配色。1色の濃淡だけ。虹色にしない */
export function rampColor(t) {
  const steps = ['--seq-100', '--seq-250', '--seq-400', '--seq-550', '--seq-700'];
  const clamped = Math.max(0, Math.min(1, t));
  const idx = Math.min(steps.length - 1, Math.floor(clamped * steps.length));
  return `var(${steps[idx]})`;
}

/** 発散配色。平年差など、符号に意味がある量に使う */
export function divergingColor(value, scale) {
  if (value === null || !Number.isFinite(value)) return 'var(--div-mid)';
  const t = Math.max(-1, Math.min(1, value / scale));
  if (Math.abs(t) < 0.08) return 'var(--div-mid)';
  const hue = t > 0 ? 'var(--div-warm)' : 'var(--div-cool)';
  const pct = Math.round(28 + Math.abs(t) * 72);
  return `color-mix(in srgb, ${hue} ${pct}%, var(--div-mid))`;
}

/** 十字カーソル。折れ線図に付ける */
export function crosshair(f, items, buildTip) {
  const cursor = el('line', {
    y1: 0, y2: f.innerH, stroke: 'var(--axis)', 'stroke-width': 1,
    'stroke-dasharray': '3 3', opacity: 0,
  });
  f.plot.appendChild(cursor);

  bindTipArea(f.svg, (px) => {
    const localX = px - f.pad.left;
    if (localX < -6 || localX > f.innerW + 6) { cursor.setAttribute('opacity', 0); return null; }
    // 最も近い点を探す
    let best = null;
    let bestD = Infinity;
    items.forEach((item, i) => {
      const d = Math.abs(f.x(i) - localX);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best === null) { cursor.setAttribute('opacity', 0); return null; }
    const cx = f.x(best);
    cursor.setAttribute('x1', cx);
    cursor.setAttribute('x2', cx);
    cursor.setAttribute('opacity', 1);
    return buildTip(best);
  });
  f.svg.addEventListener('mouseleave', () => cursor.setAttribute('opacity', 0));
  return cursor;
}

/** 凡例。系列が2本以上なら必ず出す */
export function legend(entries) {
  return el('div', { class: 'legend' }, entries.map((e) => el(
    'span',
    { class: 'item', style: e.dash ? { color: e.color } : null },
    el('i', { class: `swatch${e.band ? ' band' : ''}${e.dash ? ' dash' : ''}`, style: { background: e.color } }),
    e.label,
  )));
}
