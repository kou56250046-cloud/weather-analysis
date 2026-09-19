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
  frame, yAxis, line, bars, dots, niceScale, legend, crosshair,
} from './chart-svg.js';

const AMEDAS = 'https://www.jma.go.jp/bosai/amedas/data';
const OPEN_METEO = 'https://api.open-meteo.com/v1/forecast';

/** 何時間ぶん遡るか */
const HOURS_BACK = 6;
/** 何時間先まで出すか */
const HOURS_AHEAD = 6;

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
  base.setUTCMinutes(0, 0, 0);
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

/**
 * 押した瞬間の天気コードと気温。アメダスは天気を出さないので、こちらで補う。
 * この先の時間別予報も同じ呼び出しで取る。通信を増やさない。
 * @returns {Promise<{current:object, hourly:object|Array}>}
 */
export async function fetchCurrent(loc) {
  const url = `${OPEN_METEO}?latitude=${loc.lat}&longitude=${loc.lon}`
    + '&timezone=Asia%2FTokyo&wind_speed_unit=ms'
    + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,'
    + 'precipitation,weather_code,wind_speed_10m,wind_direction_10m,cloud_cover,is_day'
    + `&hourly=${HOURLY_KEYS.join(',')}`
    // 現在の正時から数える。アメダスの遅れに備えて多めに取り、後で6本に切る
    + `&forecast_hours=${HOURS_AHEAD + 4}`;
  return splitForecast(await (await fetchOrThrow(url)).json());
}

const HOURLY_KEYS = [
  'temperature_2m', 'precipitation', 'precipitation_probability',
  'weather_code', 'wind_speed_10m', 'wind_direction_10m',
];

/** 現在値と時間別に分ける。時間別が壊れていても現在値は使う */
function splitForecast(data) {
  if (!data?.current) throw new Error('現在の天気を読めなかった');
  const h = data.hourly;
  const ok = Array.isArray(h?.time)
    && HOURLY_KEYS.every((k) => Array.isArray(h[k]) && h[k].length === h.time.length);
  return { current: data.current, hourly: ok ? h : [] };
}

/** Open-Meteo の時刻は timezone=Asia/Tokyo の壁時計。'YYYY-MM-DDThh:mm' を JST として読む */
function parseLocal(s) {
  const d = new Date(`${s}:00+09:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 度（0〜360）をアメダスと同じ 1〜16 の方位番号に直す。北が 16 */
function degToDir16(deg) {
  if (deg === null || deg === undefined || !Number.isFinite(deg)) return null;
  const n = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
  return n === 0 ? 16 : n;
}

/**
 * 時間別予報を行に直し、after より後を先頭から count 本返す。
 * 足りなければ取れた分だけ返す。欠けた値は null のまま。
 */
function nextHours(hourly, after, count = HOURS_AHEAD) {
  const times = hourly?.time;
  if (!Array.isArray(times) || !after) return [];
  const num = (k, i) => {
    const v = hourly[k]?.[i];
    return v === null || v === undefined || !Number.isFinite(v) ? null : v;
  };
  const out = [];
  for (let i = 0; i < times.length && out.length < count; i++) {
    const at = parseLocal(times[i]);
    if (!at || at <= after) continue;
    out.push({
      at,
      temp: num('temperature_2m', i),
      prcp: num('precipitation', i),
      pop: num('precipitation_probability', i),
      code: num('weather_code', i),
      wind: num('wind_speed_10m', i),
      // 風速 0 はアメダスと同じく静穏（0）にする。方位を出さない
      windDirection: num('wind_speed_10m', i) === 0 ? 0 : degToDir16(num('wind_direction_10m', i)),
    });
  }
  return out;
}

/** 気象庁「雨雲の動き」を地点付近で開くリンク先。座標は小数3桁に丸める */
function radarUrl(loc) {
  return 'https://www.jma.go.jp/bosai/nowc/'
    + `#zoom:10/lat:${loc.lat.toFixed(3)}/lon:${loc.lon.toFixed(3)}`
    + '/colordepth:normal/elements:hrpns&slmcs';
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

/** 時刻を JST の hh:mm で出す。ブラウザのタイムゾーンに依らない */
function timeLabel(d) {
  const j = new Date(d.getTime() + 9 * 3600_000);
  return `${pad(j.getUTCHours())}:${pad(j.getUTCMinutes())}`;
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
    el('p', { class: 'note' }, 'オフラインか、気象庁側の仕様が変わった可能性がある。'),
    radarLink(loc));
    return;
  }

  const parts = [];
  const cur = current.status === 'fulfilled' ? current.value.current : null;
  const obs = amedas.status === 'fulfilled' ? amedas.value : null;
  // 起点は最新の観測時刻。アメダスが取れなければモデルの現在時刻
  const after = obs?.latest ?? (cur ? parseLocal(cur.time) : null);
  const fc = current.status === 'fulfilled' ? nextHours(current.value.hourly, after) : [];

  parts.push(nowPanel(cur, obs, loc));
  parts.push(nextPanel(fc, loc));
  if (obs) {
    parts.push(...seriesPanels(obs, fc));
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
      decorative(weatherIcon({ code: cur?.weather_code ?? null, kind: cur ? null : kind.kind, size: 40, label: name })),
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

/** この先6時間。1時間ごとの札を並べる */
function nextPanel(fc, loc) {
  if (fc.length === 0) {
    return el(
      'section', { class: 'panel' },
      el('h2', {}, 'この先6時間'),
      el('p', { class: 'caveat' }, 'この先の予報は取れなかった。'),
      radarLink(loc),
    );
  }

  const tiles = fc.map((r) => {
    const known = r.code !== null;
    // コードが無い時間は降水量と確率から推定する。確率は 0〜1 で渡す。
    // どちらも無ければ材料が無いので推定しない（晴れに化けさせない）
    const guessable = r.prcp !== null || r.pop !== null;
    const kind = known || !guessable
      ? describeCode(r.code)
      : { kind: inferKind({ prcp: r.prcp, pop: r.pop !== null ? r.pop / 100 : null }), label: null };
    const name = (kind.label ?? KIND_LABEL[kind.kind]) + (known || !guessable ? '' : '（推定）');
    return el(
      'div', { class: 'tile tile-weather' },
      el('span', { class: 'label' }, `${timeLabel(r.at)} の予報`),
      el('div', { class: 'weather-row' },
        decorative(weatherIcon({ code: r.code, kind: known ? null : kind.kind, size: 32, label: name })),
        el('span', { class: 'weather-name' }, name)),
      el('div', {},
        el('span', { class: 'value' }, fmt(r.temp, 1)), el('span', { class: 'unit' }, '℃')),
      // Open-Meteo の降水量はその時刻までの1時間の合計
      el('div', { class: 'sub' },
        `降水 ${fmt(r.prcp, 1)}mm（前1時間）・確率 ${r.pop !== null ? `${fmt(r.pop, 0)}%` : '—'}`),
      el('div', { class: 'sub' }, `風 ${fmt(r.wind, 1)}m/s ${windDirName(r.windDirection)}`),
    );
  });

  return el(
    'section', { class: 'panel' },
    el('h2', {}, 'この先6時間'),
    el('p', { class: 'note' },
      'Open-Meteo の既定モデルによる1時間ごとの予報。'
      + '統計補正はしていないので、予報タブの値とは少し食い違う。'
      + (fc.length < HOURS_AHEAD ? `${fc.length}時間分だけ取れた。` : '')),
    el('div', { class: 'tiles' }, tiles),
    rainChartable(fc) ? rainChart(fc) : null,
    radarLink(loc),
  );
}

// ------------------------------------------------------------------ この先の降水

const isNum = (v) => v !== null && v !== undefined && Number.isFinite(v);

/** 降水量の縦軸。降っていなくても軸が潰れないよう最小 1mm */
function rainScaleMax(fc) {
  const prcps = fc.map((r) => r.prcp).filter(isNum);
  return niceScale(0, Math.max(...prcps, 1) * 1.15, 4);
}

/** 降水量か確率のどちらかが数値の枠が2つ以上あるときだけ描く */
function rainChartable(fc) {
  return fc.filter((r) => isNum(r.prcp) || isNum(r.pop)).length >= 2;
}

/**
 * この先の降水。降水量は棒（左軸 mm）、降水確率は線（右軸 %）。
 * 横軸を [-0.5, n-0.5] にして、f.x(i) を棒の枠の中央に合わせる。
 * 棒・点・目盛り・カーソルが同じ x に来る。
 * 二軸は読み違えやすいので、グリッドは mm からだけ引き、右軸は文字だけにして線と同じ色にする。
 */
function rainChart(fc) {
  const n = fc.length;
  const scale = rainScaleMax(fc);
  const f = frame({
    width: 720, height: 180,
    pad: { top: 22, right: 44, bottom: 28, left: 42 },
    xDomain: [-0.5, n - 0.5],
    yDomain: [scale.min, scale.max],
    label: 'この先6時間の降水量と降水確率',
  });
  yAxis(f, scale.ticks, { format: (v) => `${v}` });
  f.plot.appendChild(el('text', {
    x: -8, y: -9, 'text-anchor': 'end', fill: 'var(--series-1)', 'font-size': 10,
  }, 'mm'));

  // 右軸。確率 0〜100 を mm の軸の高さに写す
  const popY = (p) => (p / 100) * scale.max;
  for (const t of [0, 25, 50, 75, 100]) {
    f.plot.appendChild(el('text', {
      x: f.innerW + 8, y: f.y(popY(t)) + 3.5, 'text-anchor': 'start',
      fill: 'var(--series-3)', 'font-size': 10.5,
    }, `${t}`));
  }
  f.plot.appendChild(el('text', {
    x: f.innerW + 8, y: -9, 'text-anchor': 'start', fill: 'var(--series-3)', 'font-size': 10,
  }, '%'));

  // 棒。0 は細い線、null は描かずに「—」を置く（降らないのではなく分からない）
  // 棒は枠の半分強の幅。太すぎると点と線が埋もれる
  bars(f, fc.map((r, i) => ({ x: i, value: r.prcp })), { color: 'var(--series-1)', gap: (f.innerW / n) * 0.45 });
  fc.forEach((r, i) => {
    if (isNum(r.prcp)) return;
    f.plot.appendChild(el('text', {
      x: f.x(i), y: f.innerH - 4, 'text-anchor': 'middle',
      fill: 'var(--text-muted)', 'font-size': 11,
    }, '—'));
  });

  const pts = fc.map((r, i) => ({ x: i, y: isNum(r.pop) ? popY(r.pop) : null }));
  line(f, pts, { stroke: 'var(--series-3)', width: 2 });
  dots(f, pts, { color: 'var(--series-3)', r: 3.5 });

  // 目盛りは札の時刻
  const g = el('g');
  fc.forEach((r, i) => {
    g.appendChild(el('text', {
      x: f.x(i), y: f.innerH + 16, 'text-anchor': 'middle',
      fill: 'var(--text-muted)', 'font-size': 10.5,
    }, timeLabel(r.at)));
  });
  f.plot.appendChild(g);
  crosshair(f, fc, (i) => fcTipFor(fc[i]));

  return el(
    'div', {},
    el('h3', {}, '降水 1時間ごと（予報）'),
    el('p', { class: 'note' },
      '棒はその時刻までの1時間の降水量。最初の棒の時間帯は、一部が下の実測と重なる。統計補正はしていない。'),
    legend([
      { label: '降水量（前1時間, mm）', color: 'var(--series-1)' },
      { label: '降水確率（%）', color: 'var(--series-3)' },
    ]),
    el('figure', { class: 'scroll-x' }, f.svg),
  );
}

/** 雨雲の動きは気象庁のページで見てもらう。レーダーは自前で描かない */
function radarLink(loc) {
  return el('p', { class: 'note' },
    el('a', { href: radarUrl(loc), target: '_blank', rel: 'noopener' },
      '気象庁 雨雲の動き（この地点付近・別タブで開く）'),
    ' で雨雲レーダーを見られる。');
}

/** 隣に名前を書いてあるアイコンは読み上げない。同じ名前が2回読まれるため */
function decorative(icon) {
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

function sumOf(rows, key) {
  const v = rows.map((r) => r[key]).filter((x) => x !== null && Number.isFinite(x));
  return v.length ? Math.round(v.reduce((s, x) => s + x, 0) * 10) / 10 : null;
}

/**
 * 実測（10分値）と予報（正時）を同じ横軸に並べる。
 * 横軸は最初の観測からの10分刻みの番号。実測も予報も時刻から番号を振る。
 * アメダスのファイルが1本取れないと行が抜けるので、行の順番では置かない。
 * 抜けた枠は obs が null になり、線はそこで切れる。
 */
function timeline(rows, fc) {
  const t0 = rows[0].at.getTime();
  const idx = (at) => Math.round((at.getTime() - t0) / 600_000);
  const nowIdx = idx(rows.at(-1).at);
  const fcAt = fc.map((r) => ({ ...r, i: idx(r.at) }));
  const last = fcAt.length ? fcAt.at(-1).i : nowIdx;
  const byIdx = new Map(rows.map((r) => [idx(r.at), r]));
  const slots = [];
  for (let i = 0; i <= last; i++) {
    slots.push({ at: new Date(t0 + i * 600_000), obs: byIdx.get(i) ?? null });
  }
  return { slots, fcAt, nowIdx };
}

/** 実測の点。抜けた枠は null にして線を切る */
function obsPoints(tl, key) {
  return tl.slots.slice(0, tl.nowIdx + 1).map((s, i) => ({ x: i, y: s.obs ? s.obs[key] : null }));
}

/**
 * 横軸の目盛り。正時に置く。
 * 札の時刻と揃えるため、10分刻みの半端な時刻には置かない。予報の終わりの正時にも必ず付く。
 */
function timeAxis(f, slots) {
  const g = el('g');
  slots.forEach((s, i) => {
    if (s.at.getUTCMinutes() !== 0) return; // JST と UTC は整数時間ずれるので、分は同じ
    g.appendChild(el('text', {
      x: f.x(i), y: f.innerH + 16, 'text-anchor': 'middle',
      fill: 'var(--text-muted)', 'font-size': 10.5,
    }, timeLabel(s.at)));
  });
  g.appendChild(el('line', {
    x1: 0, x2: f.innerW, y1: f.innerH, y2: f.innerH,
    stroke: 'var(--axis)', 'stroke-width': 1,
  }));
  f.plot.appendChild(g);
}

/** カーソルの札。実測の枠は観測値、未来側はいちばん近い正時の予報。抜けた枠は出さない */
function slotTip(tl, i) {
  const s = tl.slots[i];
  if (s.obs) return tipFor(s.obs);
  if (i <= tl.nowIdx) return null;
  let best = null;
  for (const r of tl.fcAt) {
    if (!best || Math.abs(r.i - i) < Math.abs(best.i - i)) best = r;
  }
  return best ? fcTipFor(best) : null;
}

/** 最新の観測時刻に「現在」の印を付ける */
function nowMark(f, idx) {
  f.plot.appendChild(el('line', {
    x1: f.x(idx), x2: f.x(idx), y1: 0, y2: f.innerH,
    stroke: 'var(--series-2)', 'stroke-width': 2, 'stroke-dasharray': '3 3',
  }));
  f.plot.appendChild(el('text', {
    x: f.x(idx), y: -8, 'text-anchor': 'middle',
    fill: 'var(--series-2)', 'font-size': 10.5, 'font-weight': 600,
  }, '現在'));
}

/**
 * 実測と予報を並べる折れ線。予報が無ければ実測だけ。
 * 縦軸は両方の値から決める。破線が枠からはみ出さないように。
 */
function timelineChart(obs, fc, { key, unit, zeroBased = false, label }) {
  const tl = timeline(obs.rows, fc);
  const values = [...obs.rows.map((r) => r[key]), ...fc.map((r) => r[key])]
    .filter((v) => v !== null && Number.isFinite(v));
  const scale = zeroBased
    ? niceScale(0, Math.max(...values, 1) * 1.2, 4)
    : niceScale(Math.min(...values) - 0.5, Math.max(...values) + 0.5, 4);
  const f = frame({
    width: 720, height: zeroBased ? 170 : 200,
    pad: { top: 22, right: 16, bottom: 28, left: 42 },
    xDomain: [0, tl.slots.length - 1],
    yDomain: [scale.min, scale.max],
    label,
  });
  yAxis(f, scale.ticks, { format: (v) => `${v}`, unit });
  if (tl.fcAt.length) nowMark(f, tl.nowIdx);
  line(f, obsPoints(tl, key), { stroke: 'var(--series-1)', width: 2.4 });
  // 実測と予報は別物なので、線でつながない
  line(f, tl.fcAt.map((r) => ({ x: r.i, y: r[key] })),
    { stroke: 'var(--series-1)', width: 2, dash: '5 4' });
  timeAxis(f, tl.slots);
  crosshair(f, tl.slots, (i) => slotTip(tl, i));
  return f;
}

function fcLegend(fc) {
  return fc.length
    ? legend([
      { label: '実測', color: 'var(--series-1)' },
      { label: '予報（統計補正なし）', color: 'var(--series-1)', dash: true },
    ])
    : null;
}

/** 気温と風、降水の6時間の流れ。気温と風はこの先の予報もつなげる */
function seriesPanels(obs, fc = []) {
  const rows = obs.rows;
  const out = [];
  const ahead = fc.length > 0;

  // --- 気温
  const temps = rows.map((r) => r.temp).filter((v) => v !== null);
  if (temps.length >= 2) {
    const f = timelineChart(obs, fc, {
      key: 'temp', unit: '℃',
      label: ahead ? '直近6時間の気温とこの先の予報' : '直近6時間の気温',
    });

    out.push(el(
      'section', { class: 'panel' },
      el('h2', {}, ahead ? '気温 直近6時間とこの先6時間' : '気温の6時間'),
      el('p', { class: 'note' },
        '10分ごとの観測値。予報ではなく、実際に観測された気温。'
        + (ahead ? '破線は1時間ごとの予報で、統計補正はしていない。' : '')),
      fcLegend(fc),
      el('figure', { class: 'scroll-x' }, f.svg),
    ));
  }

  // --- 降水
  const rain = rows.map((r) => r.prcp10m).filter((v) => v !== null);
  if (rain.length >= 2) {
    const maxRain = Math.max(...rain, 0.5);
    const scale = niceScale(0, maxRain * 1.15, 4);
    const tl = timeline(rows, []);
    const f = frame({
      width: 720, height: 170,
      pad: { top: 22, right: 16, bottom: 28, left: 52 },
      xDomain: [0, tl.slots.length - 1],
      yDomain: [scale.min, scale.max],
      label: '直近6時間の降水量',
    });
    yAxis(f, scale.ticks, { format: (v) => `${v}`, unit: 'mm' });
    bars(f, tl.slots.map((s, i) => ({ x: i, value: s.obs?.prcp10m ?? null, tip: s.obs ? tipFor(s.obs) : null })),
      { color: 'var(--series-1)', gap: 1 });
    timeAxis(f, tl.slots);

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
    const f = timelineChart(obs, fc, {
      key: 'wind', unit: 'm/s', zeroBased: true,
      label: ahead ? '直近6時間の風速とこの先の予報' : '直近6時間の風速',
    });

    out.push(el(
      'section', { class: 'panel' },
      el('h2', {}, ahead ? '風 直近6時間とこの先6時間' : '風の6時間'),
      el('p', { class: 'note' },
        '10分間の平均風速。'
        + (ahead ? '破線は1時間ごとの予報で、統計補正はしていない。' : '')
        + 'アメダスの最大瞬間風速はその日の最大値なので、時系列にはならない。上の札に出してある。'),
      fcLegend(fc),
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

function fcTipFor(r) {
  return {
    title: `${timeLabel(r.at)} の予報（統計補正なし）`,
    rows: [
      r.temp !== null ? { k: '気温', v: `${fmt(r.temp, 1)}℃` } : null,
      r.prcp !== null ? { k: '降水（前1時間）', v: `${fmt(r.prcp, 1)}mm` } : null,
      r.pop !== null ? { k: '降水確率', v: `${fmt(r.pop, 0)}%` } : null,
      r.wind !== null ? { k: '風速', v: `${fmt(r.wind, 1)}m/s ${windDirName(r.windDirection)}` } : null,
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

export {
  fileKeys, val, parseStamp, windDirName, timeLabel,
  splitForecast, nextHours, degToDir16, radarUrl, timeline,
  rainScaleMax, rainChartable, rainChart,
};
