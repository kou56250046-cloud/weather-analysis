// 予報と実測を突き合わせて誤差を測る。
// 自作の合議も、各モデル単独も、気象庁予報も、すべてこの関数で採点する。
// 採点の仕方を分けると比較が成立しない。

/** 「雨が降った」と見なす日降水量（mm）。気象庁の降水確率の定義に合わせる */
export const RAIN_THRESHOLD_MM = 1.0;

/** 品質フラグがこれ以上の観測値は検証に使わない（2=資料不足, 3=欠測） */
export const MAX_QUALITY_FLAG = 1;

/**
 * 観測レコードから、検証に使ってよい値を取り出す。
 * 品質が足りない項目は null にする。日ごと落とさず、変数単位で落とす。
 */
export function usableObs(obs, key) {
  const v = obs?.[key];
  if (v === null || v === undefined) return null;
  const flag = obs.q?.[key] ?? 0;
  return flag > MAX_QUALITY_FLAG ? null : v;
}

/** 連続値の誤差。サンプルが 0 なら null を返す */
export function continuousScores(pairs) {
  const valid = pairs.filter(([f, o]) => f !== null && o !== null && Number.isFinite(f) && Number.isFinite(o));
  if (valid.length === 0) return null;

  let sumAbs = 0;
  let sumSq = 0;
  let sumBias = 0;
  let maxAbs = 0;
  for (const [f, o] of valid) {
    const d = f - o;
    sumAbs += Math.abs(d);
    sumSq += d * d;
    sumBias += d;
    maxAbs = Math.max(maxAbs, Math.abs(d));
  }
  const n = valid.length;
  return {
    n,
    mae: round(sumAbs / n, 3),
    rmse: round(Math.sqrt(sumSq / n), 3),
    bias: round(sumBias / n, 3),
    maxAbsError: round(maxAbs, 2),
  };
}

/**
 * 降水の有無を当てられたか。2×2 の分割表で見る。
 *
 *              実測あり  実測なし
 *   予報あり      hit    falseAlarm
 *   予報なし      miss   correctNegative
 *
 * 適中率だけ見ると「毎日降らないと言う」戦略が高得点になってしまうので、
 * 空振り率・見逃し率と、降水日だけを見る ETS も併せて出す。
 */
export function categoricalScores(pairs, threshold = RAIN_THRESHOLD_MM) {
  const valid = pairs.filter(([f, o]) => f !== null && o !== null);
  if (valid.length === 0) return null;

  let hit = 0;
  let falseAlarm = 0;
  let miss = 0;
  let correctNegative = 0;
  for (const [f, o] of valid) {
    const fRain = f >= threshold;
    const oRain = o >= threshold;
    if (fRain && oRain) hit++;
    else if (fRain && !oRain) falseAlarm++;
    else if (!fRain && oRain) miss++;
    else correctNegative++;
  }
  const n = valid.length;
  // 偶然でも当たる分を差し引いた ETS（Equitable Threat Score）
  const hitsRandom = ((hit + falseAlarm) * (hit + miss)) / n;
  const etsDenom = hit + falseAlarm + miss - hitsRandom;

  return {
    n,
    hit,
    falseAlarm,
    miss,
    correctNegative,
    accuracy: round((hit + correctNegative) / n, 4),
    falseAlarmRatio: hit + falseAlarm > 0 ? round(falseAlarm / (hit + falseAlarm), 4) : null,
    missRatio: hit + miss > 0 ? round(miss / (hit + miss), 4) : null,
    hitRate: hit + miss > 0 ? round(hit / (hit + miss), 4) : null,
    ets: etsDenom > 0 ? round((hit - hitsRandom) / etsDenom, 4) : null,
    rainDays: hit + miss,
  };
}

/**
 * 確率予報の当たり具合。Brier score は小さいほど良い。
 * 基準は「常に気候値を言う」予報。それより小さくなければ意味がない。
 */
export function probabilityScores(pairs, threshold = RAIN_THRESHOLD_MM) {
  const valid = pairs.filter(([p, o]) => p !== null && o !== null);
  if (valid.length === 0) return null;

  const outcomes = valid.map(([, o]) => (o >= threshold ? 1 : 0));
  const base = outcomes.reduce((s, v) => s + v, 0) / outcomes.length;

  let brier = 0;
  let brierClim = 0;
  for (let i = 0; i < valid.length; i++) {
    brier += (valid[i][0] - outcomes[i]) ** 2;
    brierClim += (base - outcomes[i]) ** 2;
  }
  brier /= valid.length;
  brierClim /= valid.length;

  return {
    n: valid.length,
    brier: round(brier, 4),
    brierClimatology: round(brierClim, 4),
    // 1 に近いほど良い。0 以下なら気候値を言うのと変わらない
    brierSkillScore: brierClim > 0 ? round(1 - brier / brierClim, 4) : null,
    baseRate: round(base, 4),
  };
}

/**
 * 信頼度図のためのビン集計。
 * 「確率 60% と言った日のうち、実際に降ったのは何%か」を10段階で見る。
 * 対角線から離れているほど、確率の較正が狂っている。
 */
export function reliabilityBins(pairs, { bins = 10, threshold = RAIN_THRESHOLD_MM } = {}) {
  const valid = pairs.filter(([p, o]) => p !== null && o !== null);
  const out = Array.from({ length: bins }, (_, i) => ({
    lower: round(i / bins, 2),
    upper: round((i + 1) / bins, 2),
    mid: round((i + 0.5) / bins, 2),
    n: 0,
    observed: null,
    meanForecast: null,
  }));
  const sums = out.map(() => ({ obs: 0, fcst: 0 }));

  for (const [p, o] of valid) {
    const idx = Math.min(bins - 1, Math.max(0, Math.floor(p * bins)));
    out[idx].n++;
    sums[idx].obs += o >= threshold ? 1 : 0;
    sums[idx].fcst += p;
  }
  out.forEach((b, i) => {
    if (b.n > 0) {
      b.observed = round(sums[i].obs / b.n, 4);
      b.meanForecast = round(sums[i].fcst / b.n, 4);
    }
  });
  return out;
}

/**
 * 80% 予測区間の被覆率。
 * 区間が狭すぎれば被覆率は下がり、広すぎれば上がる。0.8 に近いほど正直な区間。
 */
export function coverage(triples) {
  const valid = triples.filter(([lo, hi, o]) => lo !== null && hi !== null && o !== null);
  if (valid.length === 0) return null;
  let inside = 0;
  let width = 0;
  for (const [lo, hi, o] of valid) {
    if (o >= lo && o <= hi) inside++;
    width += hi - lo;
  }
  return {
    n: valid.length,
    coverage: round(inside / valid.length, 4),
    meanWidth: round(width / valid.length, 3),
  };
}

/**
 * 予報レコードと観測レコードを (target) で突き合わせてペアを作る。
 * @param {Array} forecasts 同じ (loc, model, lead) のレコード群
 * @param {Map<string, object>} obsByDate
 * @param {string} fcstKey 予報側の変数名
 * @param {string} obsKey  観測側の変数名（既定は同名）
 */
export function pairUp(forecasts, obsByDate, fcstKey, obsKey = fcstKey) {
  const pairs = [];
  for (const f of forecasts) {
    const o = obsByDate.get(f.target);
    if (!o) continue;
    const ov = usableObs(o, obsKey);
    const fv = f[fcstKey];
    if (fv === null || fv === undefined || ov === null) continue;
    pairs.push([fv, ov, f.target]);
  }
  return pairs;
}

function round(n, digits) {
  if (n === null || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export { round };
