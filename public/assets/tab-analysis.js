// 分析タブ。1940年からの長期の推移と、条件を指定した過去日の抽出。
//
// 長期の系列は ERA5 再解析（格子点の推定値）で、観測所の実測とは別物。
// 混ぜて1本の線にすると、2024年のところで段差ができて「気候が急変した」ように見える。
// 系列を分け、両者のずれ（オフセット）も明示する。
import { el, fmt, fmtSigned, fmtDate } from './dom.js';
import {
  frame, yAxis, xAxisLabels, line, bars, dots, niceScale, legend, crosshair, refLine,
} from './chart-svg.js';
import { longSeries, calendarHeat } from './chart-canvas.js';
import { divergingColor } from './chart-svg.js';

const COUNT_VARS = [
  { key: 'mousho', label: '猛暑日（最高35℃以上）' },
  { key: 'manatsu', label: '真夏日（最高30℃以上）' },
  { key: 'natsubi', label: '夏日（最高25℃以上）' },
  { key: 'nettaiya', label: '熱帯夜（最低25℃以上）' },
  { key: 'fuyubi', label: '冬日（最低0℃未満）' },
  { key: 'rainDays', label: '降水日（1mm以上）' },
];

const state = { countVar: 'manatsu', query: null };

export function renderAnalysis({ data, loc }) {
  const hist = data.history;
  if (!hist) {
    return [el('div', { class: 'panel' }, el('p', { class: 'empty' }, '長期データがまだ無い'))];
  }
  return [
    trendPanel(hist, loc),
    countPanel(hist),
    calendarPanel(hist),
    queryPanel(hist, loc),
  ];
}

// -------------------------------------------------------------- 年平均の推移

function trendPanel(hist, loc) {
  const era5 = (hist.era5Yearly ?? []).filter((y) => y.complete);
  const obs = (hist.obsYearly ?? []).filter((y) => y.complete);
  if (era5.length < 5) {
    return el('section', { class: 'panel' },
      el('h2', {}, '年平均気温の推移'),
      el('p', { class: 'empty' }, '長期データがまだ足りない'));
  }

  const offset = hist.era5Offset?.offset ?? null;
  const years = era5.map((y) => y.year);
  const obsByYear = new Map(obs.map((y) => [y.year, y]));

  const all = [...era5.map((y) => y.tmax), ...obs.map((y) => y.tmax)].filter((v) => v !== null);
  const scale = niceScale(Math.min(...all) - 0.4, Math.max(...all) + 0.4, 5);

  const f = frame({
    width: 760, height: 280,
    pad: { top: 22, right: 78, bottom: 30, left: 44 },
    xDomain: [0, years.length - 1],
    yDomain: [scale.min, scale.max],
    label: '年平均の最高気温の推移',
  });
  yAxis(f, scale.ticks, { format: (v) => `${v}`, unit: '℃' });

  // 10年移動平均。年ごとのばらつきに埋もれた傾きを見る
  const smooth = movingAverage(era5.map((y) => y.tmax), 10);

  line(f, era5.map((y, i) => ({ x: i, y: y.tmax })), { stroke: 'var(--series-quiet)', width: 1.2 });
  line(f, smooth.map((v, i) => ({ x: i, y: v })), { stroke: 'var(--series-1)', width: 2.8 });
  line(f, years.map((y, i) => ({ x: i, y: obsByYear.get(y)?.tmax ?? null })),
    { stroke: 'var(--series-2)', width: 2.4 });

  crosshair(f, years, (i) => {
    const y = era5[i];
    const o = obsByYear.get(y.year);
    return {
      title: `${y.year}年`,
      rows: [
        { k: 'ERA5 年平均の最高気温', v: `${fmt(y.tmax, 2)}℃`, color: cssv('--series-quiet') },
        { k: '10年移動平均', v: `${fmt(smooth[i], 2)}℃`, color: cssv('--series-1') },
        o ? { k: '観測所の実測', v: `${fmt(o.tmax, 2)}℃`, color: cssv('--series-2') } : null,
        { k: '猛暑日', v: `${y.mousho}日` },
        { k: '年間降水量', v: `${fmt(y.prcp, 0)}mm` },
      ].filter(Boolean),
    };
  });

  xAxisLabels(f, years, {
    every: Math.max(1, Math.round(years.length / 10)),
    format: (y) => String(y),
  });

  const first = smooth.find((v) => v !== null);
  const last = [...smooth].reverse().find((v) => v !== null);
  const change = first !== undefined && last !== undefined ? last - first : null;

  return el(
    'section', { class: 'panel' },
    el('h2', {}, '年平均の最高気温はどう動いてきたか'),
    el('p', { class: 'note' },
      `灰色が ERA5 再解析の年平均、太い線がその10年移動平均。`
      + `橙は${loc.station.name}の実測で、期間は短い。`
      + (offset !== null
        ? `ERA5 は実測より ${fmtSigned(offset, 2)}℃ ずれている（重複期間の差の中央値、${hist.era5Offset.n}日で計測）。`
          + '格子点の推定値と観測点の実測は別物なので、1本の線につながずに分けてある。'
        : '両者の重複期間が短く、ずれはまだ測れていない。')),
    change !== null ? el('div', { class: 'tiles' }, el(
      'div', { class: 'tile' },
      el('span', { class: 'label' }, '10年移動平均の変化（記録の最初から最後まで）'),
      el('div', {}, el('span', {
        class: 'value',
        style: { color: change > 0 ? 'var(--div-warm)' : 'var(--div-cool)' },
      }, fmtSigned(change, 2)), el('span', { class: 'unit' }, '℃')),
      el('div', { class: 'sub' }, `${years[0]}年 〜 ${years.at(-1)}年、ERA5 再解析`),
    )) : null,
    legend([
      { label: 'ERA5 年平均', color: 'var(--series-quiet)' },
      { label: '10年移動平均', color: 'var(--series-1)' },
      { label: '観測所の実測', color: 'var(--series-2)' },
    ]),
    el('figure', { class: 'scroll-x' }, f.svg),
  );
}

function movingAverage(values, window) {
  const half = Math.floor(window / 2);
  return values.map((_, i) => {
    const slice = values.slice(Math.max(0, i - half), Math.min(values.length, i + half + 1))
      .filter((v) => v !== null && Number.isFinite(v));
    if (slice.length < window / 2) return null;
    return slice.reduce((s, v) => s + v, 0) / slice.length;
  });
}

// ------------------------------------------------------------ 日数の推移

function countPanel(hist) {
  const era5 = (hist.era5Yearly ?? []).filter((y) => y.complete);
  if (era5.length < 5) return el('div');

  const container = el('div');
  const chart = el('figure', { class: 'scroll-x' });

  const draw = () => {
    const def = COUNT_VARS.find((c) => c.key === state.countVar);
    const values = era5.map((y) => y[state.countVar] ?? null);
    const scale = niceScale(0, Math.max(...values.filter(Number.isFinite), 1) * 1.05, 5);

    const f = frame({
      width: 760, height: 230,
      xDomain: [0, era5.length - 1],
      yDomain: [scale.min, scale.max],
      label: def.label + 'の年間日数',
    });
    yAxis(f, scale.ticks, { format: (v) => `${v}`, unit: '日' });

    bars(f, era5.map((y, i) => ({
      x: i,
      value: y[state.countVar] ?? null,
      tip: {
        title: `${y.year}年`,
        rows: COUNT_VARS.map((c) => ({ k: c.label, v: `${y[c.key]}日` })),
        footer: 'ERA5 再解析にもとづく日数',
      },
    })), { color: 'var(--series-1)', gap: 1 });

    const smooth = movingAverage(values, 10);
    line(f, smooth.map((v, i) => ({ x: i, y: v })), { stroke: 'var(--series-2)', width: 2.4 });

    xAxisLabels(f, era5, {
      every: Math.max(1, Math.round(era5.length / 10)),
      format: (y) => String(y.year),
    });
    chart.replaceChildren(f.svg);
  };

  const selector = el(
    'select',
    {
      'aria-label': '集計する日数',
      onchange: (ev) => { state.countVar = ev.target.value; draw(); },
    },
    COUNT_VARS.map((c) => el('option', { value: c.key, selected: c.key === state.countVar }, c.label)),
  );

  draw();
  container.append(
    el('h2', {}, '暑い日・寒い日・雨の日は何日あったか'),
    el('p', { class: 'note' },
      '棒が各年の日数、線が10年移動平均。ERA5 再解析にもとづくので、'
      + '観測所の公式記録とは数日ずれることがある。傾きを見るための図。'),
    el('div', { style: { marginBottom: '10px' } }, selector),
    legend([
      { label: '年ごとの日数', color: 'var(--series-1)', band: true },
      { label: '10年移動平均', color: 'var(--series-2)' },
    ]),
    chart,
  );
  return el('section', { class: 'panel' }, container);
}

// -------------------------------------------------------- カレンダー状の濃淡

function calendarPanel(hist) {
  const era5 = hist.era5;
  if (!era5?.date?.length) return el('div');

  const byYear = new Map();
  const years = [];
  era5.date.forEach((d, i) => {
    const y = Number(d.slice(0, 4));
    if (!byYear.has(y)) { byYear.set(y, new Array(366).fill(null)); years.push(y); }
    const doy = dayOfYearOf(d);
    byYear.get(y)[doy] = era5.tmax[i];
  });

  const all = era5.tmax.filter((v) => v !== null && Number.isFinite(v));
  const lo = quantileOf(all, 0.02);
  const hi = quantileOf(all, 0.98);

  const container = el('figure', { class: 'scroll-x' });
  calendarHeat(container, { years, byYear }, {
    cellH: years.length > 60 ? 5 : 8,
    label: '日最高気温',
    format: (v) => `${v.toFixed(1)}℃`,
    colorFor: (v) => rampHex((v - lo) / Math.max(1e-6, hi - lo)),
  });

  return el(
    'section', { class: 'panel' },
    el('h2', {}, '暑さの地図（年 × 日）'),
    el('p', { class: 'note' },
      '1行が1年、横が1月から12月。濃いほど日最高気温が高い。'
      + '下の行ほど新しい。夏の濃い帯が年々広がっていれば、暑い期間が長くなっているということ。'),
    container,
  );
}

function dayOfYearOf(ymd) {
  const y = Number(ymd.slice(0, 4));
  const start = Date.UTC(y, 0, 1);
  const d = Date.UTC(y, Number(ymd.slice(5, 7)) - 1, Number(ymd.slice(8, 10)));
  return Math.round((d - start) / 86400000);
}

function quantileOf(sortedSource, p) {
  const a = [...sortedSource].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.max(0, Math.floor(a.length * p)))];
}

/** 逐次配色を実際の色として返す。Canvas は CSS 変数を解決しない */
function rampHex(t) {
  const steps = ['--seq-100', '--seq-250', '--seq-400', '--seq-550', '--seq-700'];
  const c = Math.max(0, Math.min(0.999, t));
  return cssv(steps[Math.floor(c * steps.length)]);
}

// ---------------------------------------------------------------- 条件検索

function queryPanel(hist, loc) {
  const sources = [];
  if (hist.obs?.date?.length) {
    sources.push({
      key: 'obs', data: hist.obs, isObs: true,
      label: `${loc.station.name}の実測（${hist.obs.start}以降 ${hist.obs.n}日）`,
    });
  }
  if (hist.era5?.date?.length) {
    sources.push({
      key: 'era5', data: hist.era5, isObs: false,
      label: `ERA5 再解析（${hist.era5.start}以降 ${hist.era5.n}日）`,
    });
  }
  if (sources.length === 0) return el('div');
  // 既定は長い方。数十年から探せる方が「過去から探す」の役に立つ
  let current = sources.find((x) => x.key === 'era5') ?? sources[0];

  const fields = {
    tmaxMin: el('input', { type: 'number', step: '0.1', placeholder: '下限' }),
    tmaxMax: el('input', { type: 'number', step: '0.1', placeholder: '上限' }),
    tminMin: el('input', { type: 'number', step: '0.1', placeholder: '下限' }),
    tminMax: el('input', { type: 'number', step: '0.1', placeholder: '上限' }),
    prcpMin: el('input', { type: 'number', step: '0.5', placeholder: '下限' }),
    prcpMax: el('input', { type: 'number', step: '0.5', placeholder: '上限' }),
    run: el('input', { type: 'number', step: '1', min: '1', value: '1', placeholder: '1' }),
  };

  const result = el('div');

  const search = () => {
    const cond = {
      tmax: [numOf(fields.tmaxMin), numOf(fields.tmaxMax)],
      tmin: [numOf(fields.tminMin), numOf(fields.tminMax)],
      prcp: [numOf(fields.prcpMin), numOf(fields.prcpMax)],
    };
    const anyCondition = Object.values(cond).some(([lo, hi]) => lo !== null || hi !== null);
    if (!anyCondition) {
      // 条件が空だと全期間が1つの連続として返り、意味のない結果になる
      result.replaceChildren(el('p', { class: 'empty' },
        '条件を1つ以上入れるか、上のボタンから選ぶ'));
      return;
    }
    const runLen = Math.max(1, Number(fields.run.value) || 1);
    const hits = findRuns(current.data, cond, runLen);
    result.replaceChildren(...renderResult(hits, runLen, current).filter(Boolean));
  };

  const sourceSelect = sources.length < 2 ? null : el(
    'select',
    {
      'aria-label': '探すデータ',
      onchange: (ev) => { current = sources.find((x) => x.key === ev.target.value); search(); },
    },
    sources.map((x) => el('option', { value: x.key, selected: x.key === current.key }, x.label)),
  );

  const form = el(
    'div', { class: 'query-form' },
    rangeField('最高気温 (℃)', fields.tmaxMin, fields.tmaxMax),
    rangeField('最低気温 (℃)', fields.tminMin, fields.tminMax),
    rangeField('降水量 (mm)', fields.prcpMin, fields.prcpMax),
    el('div', { class: 'field' },
      el('label', {}, '連続日数'),
      el('div', { class: 'pair' }, fields.run, el('span', { class: 'tilde' }, '日以上続く'))),
    el('div', { class: 'field' }, el('button', { class: 'primary', onclick: search }, '探す')),
  );

  // よく使う条件をすぐ試せるようにする
  const presets = [
    { label: '猛暑日（35℃以上）', set: () => { reset(fields); fields.tmaxMin.value = '35'; } },
    { label: '熱帯夜（最低25℃以上）', set: () => { reset(fields); fields.tminMin.value = '25'; } },
    { label: '3日続いた雨', set: () => { reset(fields); fields.prcpMin.value = '1'; fields.run.value = '3'; } },
    { label: '冬日（最低0℃未満）', set: () => { reset(fields); fields.tminMax.value = '0'; } },
    { label: '真夏日が5日続く', set: () => { reset(fields); fields.tmaxMin.value = '30'; fields.run.value = '5'; } },
  ];

  // 空の条件のまま開くと全期間が1件として返るので、最初から1つ入れておく
  presets[0].set();
  search();

  return el(
    'section', { class: 'panel' },
    el('h2', {}, '条件を決めて過去から探す'),
    el('p', { class: 'note' },
      '気温・降水の上下限と、何日続いたかを指定して、過去の該当期間を取り出す。'
      + 'ERA5 再解析は1940年まで遡れるが格子点の推定値で、観測所の実測とは日ごとに少しずれる。'),
    sourceSelect ? el('div', { style: { marginBottom: '10px' } }, sourceSelect) : null,
    el('div', { class: 'legend' }, presets.map((p) => el(
      'button',
      { class: 'ghost', onclick: () => { p.set(); search(); } },
      p.label,
    ))),
    form,
    result,
  );
}

function reset(fields) {
  for (const k of Object.keys(fields)) fields[k].value = k === 'run' ? '1' : '';
}

function rangeField(label, lo, hi) {
  return el('div', { class: 'field' },
    el('label', {}, label),
    el('div', { class: 'pair' }, lo, el('span', { class: 'tilde' }, '〜'), hi));
}

function numOf(input) {
  const v = input.value.trim();
  if (v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** 条件に合う日を探し、連続日数の条件も見る */
function findRuns(src, cond, runLen) {
  const n = src.date.length;
  const ok = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    let pass = true;
    for (const [key, [lo, hi]] of Object.entries(cond)) {
      if (lo === null && hi === null) continue;
      const v = src[key]?.[i];
      if (v === null || v === undefined || !Number.isFinite(v)) { pass = false; break; }
      if (lo !== null && v < lo) { pass = false; break; }
      if (hi !== null && v > hi) { pass = false; break; }
    }
    ok[i] = pass;
  }

  const runs = [];
  let start = -1;
  for (let i = 0; i <= n; i++) {
    if (i < n && ok[i]) {
      if (start < 0) start = i;
    } else if (start >= 0) {
      const length = i - start;
      if (length >= runLen) {
        runs.push({
          start: src.date[start],
          end: src.date[i - 1],
          length,
          tmax: maxOf(src.tmax.slice(start, i)),
          tmin: minOf(src.tmin.slice(start, i)),
          prcp: sumOf(src.prcp.slice(start, i)),
        });
      }
      start = -1;
    }
  }
  return runs;
}

function maxOf(a) { const v = a.filter(Number.isFinite); return v.length ? Math.max(...v) : null; }
function minOf(a) { const v = a.filter(Number.isFinite); return v.length ? Math.min(...v) : null; }
function sumOf(a) { const v = a.filter(Number.isFinite); return v.length ? v.reduce((s, x) => s + x, 0) : null; }

function renderResult(runs, runLen, source) {
  const src = source.data;
  if (runs.length === 0) {
    return [el('p', { class: 'empty' }, '条件に合う日は無かった')];
  }

  // 月ごとの件数。いつ起きやすいかが分かる
  const byMonth = new Array(12).fill(0);
  const byYear = new Map();
  let totalDays = 0;
  for (const r of runs) {
    byMonth[Number(r.start.slice(5, 7)) - 1]++;
    // 年をまたぐ期間もあるので、開始年から終了年まで数える
    for (let y = Number(r.start.slice(0, 4)); y <= Number(r.end.slice(0, 4)); y++) {
      byYear.set(y, (byYear.get(y) ?? 0) + 1);
    }
    totalDays += r.length;
  }

  const f = frame({
    width: 620, height: 170,
    xDomain: [0, 11], yDomain: [0, Math.max(...byMonth, 1)],
    label: '月別の件数',
  });
  const scale = niceScale(0, Math.max(...byMonth, 1), 4);
  yAxis(f, scale.ticks, { format: (v) => `${v}`, unit: '件' });
  bars(f, byMonth.map((v, i) => ({
    x: i, value: v,
    tip: { title: `${i + 1}月`, rows: [{ k: '件数', v: `${v}件` }] },
  })), { color: 'var(--series-1)' });
  xAxisLabels(f, byMonth, { format: (_, i) => `${i + 1}` });

  const years = [...byYear.keys()].sort((a, b) => a - b);
  const recentRuns = [...runs].reverse().slice(0, 40);

  return [
    el('div', { class: 'tiles' },
      el('div', { class: 'tile' },
        el('span', { class: 'label' }, runLen > 1 ? `${runLen}日以上続いた回数` : '該当した日数'),
        el('div', {}, el('span', { class: 'value' }, String(runLen > 1 ? runs.length : totalDays)),
          el('span', { class: 'unit' }, runLen > 1 ? '回' : '日')),
        el('div', { class: 'sub' }, `${src.start} 以降の ${src.n} 日中`)),
      el('div', { class: 'tile' },
        el('span', { class: 'label' }, '起きた年の幅'),
        el('div', {}, el('span', { class: 'value' }, years.length ? `${years[0]}–${years.at(-1)}` : '—')),
        el('div', { class: 'sub' }, `${years.length} 年で発生`)),
      el('div', { class: 'tile' },
        el('span', { class: 'label' }, '最も長かった連続'),
        el('div', {}, el('span', { class: 'value' }, String(Math.max(...runs.map((r) => r.length)))),
          el('span', { class: 'unit' }, '日')),
        el('div', { class: 'sub' }, runs.reduce((a, b) => (b.length > a.length ? b : a)).start)),
    ),
    el('h2', { style: { fontSize: '13px', margin: '14px 0 4px' } }, '何月に起きやすいか'),
    el('figure', { class: 'scroll-x' }, f.svg),
    el('details', { class: 'table-view' },
      el('summary', {}, `該当した期間の一覧（新しい順に最大40件 / 全${runs.length}件）`),
      el('div', { class: 'scroll-x' }, el(
        'table', {},
        el('thead', {}, el('tr', {},
          el('th', {}, '開始'), el('th', {}, '終了'), el('th', {}, '日数'),
          el('th', {}, '期間の最高'), el('th', {}, '期間の最低'), el('th', {}, '降水量合計'))),
        el('tbody', {}, recentRuns.map((r) => el(
          'tr', {},
          el('td', {}, r.start),
          el('td', {}, r.end),
          el('td', {}, `${r.length}日`),
          el('td', {}, `${fmt(r.tmax, 1)}℃`),
          el('td', {}, `${fmt(r.tmin, 1)}℃`),
          el('td', {}, `${fmt(r.prcp, 1)}mm`),
        ))),
      ))),
    source.isObs ? null : el('p', { class: 'caveat' },
      'ERA5 再解析にもとづく結果。観測所の公式記録とは日ごとに 1℃ 前後ずれることがある。'),
  ];
}

function cssv(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}
