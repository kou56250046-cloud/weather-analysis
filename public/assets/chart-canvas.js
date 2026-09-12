// 点数が多い図は Canvas で描く。
// 1940年からの日別値は3万点を超える。SVG で1点1要素にするとブラウザが詰まる。
// 目安として 1000 点を超えたらこちらを使う。
import { el, cssVar } from './dom.js';
import { showTip, hideTip, moveTip } from './tip.js';
import { niceScale } from './chart-svg.js';

/** 高解像度画面でぼやけないように実ピクセルで持つ */
function prepare(canvas, width, height) {
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  return ctx;
}

const PAD = { top: 12, right: 14, bottom: 24, left: 44 };

/**
 * 日別の長期系列。点が多いので線だけ引く。
 *
 * @param {HTMLElement} container
 * @param {{dates:string[], series:Array<{values:(number|null)[], color:string, label:string, width?:number}>}} data
 */
export function longSeries(container, data, {
  height = 260, yLabel = '', format = (v) => v.toFixed(1), refValue = null,
} = {}) {
  const width = Math.max(320, container.clientWidth || 720);
  const canvas = el('canvas', { role: 'img', 'aria-label': yLabel || '長期の推移' });
  container.appendChild(canvas);
  const ctx = prepare(canvas, width, height);

  const innerW = width - PAD.left - PAD.right;
  const innerH = height - PAD.top - PAD.bottom;

  const all = data.series.flatMap((s) => s.values).filter((v) => v !== null && Number.isFinite(v));
  if (all.length === 0) {
    container.replaceChildren(el('p', { class: 'empty' }, 'データがまだ足りない'));
    return null;
  }
  const scale = niceScale(Math.min(...all), Math.max(...all), 5);
  const n = data.dates.length;

  const px = (i) => PAD.left + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const py = (v) => PAD.top + innerH - ((v - scale.min) / (scale.max - scale.min)) * innerH;

  // 目盛り
  ctx.strokeStyle = cssVar('--grid', '#e1e0d9');
  ctx.fillStyle = cssVar('--text-muted', '#898781');
  ctx.font = '10.5px system-ui, sans-serif';
  ctx.lineWidth = 1;
  ctx.textAlign = 'right';
  for (const t of scale.ticks) {
    const y = Math.round(py(t)) + 0.5;
    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(PAD.left + innerW, y);
    ctx.stroke();
    ctx.fillText(format(t), PAD.left - 7, y + 3.5);
  }

  // 年のラベル。5年または10年ごとに間引く
  const years = [];
  data.dates.forEach((d, i) => {
    const y = d.slice(0, 4);
    if (years.length === 0 || years.at(-1).year !== y) years.push({ year: y, i });
  });
  const everyYears = years.length > 40 ? 10 : years.length > 16 ? 5 : 1;
  ctx.textAlign = 'center';
  years.forEach((y, k) => {
    if (k % everyYears !== 0) return;
    ctx.fillText(y.year, px(y.i), PAD.top + innerH + 15);
  });
  ctx.strokeStyle = cssVar('--axis', '#c3c2b7');
  ctx.beginPath();
  ctx.moveTo(PAD.left, Math.round(PAD.top + innerH) + 0.5);
  ctx.lineTo(PAD.left + innerW, Math.round(PAD.top + innerH) + 0.5);
  ctx.stroke();

  if (refValue !== null && Number.isFinite(refValue)) {
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = cssVar('--axis', '#c3c2b7');
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(PAD.left, py(refValue));
    ctx.lineTo(PAD.left + innerW, py(refValue));
    ctx.stroke();
    ctx.restore();
  }

  // 系列。欠測はつながない
  for (const s of data.series) {
    ctx.strokeStyle = cssVar(s.color, '#2a78d6');
    ctx.lineWidth = s.width ?? 1.2;
    ctx.globalAlpha = s.opacity ?? 1;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    let drawing = false;
    s.values.forEach((v, i) => {
      if (v === null || !Number.isFinite(v)) { drawing = false; return; }
      if (!drawing) { ctx.moveTo(px(i), py(v)); drawing = true; }
      else ctx.lineTo(px(i), py(v));
    });
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ツールチップ
  const handle = (ev) => {
    const p = ev.touches?.[0] ?? ev;
    const rect = canvas.getBoundingClientRect();
    const lx = p.clientX - rect.left;
    if (lx < PAD.left - 4 || lx > PAD.left + innerW + 4) { hideTip(); return; }
    const i = Math.round(((lx - PAD.left) / innerW) * (n - 1));
    if (i < 0 || i >= n) { hideTip(); return; }
    showTip({
      title: data.dates[i],
      rows: data.series
        .filter((s) => s.values[i] !== null && Number.isFinite(s.values[i]))
        .map((s) => ({ k: s.label, v: format(s.values[i]), color: cssVar(s.color) })),
    }, p.clientX, p.clientY);
  };
  canvas.addEventListener('mousemove', handle);
  canvas.addEventListener('mouseleave', hideTip);
  canvas.addEventListener('touchstart', handle, { passive: true });
  canvas.addEventListener('touchmove', handle, { passive: true });
  canvas.addEventListener('touchend', hideTip);

  return canvas;
}

/**
 * 年 × 日 のカレンダー状の濃淡。
 * 「いつ暑い日が多いか」を一目で見るのに使う。行が年、列が通日。
 */
export function calendarHeat(container, { years, byYear }, {
  cellH = 9, height = null, colorFor, format = (v) => v.toFixed(1), label = '',
} = {}) {
  const labelW = 38;
  const width = Math.max(320, container.clientWidth || 720);
  const innerW = width - labelW - 8;
  const h = height ?? (years.length * cellH + 18);

  const canvas = el('canvas', { role: 'img', 'aria-label': label });
  container.appendChild(canvas);
  const ctx = prepare(canvas, width, h);
  const cellW = innerW / 366;

  ctx.fillStyle = cssVar('--text-muted', '#898781');
  ctx.font = '9.5px system-ui, sans-serif';
  ctx.textAlign = 'right';

  years.forEach((year, row) => {
    const y = 14 + row * cellH;
    if (years.length <= 40 || row % 5 === 0) ctx.fillText(String(year), labelW - 6, y + cellH - 1);
    const days = byYear.get(year) ?? [];
    days.forEach((v, doy) => {
      if (v === null || !Number.isFinite(v)) return;
      ctx.fillStyle = colorFor(v);
      ctx.fillRect(labelW + doy * cellW, y, Math.max(1, cellW - 0.3), cellH - 1);
    });
    ctx.fillStyle = cssVar('--text-muted', '#898781');
  });

  // 月の目盛り
  const monthStarts = [1, 32, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
  ctx.textAlign = 'center';
  monthStarts.forEach((d, m) => {
    ctx.fillText(`${m + 1}月`, labelW + (d - 1) * cellW + cellW * 15, 10);
  });

  const handle = (ev) => {
    const p = ev.touches?.[0] ?? ev;
    const rect = canvas.getBoundingClientRect();
    const lx = p.clientX - rect.left - labelW;
    const ly = p.clientY - rect.top - 14;
    const row = Math.floor(ly / cellH);
    const doy = Math.floor(lx / cellW);
    if (row < 0 || row >= years.length || doy < 0 || doy > 365) { hideTip(); return; }
    const v = (byYear.get(years[row]) ?? [])[doy];
    if (v === null || v === undefined) { hideTip(); return; }
    showTip({
      title: `${years[row]}年 ${doyToLabel(doy)}`,
      rows: [{ k: label || '値', v: format(v) }],
    }, p.clientX, p.clientY);
  };
  canvas.addEventListener('mousemove', handle);
  canvas.addEventListener('mouseleave', hideTip);
  canvas.addEventListener('touchstart', handle, { passive: true });
  canvas.addEventListener('touchend', hideTip);

  return canvas;
}

function doyToLabel(doy) {
  const d = new Date(Date.UTC(2001, 0, doy + 1));
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

export { prepare };
