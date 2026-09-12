// 平年比タブ。「今は平年に対して暑いのか寒いのか」に答える。
//
// 平年値は気象庁が公表している 1991-2020 の日別値。自前で30年を平均していない。
// 公表値には観測所の移転補正などが入っており、自前集計だと世間の「平年より◯℃高い」とずれる。
import { el, fmt, fmtSigned, fmtDate } from './dom.js';
import {
  frame, yAxis, xAxisLabels, line, band, bars, niceScale, legend, crosshair,
  divergingColor, refLine,
} from './chart-svg.js';

export function renderNormals({ data, loc }) {
  const nd = data.normals;
  if (!nd?.vsNormal?.length) {
    return [el('div', { class: 'panel' }, el('p', { class: 'empty' }, '平年比のデータがまだ無い'))];
  }
  const rows = nd.vsNormal.filter((r) => r.tmax !== null || r.prcp !== null);
  if (rows.length === 0) {
    return [el('div', { class: 'panel' }, el('p', { class: 'empty' }, '実測がまだ無い'))];
  }

  return [
    summaryPanel(rows, nd, loc),
    anomalyPanel(rows),
    monthlyPanel(rows),
    yearShapePanel(rows, nd),
  ];
}

/** 直近 n 日 */
function recent(rows, n) {
  return rows.slice(-n);
}

function meanOf(list, key) {
  const v = list.map((r) => r[key]).filter((x) => x !== null && Number.isFinite(x));
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
}

function sumOf(list, key) {
  const v = list.map((r) => r[key]).filter((x) => x !== null && Number.isFinite(x));
  return v.length ? v.reduce((s, x) => s + x, 0) : null;
}

// ------------------------------------------------------------------ 要点

function summaryPanel(rows, nd, loc) {
  const last = rows.at(-1);
  const tiles = [];

  for (const [label, n] of [['直近7日', 7], ['直近30日', 30], ['直近90日', 90]]) {
    const list = recent(rows, n);
    const obs = meanOf(list, 'tmax');
    const nor = meanOf(list, 'nTmax');
    if (obs === null || nor === null) continue;
    const diff = obs - nor;
    tiles.push(el(
      'div', { class: 'tile' },
      el('span', { class: 'label' }, `${label}の平年差（最高気温）`),
      el('div', {},
        el('span', {
          class: 'value',
          style: { color: Math.abs(diff) < 0.5 ? 'var(--text-primary)' : diff > 0 ? 'var(--div-warm)' : 'var(--div-cool)' },
        }, fmtSigned(diff, 1)),
        el('span', { class: 'unit' }, '℃')),
      el('div', { class: 'sub' }, `実測 ${fmt(obs, 1)}℃ / 平年 ${fmt(nor, 1)}℃`),
    ));
  }

  const p30 = sumOf(recent(rows, 30), 'prcp');
  const pn30 = sumOf(recent(rows, 30), 'nPrcp');
  if (p30 !== null && pn30 !== null && pn30 > 0) {
    tiles.push(el(
      'div', { class: 'tile' },
      el('span', { class: 'label' }, '直近30日の降水量'),
      el('div', {}, el('span', { class: 'value' }, `${Math.round((p30 / pn30) * 100)}`), el('span', { class: 'unit' }, '% 平年比')),
      el('div', { class: 'sub' }, `実測 ${fmt(p30, 0)}mm / 平年 ${fmt(pn30, 0)}mm`),
    ));
  }

  return el(
    'section', { class: 'panel' },
    el('h2', {}, `${loc.label}は平年と比べてどうか`),
    el('p', { class: 'note' },
      `平年値は気象庁が公表している ${nd.normals?.from ?? 1991}-${nd.normals?.to ?? 2020} 年の日別平年値。`
      + `観測所は${loc.station.name}。最新の実測は ${last ? fmtDate(last.date) : '—'}。`),
    el('div', { class: 'tiles' }, tiles),
  );
}

// ---------------------------------------------------------------- 平年差

function anomalyPanel(rows) {
  const list = recent(rows, 120);
  const diffs = list.map((r) => (r.tmax !== null && r.nTmax !== null ? r.tmax - r.nTmax : null));
  const valid = diffs.filter((d) => d !== null);
  if (valid.length === 0) return el('div');

  const lim = Math.max(3, Math.ceil(Math.max(...valid.map(Math.abs))));
  const scale = niceScale(-lim, lim, 4);

  const f = frame({
    width: 760, height: 220,
    xDomain: [0, list.length - 1],
    yDomain: [scale.min, scale.max],
    label: '最高気温の平年差',
  });
  yAxis(f, scale.ticks, { format: (v) => `${v > 0 ? '+' : ''}${v}`, unit: '℃' });

  bars(f, list.map((r, i) => ({
    x: i,
    value: diffs[i],
    color: divergingColor(diffs[i], lim),
    tip: {
      title: fmtDate(r.date),
      rows: [
        { k: '最高気温', v: `${fmt(r.tmax, 1)}℃` },
        { k: '平年', v: `${fmt(r.nTmax, 1)}℃` },
        { k: '平年差', v: `${fmtSigned(diffs[i], 1)}℃` },
        { k: '降水量', v: `${fmt(r.prcp, 1)}mm（平年 ${fmt(r.nPrcp, 1)}）` },
      ],
    },
  })), { baseline: 0, gap: 1 });

  refLine(f, 0, { label: '平年', dash: null, color: 'var(--axis)' });
  xAxisLabels(f, list, {
    every: Math.max(1, Math.round(list.length / 12)),
    format: (r) => fmtDate(r.date, { withDow: false }),
  });

  return el(
    'section', { class: 'panel' },
    el('h2', {}, '日ごとの平年差（直近120日）'),
    el('p', { class: 'note' },
      '平年より高い日を赤、低い日を青にしている。真ん中の線が平年。'
      + '棒が無い日は観測が欠けている日で、0 として埋めてはいない。'),
    legend([
      { label: '平年より高い', color: 'var(--div-warm)', band: true },
      { label: '平年より低い', color: 'var(--div-cool)', band: true },
    ]),
    el('figure', { class: 'scroll-x' }, f.svg),
  );
}

// ---------------------------------------------------------------- 月ごと

function monthlyPanel(rows) {
  const byMonth = new Map();
  for (const r of rows) {
    const key = r.date.slice(0, 7);
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(r);
  }
  const months = [...byMonth.entries()].sort((a, b) => a[0].localeCompare(b[0])).slice(-18);
  if (months.length === 0) return el('div');

  const items = months.map(([key, list]) => ({
    key,
    tmax: meanOf(list, 'tmax'),
    nTmax: meanOf(list, 'nTmax'),
    prcp: sumOf(list, 'prcp'),
    nPrcp: sumOf(list, 'nPrcp'),
    days: list.length,
    // 月の途中は平年と直接比べられない
    partial: list.length < 26,
  }));

  const all = items.flatMap((m) => [m.tmax, m.nTmax]).filter((v) => v !== null);
  const scale = niceScale(Math.min(...all) - 1, Math.max(...all) + 1, 5);

  const f = frame({
    width: 760, height: 240,
    pad: { top: 22, right: 70, bottom: 34, left: 44 },
    xDomain: [0, items.length - 1],
    yDomain: [scale.min, scale.max],
    label: '月平均の最高気温と平年値',
  });
  yAxis(f, scale.ticks, { format: (v) => `${v}`, unit: '℃' });

  line(f, items.map((m, i) => ({ x: i, y: m.nTmax })), { stroke: 'var(--text-muted)', width: 2, dash: '4 3' });
  line(f, items.map((m, i) => ({ x: i, y: m.tmax })), { stroke: 'var(--series-1)', width: 2.5 });

  crosshair(f, items, (i) => {
    const m = items[i];
    return {
      title: m.key + (m.partial ? `（${m.days}日分のみ）` : ''),
      rows: [
        { k: '月平均の最高気温', v: `${fmt(m.tmax, 1)}℃`, color: cssv('--series-1') },
        { k: '平年', v: `${fmt(m.nTmax, 1)}℃` },
        { k: '平年差', v: fmtSigned(m.tmax !== null && m.nTmax !== null ? m.tmax - m.nTmax : null, 1) + '℃' },
        { k: '降水量', v: `${fmt(m.prcp, 0)}mm（平年 ${fmt(m.nPrcp, 0)}mm）` },
      ],
      footer: m.partial ? '月の途中なので平年との比較は参考値' : null,
    };
  });

  xAxisLabels(f, items, {
    every: items.length > 12 ? 2 : 1,
    format: (m) => m.key.slice(2).replace('-', '/'),
  });

  return el(
    'section', { class: 'panel' },
    el('h2', {}, '月ごとの平均と平年'),
    el('p', { class: 'note' }, '実線が実測、破線が平年。月の途中のものは日数が揃っていないので参考値。'),
    legend([
      { label: '実測（月平均の最高気温）', color: 'var(--series-1)' },
      { label: '平年値', color: 'var(--text-muted)', dash: true },
    ]),
    el('figure', { class: 'scroll-x' }, f.svg),
  );
}

// ------------------------------------------------------------ 年間の形

function yearShapePanel(rows, nd) {
  const days = nd.normals?.days;
  if (!days?.length) return el('div');

  const year = rows.at(-1).date.slice(0, 4);
  const thisYear = rows.filter((r) => r.date.startsWith(year));
  if (thisYear.length < 10) return el('div');

  const byIndex = new Map();
  for (const r of thisYear) {
    const d = new Date(`${r.date}T00:00:00+09:00`);
    const start = new Date(`${year}-01-01T00:00:00+09:00`);
    const idx = Math.round((d - start) / 86400000);
    byIndex.set(Math.min(364, idx), r);
  }

  const all = [
    ...days.map((d) => d.tmax), ...days.map((d) => d.tmin),
    ...thisYear.map((r) => r.tmax), ...thisYear.map((r) => r.tmin),
  ].filter((v) => v !== null && Number.isFinite(v));
  const scale = niceScale(Math.min(...all) - 1, Math.max(...all) + 1, 6);

  const f = frame({
    width: 760, height: 280,
    pad: { top: 22, right: 16, bottom: 32, left: 44 },
    xDomain: [0, 364],
    yDomain: [scale.min, scale.max],
    label: `${year}年の気温と平年の1年の形`,
  });
  yAxis(f, scale.ticks, { format: (v) => `${v}`, unit: '℃' });

  // 平年の最低〜最高の帯
  band(f, days.map((d, i) => ({ x: i, low: d.tmin, high: d.tmax })),
    { fill: 'var(--text-muted)', opacity: 0.18 });

  line(f, [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([i, r]) => ({ x: i, y: r.tmax })),
    { stroke: 'var(--series-1)', width: 1.8 });
  line(f, [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([i, r]) => ({ x: i, y: r.tmin })),
    { stroke: 'var(--series-1)', width: 1.8, opacity: 0.6 });

  const monthStarts = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  const gAxis = el('g');
  monthStarts.forEach((d, m) => {
    gAxis.appendChild(el('text', {
      x: f.x(d + 15), y: f.innerH + 16, 'text-anchor': 'middle',
      fill: 'var(--text-muted)', 'font-size': 10.5,
    }, `${m + 1}月`));
  });
  gAxis.appendChild(el('line', {
    x1: 0, x2: f.innerW, y1: f.innerH, y2: f.innerH, stroke: 'var(--axis)', 'stroke-width': 1,
  }));
  f.plot.appendChild(gAxis);

  return el(
    'section', { class: 'panel' },
    el('h2', {}, `${year}年は平年の形からどうずれているか`),
    el('p', { class: 'note' },
      '灰色の帯が平年の最低〜最高の範囲。線が今年の実測。'
      + '帯から上に外れている期間が続いていれば、その季節が平年より暑かったということ。'),
    legend([
      { label: `${year}年の実測`, color: 'var(--series-1)' },
      { label: '平年の最低〜最高', color: 'var(--text-muted)', band: true },
    ]),
    el('figure', { class: 'scroll-x' }, f.svg),
  );
}

function cssv(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}
