// 成績タブ。このシステムの心臓部。
//
// 「1週間先はほぼ外れる」を数字で見せる。同時に、自作の合議が
// 単独モデルにも補正なしの平均にも勝っていることを、同じ物差しで示す。
// 都合の良い期間を切り取らない。すべて前向き検証の値。
import { el, fmt, fmtPct, fmtDate } from './dom.js';
import {
  frame, yAxis, xAxisLabels, line, dots, niceScale, legend, heatmap, directLabel, refLine,
} from './chart-svg.js';

const MODEL_LABEL = {
  ecmwf_ifs025: 'ECMWF (欧州)',
  gfs_seamless: 'GFS (米国)',
  icon_seamless: 'ICON (ドイツ)',
  jma_seamless: 'JMA (気象庁モデル)',
  ukmo_seamless: 'UKMO (英国)',
  gem_seamless: 'GEM (カナダ)',
  meteofrance_seamless: 'ARPEGE (仏)',
};

const SOURCE_LABEL = {
  'blend:mos': '自作の合議（補正済み）',
  'baseline:mean': '7モデルの単純平均',
  'jma:official': '気象庁の週間予報',
};

/** 図の右端に置く短い名前。長い名前は切れるので凡例と表に任せる */
const SHORT_LABEL = {
  'blend:mos': '自作の合議',
  'baseline:mean': '単純平均',
  'jma:official': '気象庁',
};

const VAR_LABEL = {
  tmax: '最高気温', tmin: '最低気温', rh: '湿度', wind: '風速',
  rain: '降水の有無', pop: '降水確率',
};

export function renderScores({ data, loc }) {
  const sc = data.scores;
  if (!sc?.rows?.length) {
    return [el('div', { class: 'panel' }, el('p', { class: 'empty' }, '成績データがまだ無い'))];
  }
  return [
    headlinePanel(sc),
    leadCurvePanel(sc),
    heatmapPanel(sc),
    rainPanel(sc),
    coefPanel(data.coef),
    leakPanel(data.leakcheck, loc),
  ];
}

function pick(rows, source, variable, lead) {
  return rows.find((r) => r.source === source && r.variable === variable && r.lead === lead) ?? null;
}

function leadsIn(rows, variable) {
  return [...new Set(rows.filter((r) => r.variable === variable).map((r) => r.lead))]
    .sort((a, b) => a - b);
}

// -------------------------------------------------------------- 要点の札

function headlinePanel(sc) {
  const rows = sc.rows;
  const leads = leadsIn(rows, 'tmax');
  const tiles = [];

  for (const lead of [1, 3, 7]) {
    if (!leads.includes(lead)) continue;
    const mos = pick(rows, 'blend:mos', 'tmax', lead);
    const mean = pick(rows, 'baseline:mean', 'tmax', lead);
    if (!mos) continue;
    const gain = mean ? (1 - mos.mae / mean.mae) * 100 : null;
    tiles.push(el(
      'div', { class: 'tile' },
      el('span', { class: 'label' }, `${lead}日先の最高気温`),
      el('div', {}, el('span', { class: 'value' }, `±${fmt(mos.mae, 2)}`), el('span', { class: 'unit' }, '℃')),
      el('div', { class: 'sub' },
        gain !== null ? `補正なしの平均より ${fmt(gain, 0)}% 小さい` : '',
        el('br'),
        `${mos.n}日で検証`),
    ));
  }

  // 最も遠い lead を「ほぼ外れる」の証拠として出す
  const far = leads.at(-1);
  const farMos = pick(rows, 'blend:mos', 'tmax', far);
  if (farMos) {
    tiles.push(el(
      'div', { class: 'tile' },
      el('span', { class: 'label' }, `${far}日先の最大の外し`),
      el('div', {}, el('span', { class: 'value' }, fmt(farMos.maxAbsError, 1)), el('span', { class: 'unit' }, '℃')),
      el('div', { class: 'sub' }, '補正をかけてもこれだけ外す日がある'),
    ));
  }

  return el(
    'section', { class: 'panel' },
    el('h2', {}, '結論'),
    el('p', { class: 'note' },
      '以下はすべて前向き検証の値。ある日を採点するとき、その日より前のデータだけで学習した'
      + '係数を使っている。学習データへの当てはまりは一切出していない。'),
    el('div', { class: 'tiles' }, tiles),
  );
}

// ---------------------------------------------------- リードタイム別の誤差

function leadCurvePanel(sc) {
  const rows = sc.rows;
  const leads = leadsIn(rows, 'tmax');
  if (leads.length < 2) {
    return el('section', { class: 'panel' },
      el('h2', {}, 'リードタイム別の誤差'),
      el('p', { class: 'empty' }, '比較できるリードタイムがまだ足りない'));
  }

  const series = [
    { key: 'blend:mos', color: 'var(--series-1)', width: 2.8 },
    { key: 'baseline:mean', color: 'var(--series-3)', width: 2 },
    { key: 'jma:official', color: 'var(--series-2)', width: 2, dash: '5 3' },
  ];

  const modelSeries = Object.keys(MODEL_LABEL).map((m) => ({
    key: `model:${m}`, model: m, color: 'var(--series-quiet)', width: 1.2,
  }));

  const all = [];
  for (const s of [...series, ...modelSeries]) {
    for (const lead of leads) {
      const r = pick(rows, s.key, 'tmax', lead);
      if (r?.mae) all.push(r.mae);
    }
  }
  if (all.length === 0) {
    return el('section', { class: 'panel' }, el('p', { class: 'empty' }, 'データ不足'));
  }
  const scale = niceScale(0, Math.max(...all) * 1.08, 5);

  const f = frame({
    width: 760, height: 300,
    pad: { top: 22, right: 96, bottom: 30, left: 44 },
    xDomain: [0, leads.length - 1],
    yDomain: [scale.min, scale.max],
    label: 'リードタイム別の最高気温の平均絶対誤差',
  });
  yAxis(f, scale.ticks, { format: (v) => `${v}`, unit: '℃' });

  // 個々のモデルは灰色で背景に置く。色を配ると判別できなくなる
  for (const s of modelSeries) {
    line(f, leads.map((lead, i) => ({ x: i, y: pick(rows, s.key, 'tmax', lead)?.mae ?? null })),
      { stroke: s.color, width: s.width, opacity: 0.85 });
  }

  for (const s of series) {
    const pts = leads.map((lead, i) => ({ x: i, y: pick(rows, s.key, 'tmax', lead)?.mae ?? null }));
    line(f, pts, { stroke: s.color, width: s.width, dash: s.dash });
    dots(f, pts.map((p) => ({
      ...p,
      color: s.color,
      tip: tipFor(rows, s.key, leads[p.x]),
    })), { color: s.color, r: 3.5 });
    // 直接ラベル。凡例だけに頼らない
    const last = [...pts].reverse().find((p) => p.y !== null);
    if (last) directLabel(f, last.x, last.y, SHORT_LABEL[s.key] ?? s.key, { color: s.color });
  }

  // 灰色の束にも1つだけ名前を付ける
  const worst = modelSeries
    .map((s) => ({ s, r: pick(rows, s.key, 'tmax', leads.at(-1)) }))
    .filter((x) => x.r?.mae)
    .sort((a, b) => b.r.mae - a.r.mae)[0];
  if (worst) {
    directLabel(f, leads.length - 1, worst.r.mae, '個々のモデル', { color: 'var(--text-muted)' });
  }

  xAxisLabels(f, leads, { format: (lead) => `${lead}日` });

  return el(
    'section', { class: 'panel' },
    el('h2', {}, '何日先まで当たるか'),
    el('p', { class: 'note' },
      '最高気温の平均絶対誤差。低いほど当たっている。先の日ほど誤差が増えるのは物理的な限界で、'
      + 'どのモデルでも避けられない。合議と補正で押し下げられるのは、その曲線の高さだけ。'),
    legend([
      { label: '自作の合議（補正済み）', color: 'var(--series-1)' },
      { label: '7モデルの単純平均', color: 'var(--series-3)' },
      { label: '気象庁の週間予報', color: 'var(--series-2)', dash: true },
      { label: '個々のモデル', color: 'var(--series-quiet)' },
    ]),
    el('figure', { class: 'scroll-x' }, f.svg),
    tableView(rows, leads),
  );
}

function tipFor(rows, source, lead) {
  const r = pick(rows, source, 'tmax', lead);
  if (!r) return null;
  return {
    title: `${SOURCE_LABEL[source] ?? MODEL_LABEL[source.replace('model:', '')] ?? source}  ${lead}日先`,
    rows: [
      { k: '平均絶対誤差', v: `${fmt(r.mae, 2)}℃` },
      { k: '二乗平均平方根誤差', v: `${fmt(r.rmse, 2)}℃` },
      { k: '偏り', v: `${r.bias > 0 ? '+' : ''}${fmt(r.bias, 2)}℃` },
      { k: '最大の外し', v: `${fmt(r.maxAbsError, 1)}℃` },
      { k: '検証した日数', v: `${r.n}日` },
    ],
  };
}

/** 図で色が判別しにくい場合の逃げ道。数値表を必ず用意する */
function tableView(rows, leads) {
  const sources = [
    'blend:mos', 'baseline:mean', 'jma:official',
    ...Object.keys(MODEL_LABEL).map((m) => `model:${m}`),
  ];
  const body = sources.map((src) => {
    const cells = leads.map((lead) => pick(rows, src, 'tmax', lead)?.mae ?? null);
    if (cells.every((c) => c === null)) return null;
    return { src, cells };
  }).filter(Boolean);

  // 各リードタイムで最小の値に印を付ける
  const bestPerLead = leads.map((_, j) => {
    const vals = body.map((b) => b.cells[j]).filter((v) => v !== null);
    return vals.length ? Math.min(...vals) : null;
  });

  return el(
    'details', { class: 'table-view' },
    el('summary', {}, '数値表で見る（最高気温の平均絶対誤差 ℃）'),
    el('div', { class: 'scroll-x' }, el(
      'table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, '予報の出どころ'),
        leads.map((l) => el('th', {}, `${l}日先`)))),
      el('tbody', {}, body.map((b) => el(
        'tr',
        { class: b.src === 'blend:mos' ? 'highlight' : null },
        el('td', {}, SOURCE_LABEL[b.src] ?? MODEL_LABEL[b.src.replace('model:', '')] ?? b.src),
        b.cells.map((v, j) => el(
          'td',
          { class: v !== null && v === bestPerLead[j] ? 'best' : null },
          v === null ? '—' : fmt(v, 2),
        )),
      ))),
    )),
  );
}

// ------------------------------------------------------------ ヒートマップ

function heatmapPanel(sc) {
  const rows = sc.rows;
  const leads = leadsIn(rows, 'tmax');
  if (leads.length === 0) return el('div');

  const sources = [
    'blend:mos', 'baseline:mean',
    ...Object.keys(MODEL_LABEL).map((m) => `model:${m}`),
    'jma:official',
  ].filter((s) => leads.some((l) => pick(rows, s, 'tmax', l)));

  const container = el('figure', { class: 'scroll-x' });
  heatmap(container, {
    rows: sources.map((s) => SOURCE_LABEL[s] ?? MODEL_LABEL[s.replace('model:', '')] ?? s),
    cols: leads.map((l) => `${l}日`),
    values: sources.map((s) => leads.map((l) => pick(rows, s, 'tmax', l)?.mae ?? null)),
  }, {
    labelW: 150,
    format: (v) => v.toFixed(2),
    tipFor: (i, j, v) => tipFor(rows, sources[i], leads[j]) ?? { title: '', rows: [{ k: '誤差', v: fmt(v, 2) }] },
  });

  return el(
    'section', { class: 'panel' },
    el('h2', {}, '出どころ × 何日先 の誤差'),
    el('p', { class: 'note' },
      '濃いほど誤差が大きい。枠だけのマスはその組み合わせの予報が無い。'
      + '欧州のモデルが16日先まで出すのに対し、仏のモデルは4日先までしか出さない、といった差がここに出る。'),
    container,
  );
}

// ------------------------------------------------------------------ 降水

function rainPanel(sc) {
  const rows = sc.rows;
  const leads = leadsIn(rows, 'rain');
  if (leads.length === 0) {
    return el('section', { class: 'panel' },
      el('h2', {}, '降水の当たり方'),
      el('p', { class: 'empty' }, 'まだ検証できていない'));
  }

  const scale = { min: 0, max: 1, ticks: [0, 0.25, 0.5, 0.75, 1] };
  const f = frame({
    width: 700, height: 240,
    pad: { top: 22, right: 96, bottom: 30, left: 44 },
    xDomain: [0, leads.length - 1],
    yDomain: [0, 1],
    label: '降水の有無を当てられた割合',
  });
  yAxis(f, scale.ticks, { format: (v) => `${Math.round(v * 100)}`, unit: '%' });

  const seriesDefs = [
    { key: 'blend:mos', field: 'accuracy', color: 'var(--series-1)', label: '適中率（自作）', short: '適中率' },
    { key: 'blend:mos', field: 'hitRate', color: 'var(--series-3)', label: '雨の日を当てた率', short: '雨を当てた率' },
    { key: 'jma:official', field: 'accuracy', color: 'var(--series-2)', label: '適中率（気象庁）', short: '気象庁', dash: '5 3' },
  ];

  const drawn = [];
  for (const s of seriesDefs) {
    const pts = leads.map((lead, i) => {
      const r = pick(rows, s.key, 'rain', lead);
      return { x: i, y: r ? r[s.field] : null };
    });
    if (pts.every((p) => p.y === null)) continue;
    drawn.push(s);
    line(f, pts, { stroke: s.color, width: 2.4, dash: s.dash });
    dots(f, pts.map((p) => ({
      ...p,
      color: s.color,
      tip: rainTip(rows, s.key, leads[p.x]),
    })), { color: s.color, r: 3.5 });
    const last = [...pts].reverse().find((p) => p.y !== null);
    if (last) directLabel(f, last.x, last.y, s.short, { color: s.color });
  }

  xAxisLabels(f, leads, { format: (l) => `${l}日` });

  // 信頼度図
  const reliabilityRow = rows.find((r) => r.variable === 'pop' && r.source === 'blend:mos' && r.reliability)
    ?? rows.find((r) => r.variable === 'pop' && r.reliability);

  return el(
    'section', { class: 'panel' },
    el('h2', {}, '降水の当たり方'),
    el('p', { class: 'note' },
      '「降らない」と言い続ければ適中率は上がる。それを技術と呼ばないために、'
      + '雨の日をどれだけ拾えたか（雨の日を当てた率）も並べている。'),
    legend(drawn.map((s) => ({ label: s.label, color: s.color, dash: Boolean(s.dash) }))),
    el('figure', { class: 'scroll-x' }, f.svg),
    reliabilityRow ? reliabilityPanel(reliabilityRow) : null,
  );
}

function rainTip(rows, source, lead) {
  const r = pick(rows, source, 'rain', lead);
  if (!r) return null;
  return {
    title: `${SOURCE_LABEL[source] ?? source}  ${lead}日先`,
    rows: [
      { k: '適中率', v: fmtPct(r.accuracy, 1) },
      { k: '雨の日を当てた率', v: fmtPct(r.hitRate, 1) },
      { k: '空振り率', v: fmtPct(r.falseAlarmRatio, 1) },
      { k: '見逃し率', v: fmtPct(r.missRatio, 1) },
      { k: 'ETS（偶然を除いた技術）', v: fmt(r.ets, 3) },
      { k: '雨だった日', v: `${r.rainDays} / ${r.n}日` },
    ],
  };
}

/** 信頼度図。確率が正直かどうかは、対角線に乗るかで分かる */
function reliabilityPanel(row) {
  const bins = row.reliability.filter((b) => b.n > 0);
  if (bins.length < 3) return null;

  const f = frame({
    width: 320, height: 300,
    pad: { top: 22, right: 16, bottom: 34, left: 44 },
    xDomain: [0, 1], yDomain: [0, 1],
    label: '降水確率の信頼度図',
  });
  yAxis(f, [0, 0.25, 0.5, 0.75, 1], { format: (v) => `${Math.round(v * 100)}`, unit: '実測%' });

  // 完全に較正されていればこの線に乗る
  f.plot.appendChild(el('line', {
    x1: f.x(0), y1: f.y(0), x2: f.x(1), y2: f.y(1),
    stroke: 'var(--axis)', 'stroke-width': 1.5, 'stroke-dasharray': '4 3',
  }));

  const pts = bins.map((b) => ({ x: b.meanForecast, y: b.observed }));
  line(f, pts, { stroke: 'var(--series-1)', width: 2 });
  dots(f, bins.map((b) => ({
    x: b.meanForecast, y: b.observed,
    tip: {
      title: `予報 ${Math.round(b.lower * 100)}〜${Math.round(b.upper * 100)}%`,
      rows: [
        { k: '実際に降った割合', v: fmtPct(b.observed, 1) },
        { k: '出した確率の平均', v: fmtPct(b.meanForecast, 1) },
        { k: '該当した日数', v: `${b.n}日` },
      ],
    },
  })), { color: 'var(--series-1)', r: Math.min(6, 3 + bins.length / 4) });

  f.plot.appendChild(el('text', {
    x: f.innerW / 2, y: f.innerH + 26, 'text-anchor': 'middle',
    fill: 'var(--text-muted)', 'font-size': 10.5,
  }, '出した降水確率 %'));

  return el(
    'div', { style: { marginTop: '18px' } },
    el('h2', { style: { fontSize: '13px', margin: '0 0 4px' } }, '確率は正直か（信頼度図）'),
    el('p', { class: 'note' },
      '破線に乗っていれば、60%と言った日の6割で実際に降っている。'
      + '線が破線より下なら言い過ぎ、上なら言い足りない。'),
    el('figure', {}, f.svg),
  );
}

// ------------------------------------------------------------ 学習した係数

function coefPanel(coef) {
  if (!coef?.coefficients?.length) return el('div');
  const picks = coef.coefficients
    .filter((c) => c.variable === 'tmax' && c.beta)
    .sort((a, b) => a.lead - b.lead);
  if (picks.length === 0) return el('div');

  const names = coef.featureNames ?? [];
  return el(
    'section', { class: 'panel' },
    el('h2', {}, '何を重く見ているか'),
    el('p', { class: 'note' },
      '最高気温の合議に使っている係数。大きいほどそのモデルを重く見ている。'
      + '負の値もありうる。あるモデルが常に高めに出るなら、他モデルとの差で補正に使われる。'
      + '切片は地点ごとの底上げ分。'),
    el('div', { class: 'scroll-x' }, el(
      'table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, '何日先'),
        names.map((n) => el('th', {}, n.replace(/_seamless|_ifs025/, ''))),
        el('th', {}, 'λ'),
        el('th', {}, '学習日数'))),
      el('tbody', {}, picks.map((c) => el(
        'tr', {},
        el('td', {}, `${c.lead}日`),
        c.beta.map((b) => el('td', {}, fmt(b, 3))),
        el('td', {}, String(c.lambda ?? '—')),
        el('td', {}, String(c.n)),
      ))),
    )),
  );
}

// -------------------------------------------------------- リークしていない証拠

function leakPanel(leak, loc) {
  const rows = (leak?.rows ?? []).filter((r) => r.loc === loc.key && r.variable === 'tmax');
  if (rows.length === 0) return el('div');

  return el(
    'section', { class: 'panel' },
    el('h2', {}, '未来を見ていない証拠'),
    el('p', { class: 'note' },
      '精度を良く見せる一番簡単な方法は、評価する日の実測を学習に混ぜてしまうこと。'
      + 'そうしていないことを確認できるよう、係数をいつまでのデータで学習し、'
      + 'いつから評価を始めたかを出している。学習の終わりが評価の始まりより前になっていればよい。'),
    el('div', { class: 'scroll-x' }, el(
      'table', {},
      el('thead', {}, el('tr', {},
        el('th', {}, '何日先'), el('th', {}, '評価の開始'), el('th', {}, '最後の学習の終端'),
        el('th', {}, '学習し直した回数'), el('th', {}, 'サンプル'), el('th', {}, '選ばれたλ'), el('th', {}, '誤差'))),
      el('tbody', {}, rows.sort((a, b) => a.lead - b.lead).map((r) => el(
        'tr', {},
        el('td', {}, `${r.lead}日`),
        el('td', {}, r.evaluatedFrom ?? '—'),
        el('td', {}, r.lastTrainTo ?? '—'),
        el('td', {}, String(r.retrains)),
        el('td', {}, String(r.n)),
        el('td', {}, String(r.lambda)),
        el('td', {}, `${fmt(r.mae, 2)}℃`),
      ))),
    )),
  );
}
