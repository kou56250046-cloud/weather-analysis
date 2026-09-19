// Open-Meteo のクライアント。非商用枠なので API キーは持たない。
// 出典表示（CC BY 4.0）が必須。画面のフッターで明記している。
//
//   forecast        これからの予報。7モデルを1リクエストで取る
//   ensemble        アンサンブル。分位数と降水メンバー比率を作るのに使う
//   previous-runs   過去に出された予報。リードタイム別。検証のタネ
//   archive         ERA5 再解析。長期トレンド用
import { getJson, buildUrl } from './http.js';

const API = {
  forecast: 'https://api.open-meteo.com/v1/forecast',
  ensemble: 'https://ensemble-api.open-meteo.com/v1/ensemble',
  previous: 'https://previous-runs-api.open-meteo.com/v1/forecast',
  archive: 'https://archive-api.open-meteo.com/v1/archive',
};

/** 合議に使うモデル。予報可能日数はモデルごとに違う（4日〜16日） */
export const MODELS = [
  'ecmwf_ifs025',
  'gfs_seamless',
  'icon_seamless',
  'jma_seamless',
  'ukmo_seamless',
  'gem_seamless',
  'meteofrance_seamless',
];

/** アンサンブルを持つモデル。分位数と降水確率に使う */
export const ENSEMBLE_MODELS = ['ecmwf_ifs025', 'gfs_seamless'];

/**
 * 長期アーカイブで取る変数。分析タブが使うものだけに絞る。
 * 1940年からの86年分を7変数で取ると API の課金単位が跳ね上がり、
 * 途中で 429 が返って歯抜けになる。
 */
export const ARCHIVE_VARS = ['tmax', 'tmin', 'prcp'];

/** 日別で取る変数と、レコード上の名前の対応 */
const DAILY_VARS = {
  tavg: 'temperature_2m_mean',
  tmax: 'temperature_2m_max',
  tmin: 'temperature_2m_min',
  prcp: 'precipitation_sum',
  rh: 'relative_humidity_2m_mean',
  wind: 'wind_speed_10m_max',
  sun: 'sunshine_duration',
  code: 'weather_code',
};

/** previous-runs は日別変数に対応していないので、時間別を自前で畳む */
const HOURLY_VARS = {
  temp: 'temperature_2m',
  prcp: 'precipitation',
  rh: 'relative_humidity_2m',
  wind: 'wind_speed_10m',
  sun: 'sunshine_duration',
};

const COMMON = { timezone: 'Asia/Tokyo', wind_speed_unit: 'ms', precipitation_unit: 'mm' };

/** 日照は秒で返るので時間に直す。それ以外は素通し */
function normalise(key, value) {
  if (value === null || value === undefined) return null;
  if (key === 'sun') return round(value / 3600, 2);
  if (key === 'code') return value;
  return round(value, 2);
}

function round(n, digits) {
  if (n === null || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

/**
 * これからの予報。7モデルぶんを1リクエストで取る。
 * @returns {Promise<Map<string, Array<{date:string, tmax:number|null, ...}>>>} モデル名 → 日別の配列
 */
export async function fetchForecastDaily(loc, { models = MODELS, forecastDays = 16 } = {}) {
  const url = buildUrl(API.forecast, {
    ...COMMON,
    latitude: loc.lat,
    longitude: loc.lon,
    forecast_days: forecastDays,
    daily: Object.values(DAILY_VARS),
    models,
  });
  const { data } = await getJson(url);
  if (!data?.daily?.time) throw new Error('open-meteo: forecast の構造が変わっている');

  const out = new Map();
  for (const model of models) {
    const rows = [];
    for (let i = 0; i < data.daily.time.length; i++) {
      const row = { date: data.daily.time[i] };
      let any = false;
      for (const [key, apiName] of Object.entries(DAILY_VARS)) {
        // モデル指定が1つだけのときは接尾辞が付かない
        const col = data.daily[`${apiName}_${model}`] ?? (models.length === 1 ? data.daily[apiName] : null);
        const v = col ? normalise(key, col[i]) : null;
        row[key] = v;
        if (v !== null) any = true;
      }
      // そのモデルの予報可能日数を超えた日は全て null になる。持たない
      if (any) rows.push(row);
    }
    out.set(model, rows);
  }
  return out;
}

/** 時間別で取る変数と、レコード上の名前の対応 */
const HOURLY_FORECAST_VARS = {
  temp: 'temperature_2m',
  feels: 'apparent_temperature',
  rh: 'relative_humidity_2m',
  prcp: 'precipitation',
  pop: 'precipitation_probability',
  wind: 'wind_speed_10m',
  cloud: 'cloud_cover',
  code: 'weather_code',
};

/**
 * 今日と明日の時間別予報。
 *
 * 日別と違って MOS の補正は当てられない。学習は日別の最高・最低気温に対して
 * 行っているので、時間ごとの値に当てる根拠が無い。
 * ここでは7モデルの単純平均を返し、補正していないことを画面で明示する。
 *
 * @returns {Promise<Array<{time:string, date:string, hour:number, models:object, ...}>>}
 */
export async function fetchForecastHourly(loc, { models = MODELS, forecastDays = 2 } = {}) {
  const url = buildUrl(API.forecast, {
    ...COMMON,
    latitude: loc.lat,
    longitude: loc.lon,
    forecast_days: forecastDays,
    hourly: Object.values(HOURLY_FORECAST_VARS),
    models,
  });
  const { data } = await getJson(url, { timeoutMs: 40_000 });
  if (!data?.hourly?.time) throw new Error('open-meteo: hourly forecast の構造が変わっている');

  const h = data.hourly;
  const out = [];
  for (let i = 0; i < h.time.length; i++) {
    const row = { time: h.time[i], date: h.time[i].slice(0, 10), hour: Number(h.time[i].slice(11, 13)) };

    for (const [key, apiName] of Object.entries(HOURLY_FORECAST_VARS)) {
      const values = [];
      for (const model of models) {
        const col = h[`${apiName}_${model}`] ?? (models.length === 1 ? h[apiName] : null);
        const v = col?.[i];
        if (v === null || v === undefined || !Number.isFinite(v)) continue;
        values.push(v);
      }
      if (values.length === 0) { row[key] = null; row[`${key}N`] = 0; continue; }

      if (key === 'code') {
        // 天気コードは平均すると意味を失う。荒天の度合いで並べて中央を採る
        row[key] = medianCode(values);
      } else {
        row[key] = round(values.reduce((s, v) => s + v, 0) / values.length, 2);
      }
      row[`${key}N`] = values.length;
      if (key === 'temp' && values.length > 1) {
        row.tempSpread = round(Math.max(...values) - Math.min(...values), 2);
      }
    }
    // 1つも値の無い時刻は持たない
    if (row.temp === null && row.prcp === null) continue;
    out.push(row);
  }
  return out;
}

/**
 * 天気コードを荒天の度合いで並べた順。小さいほど穏やか。
 * build-derived.js の合議と同じ並びにしてある。片方だけ直すとずれる。
 */
const CODE_SEVERITY = [
  0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57,
  61, 80, 63, 81, 65, 82, 66, 67, 71, 85, 73, 75, 86, 77, 95, 96, 99,
];

/** 複数モデルの天気コードから中央の荒天度を選ぶ */
export function medianCode(codes) {
  if (!codes || codes.length === 0) return null;
  const rankOf = (c) => {
    const i = CODE_SEVERITY.indexOf(Number(c));
    return i >= 0 ? i : CODE_SEVERITY.indexOf(3);
  };
  const sorted = [...codes].sort((a, b) => rankOf(a) - rankOf(b));
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/**
 * アンサンブル。各日について分位数と降水メンバー比率を作る。
 * メンバーを全部保存すると重いので、ここで分位数まで潰す。
 * @returns {Promise<Array<{date:string, q:{tmax:number[], prcp:number[]}, pop:number, members:number}>>}
 */
export async function fetchEnsembleDaily(loc, model, { forecastDays = 16, rainThresholdMm = 1.0 } = {}) {
  const url = buildUrl(API.ensemble, {
    ...COMMON,
    latitude: loc.lat,
    longitude: loc.lon,
    forecast_days: forecastDays,
    daily: [DAILY_VARS.tmax, DAILY_VARS.tmin, DAILY_VARS.prcp],
    models: model,
  });
  const { data } = await getJson(url);
  if (!data?.daily?.time) throw new Error(`open-meteo: ensemble の構造が変わっている (${model})`);

  const d = data.daily;
  const memberCols = (apiName) => Object.keys(d)
    .filter((k) => k === apiName || k.startsWith(`${apiName}_member`))
    .map((k) => d[k]);

  const tmaxCols = memberCols(DAILY_VARS.tmax);
  const tminCols = memberCols(DAILY_VARS.tmin);
  const prcpCols = memberCols(DAILY_VARS.prcp);
  if (tmaxCols.length === 0) throw new Error(`open-meteo: ensemble にメンバーがない (${model})`);

  const out = [];
  for (let i = 0; i < d.time.length; i++) {
    const tmax = tmaxCols.map((c) => c[i]).filter((v) => v !== null && v !== undefined);
    const tmin = tminCols.map((c) => c[i]).filter((v) => v !== null && v !== undefined);
    const prcp = prcpCols.map((c) => c[i]).filter((v) => v !== null && v !== undefined);
    if (tmax.length === 0) continue;
    out.push({
      date: d.time[i],
      members: tmax.length,
      q: {
        tmax: quantiles(tmax),
        tmin: tmin.length ? quantiles(tmin) : null,
        prcp: prcp.length ? quantiles(prcp) : null,
      },
      // 降水確率はメンバー比率。これを実測で較正して最終的な確率にする
      pop: prcp.length ? round(prcp.filter((v) => v >= rainThresholdMm).length / prcp.length, 3) : null,
    });
  }
  return out;
}

/** p10 / p25 / p50 / p75 / p90。線形補間 */
export function quantiles(values, ps = [0.1, 0.25, 0.5, 0.75, 0.9]) {
  const a = [...values].sort((x, y) => x - y);
  return ps.map((p) => {
    const pos = (a.length - 1) * p;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    const v = lo === hi ? a[lo] : a[lo] + (a[hi] - a[lo]) * (pos - lo);
    return round(v, 2);
  });
}

/**
 * previous-runs に頼む時間別変数の名前。
 * 変数を増やすほど API の課金単位が増える。既定は気温と降水だけ。
 *   core  気温・降水
 *   supp  気温・湿度・風。湿度と風を後から補うためのもの。
 *         気温は保存しないが、日別に畳むときの「24点中18点以上」の判定に要るので取る
 *   all   5種すべて
 */
export function previousRunsNames(vars = 'core', leads = [1, 2, 3, 4, 5, 6, 7]) {
  const bases = {
    core: [HOURLY_VARS.temp, HOURLY_VARS.prcp],
    supp: [HOURLY_VARS.temp, HOURLY_VARS.rh, HOURLY_VARS.wind],
    all: Object.values(HOURLY_VARS),
  }[vars];
  if (!bases) throw new Error(`previous-runs: 不明な vars (${vars})`);

  const names = [];
  for (const base of bases) {
    for (const lead of leads) names.push(`${base}_previous_day${lead}`);
  }
  return names;
}

/**
 * 過去に出された予報。リードタイム別に遡って取る。
 * 日別変数に対応していないため時間別で取り、JST の暦日に畳む。
 *
 * @param {object} loc
 * @param {string} model
 * @param {{startDate:string, endDate:string, leads:number[]}} opts
 * @returns {Promise<Map<number, Array<object>>>} lead → 日別の配列
 */
export async function fetchPreviousRunsDaily(loc, model, {
  startDate, endDate, leads = [1, 2, 3, 4, 5, 6, 7], vars = 'core',
}) {
  const names = previousRunsNames(vars, leads);
  const url = buildUrl(API.previous, {
    ...COMMON,
    latitude: loc.lat,
    longitude: loc.lon,
    start_date: startDate,
    end_date: endDate,
    hourly: names,
    models: model,
  });
  const { data } = await getJson(url, { timeoutMs: 60_000 });
  if (!data?.hourly?.time) throw new Error(`open-meteo: previous-runs の構造が変わっている (${model})`);
  // 頼んだ変数が応答に無いのは、名前が変わったか対応をやめたとき。黙って null にしない
  const missing = names.filter((n) => !(n in data.hourly));
  if (missing.length) {
    throw new Error(`open-meteo: previous-runs の応答に ${missing[0]} ほか ${missing.length} 変数が無い (${model})`);
  }

  const out = new Map();
  for (const lead of leads) {
    const series = {};
    for (const [key, base] of Object.entries(HOURLY_VARS)) {
      series[key] = data.hourly[`${base}_previous_day${lead}`] ?? null;
    }
    out.set(lead, foldHourlyToDaily(data.hourly.time, series));
  }
  return out;
}

/**
 * 時間別の系列を JST の暦日に畳む。
 * 気象庁の日別値は 00:10〜24:00 で定義されるが、1時間値からはその境界を再現できない。
 * ここでは 00:00〜23:00 の24点で代表させる。この系統的なずれは MOS が吸収する。
 */
export function foldHourlyToDaily(times, series) {
  const byDay = new Map();
  for (let i = 0; i < times.length; i++) {
    const day = times[i].slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(i);
  }

  const out = [];
  for (const [date, idx] of byDay) {
    const pick = (key) => {
      const col = series[key];
      if (!col) return [];
      return idx.map((i) => col[i]).filter((v) => v !== null && v !== undefined);
    };
    const temp = pick('temp');
    const prcp = pick('prcp');
    const rh = pick('rh');
    const wind = pick('wind');
    const sun = pick('sun');
    // 24点中18点以上ないと日別値として信用しない
    if (temp.length < 18) continue;
    out.push({
      date,
      tavg: round(mean(temp), 2),
      tmax: round(Math.max(...temp), 2),
      tmin: round(Math.min(...temp), 2),
      prcp: prcp.length ? round(sum(prcp), 2) : null,
      // 湿度と風も気温と同じく 18 点以上ないと日別値にしない。数時間分の平均や最大は偏る
      rh: rh.length >= 18 ? round(mean(rh), 1) : null,
      wind: wind.length >= 18 ? round(Math.max(...wind), 2) : null,
      sun: sun.length ? round(sum(sun) / 3600, 2) : null,
      code: null, // 時間別からは天気概況を作らない
    });
  }
  return out;
}

/**
 * ERA5 再解析の日別値。長期トレンド用。
 * 5日遅れなので、直近の日付は取れない。
 */
export async function fetchArchiveDaily(loc, {
  startDate, endDate, model = 'era5', vars = ARCHIVE_VARS,
} = {}) {
  // 変数を増やすほど API の課金単位が増え、長期を取ると 429 が返る。
  // 分析タブで実際に使うのは最高・最低気温と降水量だけなので、それだけ取る
  const url = buildUrl(API.archive, {
    ...COMMON,
    latitude: loc.lat,
    longitude: loc.lon,
    start_date: startDate,
    end_date: endDate,
    daily: vars.map((k) => DAILY_VARS[k]),
    models: model,
  });
  const { data } = await getJson(url, { timeoutMs: 120_000 });
  if (!data?.daily?.time) throw new Error('open-meteo: archive の構造が変わっている');

  const d = data.daily;
  const out = [];
  for (let i = 0; i < d.time.length; i++) {
    const row = { date: d.time[i] };
    let any = false;
    for (const key of vars) {
      const apiName = DAILY_VARS[key];
      const v = d[apiName] ? normalise(key, d[apiName][i]) : null;
      row[key] = v;
      if (v !== null) any = true;
    }
    if (any) out.push(row);
  }
  return out;
}

function sum(a) { return a.reduce((s, v) => s + v, 0); }
function mean(a) { return a.length ? sum(a) / a.length : null; }

export { API, DAILY_VARS, HOURLY_VARS, COMMON, round };
