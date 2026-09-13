// 「現在の天気の詳細」。ボタンを押したときだけ、その場で取りに行く。
//
// ここだけは予報ではなく**実際に観測された値**を出す。
// 気象庁アメダスの10分値を直近6時間ぶん読み、気温・降水・風・湿度・日照の流れを見せる。
// 予報が当たっているかを今この瞬間に確かめられる、というのがこの画面の役目。
//
// 保存はしない。開いた時点の実況を見るためのもので、履歴は data/obs の日別値が担う。
// 取得はブラウザから直接。気象庁も Open-Meteo も CORS を許可している。
import { el, replace, fmt, fmtPct } from './dom.js';
import { weatherIcon, describeCode, inferKind, KIND_LABEL } from './weather-icon.js';
import {
  frame, yAxis, xAxisLabels, line, bars, niceScale, legend, crosshair,
} from './chart-svg.js';

const AMEDAS = 'https://www.jma.go.jp/bosai/amedas/data';
const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';

/** 何時間ぶん遡るか */
const HOURS_BACK = 6;

/** 観測値は [値, 品質フラグ] の形で来る。0 以外は使わない */
function val(entry, key) {
  const v = entry?.[key];
  if (!Array.isArray(v)) return null;
  const [value, flag] = v;
  if (value === null || value === undefined) return null;
  if (flag !== 0) return null;
  return value;
}

/** 'YYYYMMDDhhmmss' を Date に直す。アメダスの時刻は JST */
function parseStamp(stamp) {
  return new Date(
    `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`
    + `T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:00+09:00`,
  );
}

const pad = (n) => String(n).padStart(2, '0');

/** アメダスのファイルは3時間ごと。遡る時間ぶんのファイル名を並べる */
function fileKeys(latest, hoursBack) {
  const keys = [];
  // 3時間の区切りに丸めてから、必要な数だけ戻る
  const base = new Date(latest);
  base.setMinutes(0, 0, 0);
  const blocks = Math.ceil(hoursBack / 3) + 1;
  for (let i = 0; i < blocks; i++) {
    const t = new Date(base.getTime() - i * 3 * 3600_000);
    // JST での年月日と3時間ブロック
    const j = new Date(t.getTime() + 9 * 3600_000);
    const hh = Math.floor(j.getUTCHours() / 3) * 3;
    keys.push(
      `${j.getUTCFullYear()}${pad(j.getUTCMonth() + 1)}${pad(j.getUTCDate())}_${pad(hh)}`,
    );
  }
  return [...new Set(keys)].reverse();
}

/**
 * アメダスの10分値を直近 N 時間ぶん取る。
 * @returns {Promise<{rows:Array, latest:Date}>}
 */
export async function fetchAmedasRecent(code, { hoursBack = HOURS_BACK } = {}) {
  const text = await (await fetchOrThrow(`${AMEDAS}/latest_time.txt`)).text();
  const latest = new Date(text.trim());
  if (Number.isNaN(latest.getTime())) throw new Error('最新観測時刻を読めなかった');

  const since = latest.getTime() - hoursBack * 3600_000;
  const rows = [];

  for (const key of fileKeys(latest, hoursBack)) {
    let data;
    try {
      data = await (await fetchOrThrow(`${AMEDAS}/point/${code}/${key}.json`)).json();
    } catch {
      // 日付をまたぐと存在しないファイルがある。そこは飛ばす
      continue;
    }
    for (const [stamp, entry] of Object.entries(data)) {
      const at = parseStamp(stamp);
      if (at.getTime() < since || at.getTime() > latest.getTime()) continue;
      rows.push({
        at,
        stamp,
        temp: val(entry, 'temp'),
        humidity: val(entry, 'humidity'),
        wind: val(entry, 'wind'),
        windDirection: val(entry, 'windDirection'),
        // gust はその日のここまでの最大瞬間風速。10分ごとの観測値ではないので、
        // 時系列の線にしてはいけない。別枠で1つの数字として出す
        gust: val(entry, 'gust'),
        gustTime: entry?.gustTime ?? null,
        gustDirection: val(entry, 'gustDirection'),
        maxTemp: val(entry, 'maxTemp'),
        minTemp: val(entry, 'minTemp'),
        prcp10m: val(entry, 'precipitation10m'),
        prcp1h: val(entry, 'precipitation1h'),
        sun10m: val(entry, 'sun10m'),
        pressure: val(entry, 'pressure'),
        normalPressure: val(entry, 'normalPressure'),
      });
    }
  }

  rows.sort((a, b) => a.at - b.at);
  if (rows.length === 0) throw new Error('この観測所の直近の値が取れなかった');
  return { rows, latest };
}

/** 押した瞬間の天気コードと気温。アメダスは天気を出さないので、こちらで補う */
export async function fetchCurrent(loc) {
  const url = `${OPEN_METEO}?latitude=${loc.lat}&longitude=${loc.lon}`
    + '&timezone=Asia%2FTokyo&wind_speed_unit=ms'
    + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,'
    + 'precipitation,weather_code,wind_speed_10m,wind_direction_10m,cloud_cover,is_day';
  const data = await (await fetchOrThrow(url)).json();
  if (!data?.current) throw new Error('現在の天気を読めなかった');
  return data.current;
}

async function fetchOrThrow(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`${url.split('/').pop()} が取れなかった (HTTP ${res.status})`);
  return res;
}

const DIRS = ['静穏', '北北東', '北東', '東北東', '東', '東南東', '南東', '南南東',
  '南', '南南西', '南西', '西南西', '西', '西北西', '北西', '北北西', '北'];

/** アメダスの風向は 0〜16 の整数。0 は静穏 */
function windDirName(v) {
  if (v === null || v === undefined) return '—';
  return DIRS[Math.round(v)] ?? '—';
}

function timeLabel(d) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ------------------------------------------------------------------ 表示

/**
 * 実況を描く。
 * @param {HTMLElement} container 差し替え先
 * @param {object} loc meta.json の地点
 */
export async function renderLive(container, loc) {
  replace(container, el('p', { class: 'empty' }, '観測値を取りに行っている…'));

  const code = loc.station?.amedasCode;
  if (!code) {
    replace(container, el('p', { class: 'caveat serious' },
      'この地点にはアメダスの観測所番号が対応づいていない。実況は取れない。'));
    return;
  }

  // 片方が落ちても、取れた方だけで描く
  const [amedas, current] = await Promise.allSettled([
    fetchAmedasRecent(code),
    fetchCurrent(loc),
  ]);

  if (amedas.status === 'rejected' && current.status === 'rejected') {
    replace(container, el('p', { class: 'caveat serious' },
      `実況を取れなかった: ${amedas.reason.message}`),
    el('p', { class: 'note' }, 'オフラインか、気象庁側の仕様が変わった可能性がある。'));
    return;
  }

  const parts = [];
  const cur = current.status === 'fulfilled' ? current.value : null;
  const obs = amedas.status === 'fulfilled' ? amedas.value : null;

  parts.push(nowPanel(cur, obs, loc));
  if (obs) {
    parts.push(...seriesPanels(obs));
    parts.push(tablePanel(obs));
  } else {
    parts.push(el('p', { class: 'caveat' },
      `直近6時間の観測値は取れなかった: ${amedas.reason.message}`));
  }
  replace(container, ...parts);
}

/** 今この瞬間 */
function nowPanel(cur, obs, loc) {
  const last = obs?.rows.at(-1) ?? null;
  const tiles = [];

  const kind = cur
    ? describeCode(cur.weather_code)
    : { kind: inferKind({ prcp: last?.prcp1h ?? null }), label: null };
  const name = kind.label ?? KIND_LABEL[kind.kind];

  tiles.push(el(
    'div', { class: 'tile tile-weather' },
    el('span', { class: 'label' }, '今の天気'),
    el('div', { class: 'weather-row' },
      weatherIcon({ code: cur?.weather_code ?? null, kind: cur ? null : kind.kind, size: 40, label: name }),
      el('span', { class: 'weather-name' }, name)),
    el('div', { class: 'sub' }, cur ? 'モデルの現在値' : '降水量からの推定'),
  ));

  // 気温は観測所の実測を優先する。モデルの現在値は推定にすぎない
  if (last?.temp !== null && last?.temp !== undefined) {
    tiles.push(tile('気温（実測）', fmt(last.temp, 1), '℃',
      `${loc.station.name} ${timeLabel(last.at)} の観測`));
  } else if (cur) {
    tiles.push(tile('気温（推定）', fmt(cur.temperature_2m, 1), '℃', 'モデルの現在値'));
  }

  if (last?.humidity !== null && last?.humidity !== undefined) {
    tiles.push(tile('湿度（実測）', fmt(last.humidity, 0), '%', `${timeLabel(last.at)} の観測`));
  }
  if (last?.wind !== null && last?.wind !== undefined) {
    tiles.push(tile('風（実測）', fmt(last.wind, 1), 'm/s',
      `${windDirName(last.windDirection)}の風。10分間の平均`));
  }
  if (last?.gust !== null && last?.gust !== undefined) {
    const t = last.gustTime;
    const when = t && t.hour !== null ? `${pad(t.hour)}:${pad(t.minute ?? 0)}` : null;
    tiles.push(tile('今日の最大瞬間風速', fmt(last.gust, 1), 'm/s',
      when ? `${when} に観測。${windDirName(last.gustDirection)}の風` : '今日ここまでの最大'));
  }

  const rain6h = obs ? sumOf(obs.rows, 'prcp10m') : null;
  tiles.push(tile('直近6時間の降水', fmt(rain6h, 1), 'mm',
    last?.prcp1h !== null && last?.prcp1h !== undefined
      ? `直近1時間は ${fmt(last.prcp1h, 1)}mm` : '10分値の合計'));

  if (last?.pressure !== null && last?.pressure !== undefined) {
    const diff = last.normalPressure !== null ? last.pressure - last.normalPressure : null;
    tiles.push(tile('気圧（実測）', fmt(last.pressure, 1), 'hPa',
      diff !== null ? `平年より ${diff > 0 ? '+' : ''}${fmt(diff, 1)}hPa` : ''));
  }

  return el(
    'div', {},
    el('div', { class: 'tiles' }, tiles),
    el('p', { class: 'note' },
      `観測所は${loc.station.name}（地点から ${fmt(loc.station.distanceKm, 1)}km）。`
      + (obs ? `最新の観測は ${timeLabel(obs.latest)}。10分ごとに更新される。` : '')),
  );
}

function tile(label, value, unit, sub) {
  return el(
    'div', { class: 'tile' },
    el('span', { class: 'label' }, label),
    el('div', {}, el('span', { class: 'value' }, value), unit ? el('span', { class: 'unit' }, unit) : null),
    el('div', { class: 'sub' }, sub),
  );
}

function sumOf(rows, key) {
  const v = rows.map((r) => r[key]).filter((x) => x !== null && Number.isFinite(x));
  return v.length ? Math.round(v.reduce((s, x) => s + x, 0) * 10) / 10 : null;
}

/** 気温と風、降水の6時間の流れ */
function seriesPanels(obs) {
  const rows = obs.rows;
  const out = [];

  // --- 気温と湿度
  const temps = rows.map((r) => r.temp).filter((v) => v !== null);
  if (temps.length >= 2) {
    const scale = niceScale(Math.min(...temps) - 0.5, Math.max(...temps) + 0.5, 4);
    const f = frame({
      width: 720, height: 200,
      pad: { top: 22, right: 16, bottom: 28, left: 42 },
      xDomain: [0, rows.length - 1],
      yDomain: [scale.min, scale.max],
      label: '直近6時間の気温',
    });
    yAxis(f, scale.ticks, { format: (v) => `${v}`, unit: '℃' });
    line(f, rows.map((r, i) => ({ x: i, y: r.temp })), { stroke: 'var(--series-1)', width: 2.4 });
    xAxisLabels(f, rows, {
      every: Math.max(1, Math.round(rows.length / 7)),
      format: (r) => timeLabel(r.at),
    });
    crosshair(f, rows, (i) => tipFor(rows[i]));

    out.push(el(
      'section', { class: 'panel' },
      el('h2', {}, '気温の6時間'),
      el('p', { class: 'note' }, '10分ごとの観測値。予報ではなく、実際に観測された気温。'),
      el('figure', { class: 'scroll-x' }, f.svg),
    ));
  }

  // --- 降水
  const rain = rows.map((r) => r.prcp10m).filter((v) => v !== null);
  if (rain.length >= 2) {
    const maxRain = Math.max(...rain, 0.5);
    const scale = niceScale(0, maxRain * 1.15, 4);
    const f = frame({
      width: 720, height: 170,
      pad: { top: 22, right: 16, bottom: 28, left: 52 },
      xDomain: [0, rows.length - 1],
      yDomain: [scale.min, scale.max],
      label: '直近6時間の降水量',
    });
    yAxis(f, scale.ticks, { format: (v) => `${v}`, unit: 'mm' });
    bars(f, rows.map((r, i) => ({ x: i, value: r.prcp10m, tip: tipFor(r) })),
      { color: 'var(--series-1)', gap: 1 });
    xAxisLabels(f, rows, {
      every: Math.max(1, Math.round(rows.length / 7)),
      format: (r) => timeLabel(r.at),
    });

    const total = sumOf(rows, 'prcp10m');
    out.push(el(
      'section', { class: 'panel' },
      el('h2', {}, '降水の6時間'),
      el('p', { class: 'note' },
        total > 0
          ? `10分ごとの降水量（mm）。合計 ${fmt(total, 1)}mm。棒が無い時間は降っていない。`
          : '10分ごとの降水量（mm）。この6時間は降っていない。'),
      el('figure', { class: 'scroll-x' }, f.svg),
    ));
  }

  // --- 風
  const winds = rows.map((r) => r.wind).filter((v) => v !== null);
  if (winds.length >= 2) {
    const scale = niceScale(0, Math.max(...winds, 1) * 1.2, 4);
    const f = frame({
      width: 720, height: 170,
      pad: { top: 22, right: 16, bottom: 28, left: 42 },
      xDomain: [0, rows.length - 1],
      yDomain: [scale.min, scale.max],
      label: '直近6時間の風速',
    });
    yAxis(f, scale.ticks, { format: (v) => `${v}`, unit: 'm/s' });
    line(f, rows.map((r, i) => ({ x: i, y: r.wind })), { stroke: 'var(--series-1)', width: 2.4 });
    xAxisLabels(f, rows, {
      every: Math.max(1, Math.round(rows.length / 7)),
      format: (r) => timeLabel(r.at),
    });
    crosshair(f, rows, (i) => tipFor(rows[i]));

    out.push(el(
      'section', { class: 'panel' },
      el('h2', {}, '風の6時間'),
      el('p', { class: 'note' },
        '10分間の平均風速。'
        + 'アメダスの最大瞬間風速はその日の最大値なので、時系列にはならない。上の札に出してある。'),
      el('figure', { class: 'scroll-x' }, f.svg),
    ));
  }

  return out;
}

function tipFor(r) {
  return {
    title: `${timeLabel(r.at)} の観測`,
    rows: [
      r.temp !== null ? { k: '気温', v: `${fmt(r.temp, 1)}℃` } : null,
      r.humidity !== null ? { k: '湿度', v: `${fmt(r.humidity, 0)}%` } : null,
      r.prcp10m !== null ? { k: '降水（10分）', v: `${fmt(r.prcp10m, 1)}mm` } : null,
      r.prcp1h !== null ? { k: '降水（1時間）', v: `${fmt(r.prcp1h, 1)}mm` } : null,
      r.wind !== null ? { k: '風速', v: `${fmt(r.wind, 1)}m/s ${windDirName(r.windDirection)}` } : null,
      r.sun10m !== null ? { k: '日照（10分）', v: `${fmt(r.sun10m, 0)}分` } : null,
      r.pressure !== null ? { k: '気圧', v: `${fmt(r.pressure, 1)}hPa` } : null,
    ].filter(Boolean),
  };
}

/** 生の観測値。グラフで読めない細かい値はここで見る */
function tablePanel(obs) {
  // 新しい順に見たいはず
  const rows = [...obs.rows].reverse();
  const head = ['時刻', '気温', '湿度', '降水(10分)', '降水(1時間)', '風速', '風向', '日照'];

  return el(
    'section', { class: 'panel' },
    el('h2', {}, '10分ごとの観測値'),
    el('p', { class: 'note' }, '新しい順。品質が確かでない値は空欄にしてある。'),
    el('div', { class: 'scroll-x', style: { maxHeight: '420px', overflowY: 'auto' } }, el(
      'table', {},
      el('thead', {}, el('tr', {}, head.map((h) => el('th', {}, h)))),
      el('tbody', {}, rows.map((r) => el(
        'tr', {},
        el('td', {}, timeLabel(r.at)),
        el('td', {}, r.temp !== null ? `${fmt(r.temp, 1)}℃` : '—'),
        el('td', {}, r.humidity !== null ? `${fmt(r.humidity, 0)}%` : '—'),
        el('td', {}, r.prcp10m !== null ? `${fmt(r.prcp10m, 1)}` : '—'),
        el('td', {}, r.prcp1h !== null ? `${fmt(r.prcp1h, 1)}` : '—'),
        el('td', {}, r.wind !== null ? `${fmt(r.wind, 1)}` : '—'),
        el('td', {}, windDirName(r.windDirection)),
        el('td', {}, r.sun10m !== null ? `${fmt(r.sun10m, 0)}分` : '—'),
      ))),
    )),
  );
}

export { fileKeys, val, parseStamp, windDirName, timeLabel };
