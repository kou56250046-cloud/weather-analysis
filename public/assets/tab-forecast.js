// 予報タブ。
//
// 数字の隣に必ず実績誤差を置く。「25℃」ではなく「25℃ / この先3日の実績誤差 1.1℃」。
// 7日先の予報を1日先と同じ顔で出さないのが、この画面の一番の主張。
import { el, fmt, fmtSigned, fmtPct, fmtDate } from './dom.js';
import { iconForDay, weatherIcon, describeCode } from './weather-icon.js';
import { renderLive } from './live.js';
import {
  frame, yAxis, xAxisLabels, line, band, bars, niceScale, legend, crosshair, refLine,
} from './chart-svg.js';


export function renderForecast({ data, loc }) {
  const fc = data.forecast;
  if (!fc || !fc.days?.length) {
    return [el('div', { class: 'panel' }, el('p', { class: 'empty' }, '予報データがまだ無い'))];
  }
  const days = fc.days;
  const today = days[0];

  return [
    todayPanel(today, loc),
    livePanel(loc),
    stripPanel(days),
    hourlyPanel(data.hourly, days),
    temperaturePanel(days),
    rainPanel(days),
    tablePanel(days),
  ];
}

// ------------------------------------------------------------------ 実況

/**
 * 押したときだけ実況を取りに行く。
 *
 * 常に自動で取らないのは、気象庁のサーバーを開くたびに叩かないため。
 * それに、ここで出すのは予報ではなく観測値なので、
 * 「今どうなっているか確かめたい」と思った瞬間に取るのが理に適っている。
 */
function livePanel(loc) {
  const body = el('div');
  let loading = false;

  const button = el('button', {
    class: 'primary',
    onclick: async () => {
      if (loading) return;
      loading = true;
      button.disabled = true;
      button.textContent = '取得中…';
      try {
        await renderLive(body, loc);
      } catch (err) {
        console.error(err);
        body.replaceChildren(el('p', { class: 'caveat serious' },
          `取得できなかった: ${err.message}`));
      } finally {
        loading = false;
        button.disabled = false;
        button.textContent = '現在の天気の詳細を取得する';
      }
    },
  }, '現在の天気の詳細を取得する');

  return el(
    'section', { class: 'panel' },
    el('h2', {}, '実況を見る'),
    el('p', { class: 'note' },
      'ここから先は予報ではなく、観測所で実際に測られた値。'
      + `${loc.station.name}の10分ごとの観測を直近6時間ぶん取ってくる。`
      + '上の予報がいま当たっているかを、その場で確かめられる。'),
    el('div', { style: { marginBottom: '12px' } }, button),
    body,
  );
}

// ------------------------------------------------------------------ 今日

function todayPanel(day, loc) {
  const tiles = [];
  const icon = iconForDay(day, { size: 44 });

  tiles.push(el(
    'div', { class: 'tile tile-weather' },
    el('span', { class: 'label' }, '天気'),
    el('div', { class: 'weather-row' },
      icon.node,
      el('span', { class: 'weather-name' }, icon.label)),
    el('div', { class: 'sub' },
      icon.inferred ? '降水量と確率からの推定' : `${day.codeModels ?? 0}モデルの合議`),
  ));

  tiles.push(tile('最高気温', fmt(day.tmax?.value, 1), '℃',
    day.tmaxMae !== null ? `実績誤差 ±${fmt(day.tmaxMae, 1)}℃` : '実績はまだ足りない'));
  tiles.push(tile('最低気温', fmt(day.tmin?.value, 1), '℃',
    day.tminMae !== null ? `実績誤差 ±${fmt(day.tminMae, 1)}℃` : '実績はまだ足りない'));
  tiles.push(tile('降水確率', fmtPct(day.pop?.value), '',
    day.pop?.method === 'logistic' ? '実測で較正済み'
      : day.pop?.method === 'ensemble' ? 'アンサンブル比率（未較正）' : '—'));
  tiles.push(tile('降水量', fmt(day.prcp?.value, 1), 'mm',
    `モデル間の開き ${fmt(day.prcp?.spread, 1)}mm`));

  if (day.normal?.tmax !== null && day.tmax?.value !== null) {
    const diff = day.tmax.value - day.normal.tmax;
    tiles.push(tile('平年差', fmtSigned(diff, 1), '℃',
      `平年の最高 ${fmt(day.normal.tmax, 1)}℃`));
  }

  const notes = [];
  if (day.tmax?.method === 'mean') {
    notes.push(el('p', { class: 'caveat' },
      '統計補正（MOS）に必要なサンプルがまだ足りない。いまは7モデルの単純平均を出している。'));
  }
  if (day.jma && day.jma.tempComparable === false) {
    notes.push(el('p', { class: 'caveat serious' },
      `気象庁の週間予報が気温を出しているのは${day.jma.tempAreaName}で、`
      + `真値の観測所（${loc.station.name}）とは別の地点。気温の比較は参考値として見る。`));
  }

  return el(
    'section',
    { class: 'panel' },
    el('h2', {}, `${fmtDate(day.date)}の予報`),
    el('p', { class: 'note' },
      `${loc.label}。7つの数値予報モデルを合議し、過去の予報と実測から学習した補正をかけている。`
      + '括弧内はその条件での実績誤差で、前向き検証（学習に使っていない期間）の値。'),
    el('div', { class: 'tiles' }, tiles),
    ...notes,
  );
}

function tile(label, value, unit, sub) {
  return el(
    'div',
    { class: 'tile' },
    el('span', { class: 'label' }, label),
    el('div', {}, el('span', { class: 'value' }, value), unit ? el('span', { class: 'unit' }, unit) : null),
    el('div', { class: 'sub' }, sub),
  );
}

// ------------------------------------------------------------ 日ごとの並び

/**
 * 日ごとのカード。アイコン・日付・最高最低・降水確率を1枚にまとめる。
 * グラフより先に、ここだけ見て終わる日の方が多い。
 */
function stripPanel(days) {
  const cards = days.map((d) => {
    const icon = iconForDay(d, { size: 30 });
    const isToday = d.lead === 0;
    return el(
      'div',
      { class: `daycard${isToday ? ' today' : ''}`, title: `${fmtDate(d.date)} ${icon.label}` },
      el('span', { class: 'daycard-date' }, isToday ? '今日' : fmtDate(d.date)),
      icon.node,
      el('span', { class: 'daycard-name' }, icon.label),
      el('span', { class: 'daycard-temp' },
        el('b', {}, fmt(d.tmax?.value, 0)),
        ' / ',
        el('span', { class: 'muted' }, fmt(d.tmin?.value, 0))),
      el('span', { class: 'daycard-pop' }, fmtPct(d.pop?.value)),
    );
  });

  return el(
    'section', { class: 'panel' },
    el('h2', {}, '16日先まで'),
    el('p', { class: 'note' },
      'マークは7モデルの合議。上段が最高気温、下段が最低気温、その下が降水確率。'
      + '先の日ほど当たらないので、右へ行くほど参考程度に見る。'),
    el('div', { class: 'scroll-x' }, el('div', { class: 'daystrip' }, cards)),
  );
}

// -------------------------------------------------------------- 時間別

const DOW_SHORT = ['日', '月', '火', '水', '木', '金', '土'];

/** 日付の変わり目と時刻の目盛り。時間別の図で2回使う */
function hourAxis(f, rows) {
  const g = el('g');
  rows.forEach((r, i) => {
    if (r.hour % 3 !== 0) return;
    g.appendChild(el('text', {
      x: f.x(i), y: f.innerH + 14, 'text-anchor': 'middle',
      fill: r.hour === 0 ? 'var(--text-secondary)' : 'var(--text-muted)',
      'font-size': 10.5,
      'font-weight': r.hour === 0 ? 600 : 400,
    }, r.hour === 0 ? `${Number(r.date.slice(8, 10))}日` : `${r.hour}`));
  });
  g.appendChild(el('line', {
    x1: 0, x2: f.innerW, y1: f.innerH, y2: f.innerH,
    stroke: 'var(--axis)', 'stroke-width': 1,
  }));
  f.plot.appendChild(g);
}

/** 日付が変わるところに縦線を引く */
function dayBoundaries(f, rows) {
  rows.forEach((r, i) => {
    if (i === 0 || r.date === rows[i - 1].date) return;
    f.plot.appendChild(el('line', {
      x1: f.x(i - 0.5), x2: f.x(i - 0.5), y1: 0, y2: f.innerH,
      stroke: 'var(--axis)', 'stroke-width': 1,
    }));
  });
}

/**
 * 今日と明日の1時間ごと。
 *
 * この図だけ統計補正が当たっていない。補正は日別の最高・最低気温に対して
 * 学習しているので、時間ごとの値に当てる根拠が無い。7モデルの単純平均をそのまま出す。
 * 上の日別の値とわずかに食い違うことがあるので、そのことを画面に書く。
 */
function hourlyPanel(hourly, days) {
  if (!hourly?.rows?.length) {
    return el(
      'section', { class: 'panel' },
      el('h2', {}, '1時間ごと（今日と明日）'),
      el('p', { class: 'empty' }, '時間別のデータがまだ無い'),
    );
  }

  const rows = hourly.rows;
  const today = days[0]?.date ?? rows[0].date;
  const nowHour = new Date().getHours();
  const width = Math.max(760, rows.length * 17);

  const temps = rows.flatMap((r) => [r.temp, r.feels])
    .filter((v) => v !== null && Number.isFinite(v));
  const scale = niceScale(Math.min(...temps) - 1, Math.max(...temps) + 1, 5);

  const f = frame({
    width, height: 250,
    pad: { top: 22, right: 16, bottom: 46, left: 42 },
    xDomain: [0, rows.length - 1],
    yDomain: [scale.min, scale.max],
    label: '今日と明日の1時間ごとの気温',
  });
  yAxis(f, scale.ticks, { format: (v) => `${v}`, unit: '℃' });
  dayBoundaries(f, rows);

  // 今の時刻に印を付ける
  const nowIdx = rows.findIndex((r) => r.date === today && r.hour === nowHour);
  if (nowIdx >= 0) {
    f.plot.appendChild(el('line', {
      x1: f.x(nowIdx), x2: f.x(nowIdx), y1: 0, y2: f.innerH,
      stroke: 'var(--series-2)', 'stroke-width': 2, 'stroke-dasharray': '3 3',
    }));
    f.plot.appendChild(el('text', {
      x: f.x(nowIdx), y: -8, 'text-anchor': 'middle',
      fill: 'var(--series-2)', 'font-size': 10.5, 'font-weight': 600,
    }, 'いま'));
  }

  line(f, rows.map((r, i) => ({ x: i, y: r.feels })),
    { stroke: 'var(--series-3)', width: 1.8, dash: '4 3' });
  line(f, rows.map((r, i) => ({ x: i, y: r.temp })),
    { stroke: 'var(--series-1)', width: 2.4 });

  // 3時間ごとに天気アイコンを置く
  rows.forEach((r, i) => {
    if (r.hour % 3 !== 0 || r.code === null) return;
    const icon = weatherIcon({ code: r.code, size: 18 });
    icon.setAttribute('x', f.x(i) - 9);
    icon.setAttribute('y', f.innerH + 20);
    f.plot.appendChild(icon);
  });

  hourAxis(f, rows);
  crosshair(f, rows, (i) => hourlyTip(rows[i]));

  return el(
    'section', { class: 'panel' },
    el('h2', {}, '1時間ごと（今日と明日）'),
    el('p', { class: 'note' },
      '7モデルの単純平均。この図だけ統計補正が当たっていない。'
      + '補正は日別の最高・最低気温に対して学習しているので、時間ごとの値に当てる根拠が無い。'
      + 'そのため上の日別の値とわずかに食い違うことがある。'),
    legend([
      { label: '気温', color: 'var(--series-1)' },
      { label: '体感温度', color: 'var(--series-3)', dash: true },
    ]),
    el('figure', { class: 'scroll-x' }, f.svg),
    hourlyRainPanel(rows, width),
    hourlyTable(rows),
  );
}

/**
 * 降水確率と降水量。
 * 単位が違うので軸を2本にはしない。棒を確率、線を量にして、
 * 量の目盛りは右端に3つだけ添える。
 */
function hourlyRainPanel(rows, width) {
  const f = frame({
    width, height: 180,
    pad: { top: 22, right: 44, bottom: 28, left: 42 },
    xDomain: [0, rows.length - 1],
    yDomain: [0, 100],
    label: '1時間ごとの降水確率と降水量',
  });
  yAxis(f, [0, 25, 50, 75, 100], { format: (v) => `${v}`, unit: '%' });
  dayBoundaries(f, rows);

  bars(f, rows.map((r, i) => ({ x: i, value: r.pop, tip: hourlyTip(r) })),
    { color: 'var(--seq-250)', gap: 1 });

  const maxPrcp = Math.max(...rows.map((r) => r.prcp ?? 0), 1);
  const toPct = (mm) => (mm === null || !Number.isFinite(mm) ? null : (mm / maxPrcp) * 100);
  line(f, rows.map((r, i) => ({ x: i, y: toPct(r.prcp) })),
    { stroke: 'var(--series-1)', width: 2.2 });

  for (const frac of [0, 0.5, 1]) {
    f.plot.appendChild(el('text', {
      x: f.innerW + 6, y: f.y(frac * 100) + 3.5, 'text-anchor': 'start',
      fill: 'var(--series-1)', 'font-size': 10,
    }, (maxPrcp * frac).toFixed(1)));
  }
  f.plot.appendChild(el('text', {
    x: f.innerW + 6, y: -9, 'text-anchor': 'start',
    fill: 'var(--series-1)', 'font-size': 10,
  }, 'mm'));

  hourAxis(f, rows);

  return el(
    'div', { style: { marginTop: '18px' } },
    el('h2', { style: { fontSize: '13px', margin: '0 0 4px' } }, '1時間ごとの降水'),
    el('p', { class: 'note' },
      '棒が降水確率（左の目盛り）、線が降水量（右の目盛り）。'
      + '降水確率を出さないモデルがあるので、確率は一部のモデルだけの平均になる。'),
    legend([
      { label: '降水確率', color: 'var(--seq-250)', band: true },
      { label: '降水量', color: 'var(--series-1)' },
    ]),
    el('figure', { class: 'scroll-x' }, f.svg),
  );
}

function hourlyTip(r) {
  const dow = DOW_SHORT[new Date(`${r.date}T00:00:00+09:00`).getDay()];
  return {
    title: `${Number(r.date.slice(5, 7))}/${Number(r.date.slice(8, 10))}(${dow}) ${r.hour}時`,
    rows: [
      { k: '天気', v: describeCode(r.code).label },
      { k: '気温', v: `${fmt(r.temp, 1)}℃` },
      { k: '体感温度', v: `${fmt(r.feels, 1)}℃` },
      { k: '降水確率', v: r.pop === null ? '—' : `${fmt(r.pop, 0)}%` },
      { k: '降水量', v: `${fmt(r.prcp, 1)}mm` },
      { k: '湿度', v: `${fmt(r.rh, 0)}%` },
      { k: '風速', v: `${fmt(r.wind, 1)}m/s` },
      { k: '雲量', v: `${fmt(r.cloud, 0)}%` },
      { k: 'モデル間の開き', v: `${fmt(r.tempSpread, 1)}℃（${r.tempN}モデル）` },
    ],
  };
}

/** 3時間ごとの表。図から読み取れない値をここで見る */
function hourlyTable(rows) {
  const head = ['時刻', '天気', '気温', '体感', '降水確率', '降水量', '湿度', '風速'];
  const picked = rows.filter((r) => r.hour % 3 === 0);

  return el(
    'details', { class: 'table-view' },
    el('summary', {}, '3時間ごとの数値で見る'),
    el('div', { class: 'scroll-x' }, el(
      'table', {},
      el('thead', {}, el('tr', {}, head.map((h) => el('th', {}, h)))),
      el('tbody', {}, picked.map((r) => el(
        'tr', {},
        el('td', {}, `${Number(r.date.slice(8, 10))}日 ${r.hour}時`),
        el('td', { class: 'cell-weather' },
          weatherIcon({ code: r.code, size: 18 }),
          el('span', {}, describeCode(r.code).label)),
        el('td', {}, `${fmt(r.temp, 1)}℃`),
        el('td', {}, `${fmt(r.feels, 1)}℃`),
        el('td', {}, r.pop === null ? '—' : `${fmt(r.pop, 0)}%`),
        el('td', {}, `${fmt(r.prcp, 1)}mm`),
        el('td', {}, `${fmt(r.rh, 0)}%`),
        el('td', {}, `${fmt(r.wind, 1)}m/s`),
      ))),
    )),
  );
}

// ------------------------------------------------------------------ 気温

function temperaturePanel(days) {
  const all = [];
  for (const d of days) {
    for (const v of [d.tmax?.value, d.tmin?.value, d.tmaxInterval?.low, d.tmaxInterval?.high,
      d.tminInterval?.low, d.tminInterval?.high, d.normal?.tmax, d.normal?.tmin,
      d.jma?.tmax, d.jma?.tmin]) {
      if (v !== null && v !== undefined && Number.isFinite(v)) all.push(v);
    }
  }
  const scale = niceScale(Math.min(...all) - 0.5, Math.max(...all) + 0.5, 5);

  const f = frame({
    width: 760, height: 300,
    xDomain: [0, days.length - 1],
    yDomain: [scale.min, scale.max],
    label: '最高気温と最低気温の予報',
  });

  yAxis(f, scale.ticks, { format: (v) => `${v}`, unit: '℃' });

  // 予測区間の帯
  band(f, days.map((d, i) => ({ x: i, low: d.tmaxInterval?.low ?? null, high: d.tmaxInterval?.high ?? null })),
    { fill: 'var(--series-1)', opacity: 0.16 });
  band(f, days.map((d, i) => ({ x: i, low: d.tminInterval?.low ?? null, high: d.tminInterval?.high ?? null })),
    { fill: 'var(--series-1)', opacity: 0.16 });

  // 平年値
  line(f, days.map((d, i) => ({ x: i, y: d.normal?.tmax ?? null })),
    { stroke: 'var(--text-muted)', width: 1.5, dash: '3 3' });
  line(f, days.map((d, i) => ({ x: i, y: d.normal?.tmin ?? null })),
    { stroke: 'var(--text-muted)', width: 1.5, dash: '3 3' });

  // 気象庁
  line(f, days.map((d, i) => ({ x: i, y: d.jma?.tmax ?? null })),
    { stroke: 'var(--series-2)', width: 2, dash: '5 3' });
  line(f, days.map((d, i) => ({ x: i, y: d.jma?.tmin ?? null })),
    { stroke: 'var(--series-2)', width: 2, dash: '5 3' });

  // 自作の合議
  line(f, days.map((d, i) => ({ x: i, y: d.tmax?.value ?? null })), { stroke: 'var(--series-1)', width: 2.5 });
  line(f, days.map((d, i) => ({ x: i, y: d.tmin?.value ?? null })), { stroke: 'var(--series-1)', width: 2.5 });

  xAxisLabels(f, days, {
    every: days.length > 10 ? 2 : 1,
    format: (d) => fmtDate(d.date, { withDow: days.length <= 10 }),
  });

  crosshair(f, days, (i) => {
    const d = days[i];
    return {
      title: `${fmtDate(d.date)}  ${d.lead}日先の予報`,
      rows: [
        { k: '最高（合議）', v: `${fmt(d.tmax?.value, 1)}℃`, color: cssv('--series-1') },
        d.tmaxInterval ? { k: '  80%区間', v: `${fmt(d.tmaxInterval.low, 1)} 〜 ${fmt(d.tmaxInterval.high, 1)}℃` } : null,
        { k: '最低（合議）', v: `${fmt(d.tmin?.value, 1)}℃`, color: cssv('--series-1') },
        d.jma?.tmax !== null && d.jma?.tmax !== undefined
          ? { k: '気象庁 最高/最低', v: `${fmt(d.jma.tmax, 0)} / ${fmt(d.jma.tmin, 0)}℃`, color: cssv('--series-2') } : null,
        d.normal ? { k: '平年 最高/最低', v: `${fmt(d.normal.tmax, 1)} / ${fmt(d.normal.tmin, 1)}℃` } : null,
        { k: 'モデル間の開き', v: `${fmt(d.tmax?.spread, 1)}℃（${d.tmax?.available ?? 0}モデル）` },
        d.tmaxMae !== null ? { k: 'この日数の実績誤差', v: `±${fmt(d.tmaxMae, 1)}℃` } : null,
      ].filter(Boolean),
      footer: d.jma?.reliability ? `気象庁の信頼度: ${d.jma.reliability}` : null,
    };
  });

  return el(
    'section',
    { class: 'panel' },
    el('h2', {}, '気温の予報と、当たる幅'),
    el('p', { class: 'note' },
      '帯は80%予測区間。実測の8割がこの中に入るように、過去の誤差から幅を決めている。'
      + '先の日ほど帯が広がるのは、当たらなくなることを隠していないため。'),
    legend([
      { label: '自作の合議（補正済み）', color: 'var(--series-1)' },
      { label: '80%予測区間', color: 'var(--series-1)', band: true },
      { label: '気象庁', color: 'var(--series-2)', dash: true },
      { label: '平年値', color: 'var(--text-muted)', dash: true },
    ]),
    el('figure', { class: 'scroll-x' }, f.svg),
  );
}

// ------------------------------------------------------------------ 降水

function rainPanel(days) {
  const pops = days.map((d) => d.pop?.value ?? null);
  const f = frame({
    width: 760, height: 190,
    xDomain: [0, days.length - 1],
    yDomain: [0, 1],
    pad: { top: 22, right: 16, bottom: 26, left: 40 },
    label: '降水確率と降水量の予報',
  });

  yAxis(f, [0, 0.25, 0.5, 0.75, 1], { format: (v) => `${Math.round(v * 100)}`, unit: '%' });

  bars(f, days.map((d, i) => ({
    x: i,
    value: d.pop?.value ?? null,
    tip: {
      title: `${fmtDate(d.date)}  ${d.lead}日先`,
      rows: [
        { k: '降水確率（自作）', v: fmtPct(d.pop?.value), color: cssv('--series-1') },
        d.jma?.pop !== null && d.jma?.pop !== undefined
          ? { k: '降水確率（気象庁）', v: fmtPct(d.jma.pop), color: cssv('--series-2') } : null,
        { k: '降水量', v: `${fmt(d.prcp?.value, 1)}mm` },
        { k: '天気', v: describeCode(d.code ?? d.jma?.code).label },
      ].filter(Boolean),
      footer: d.pop?.method === 'logistic' ? '実測で較正した確率' : 'アンサンブル比率（未較正）',
    },
  })), { color: 'var(--series-1)' });

  // 気象庁の降水確率は点で重ねる。棒と点で形が違うので色だけに頼らない
  const jmaPts = days.map((d, i) => ({ x: i, y: d.jma?.pop ?? null }));
  line(f, jmaPts, { stroke: 'var(--series-2)', width: 2, dash: '5 3' });

  refLine(f, 0.5, { label: '' });
  xAxisLabels(f, days, {
    every: days.length > 10 ? 2 : 1,
    format: (d) => fmtDate(d.date, { withDow: false }),
  });

  const calibrated = days.some((d) => d.pop?.method === 'logistic');

  return el(
    'section',
    { class: 'panel' },
    el('h2', {}, '降水確率'),
    el('p', { class: 'note' },
      calibrated
        ? 'アンサンブルの降水メンバー比率を、実測でロジスティック回帰にかけ直した確率。'
          + '「60%と言った日の6割で実際に降る」ようにしてある。'
        : 'いまはアンサンブルの降水メンバー比率をそのまま出している。実測が貯まると較正がかかる。'),
    legend([
      { label: '自作（較正後）', color: 'var(--series-1)', band: true },
      { label: '気象庁', color: 'var(--series-2)', dash: true },
    ]),
    el('figure', { class: 'scroll-x' }, f.svg),
  );
}

// ------------------------------------------------------------------ 表

function tablePanel(days) {
  const head = ['日付', '先何日', '天気', '最高', '80%区間', '最低', '降水確率', '降水量', '実績誤差', '気象庁 最高/最低', '信頼度'];
  return el(
    'section',
    { class: 'panel' },
    el('h2', {}, '数値で見る'),
    el('p', { class: 'note' },
      '実績誤差は、その日数先の予報が過去にどれだけ外したかの平均。前向き検証の値。'),
    el('div', { class: 'scroll-x' }, el(
      'table',
      {},
      el('thead', {}, el('tr', {}, head.map((h) => el('th', {}, h)))),
      el('tbody', {}, days.map((d) => {
        const icon = iconForDay(d, { size: 20 });
        return el(
        'tr',
        { class: d.lead === 0 ? 'highlight' : null },
        el('td', {}, fmtDate(d.date)),
        el('td', {}, `${d.lead}日`),
        el('td', { class: 'cell-weather' }, icon.node, el('span', {}, icon.label)),
        el('td', {}, `${fmt(d.tmax?.value, 1)}℃`),
        el('td', {}, d.tmaxInterval ? `${fmt(d.tmaxInterval.low, 1)}〜${fmt(d.tmaxInterval.high, 1)}` : '—'),
        el('td', {}, `${fmt(d.tmin?.value, 1)}℃`),
        el('td', {}, fmtPct(d.pop?.value)),
        el('td', {}, `${fmt(d.prcp?.value, 1)}mm`),
        el('td', {}, d.tmaxMae !== null ? `±${fmt(d.tmaxMae, 1)}℃` : '—'),
        el('td', {}, d.jma?.tmax !== null && d.jma?.tmax !== undefined
          ? `${fmt(d.jma.tmax, 0)} / ${fmt(d.jma.tmin, 0)}` : '—'),
        el('td', {}, d.jma?.reliability ?? '—'),
        );
      })),
    )),
  );
}

function cssv(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
}
