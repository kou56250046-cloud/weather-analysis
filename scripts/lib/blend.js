// 学習した係数を、これからの予報に当てる。
//
// 学習（calibrate.js）と適用（ここ）を分けてあるのは、
// 適用側がうっかり実測を参照しないようにするため。この関数は観測を受け取らない。
import { predict, predictProb } from './regress.js';
import { seasonTerms } from './time.js';

/**
 * 1日ぶんの説明変数を組み立てる。
 * buildSamples と同じ並びでなければならない。ずれると係数が別の変数にかかる。
 */
export function buildFeatureRow(slot, models, target, { variable, transform = null }) {
  const values = models.map((m) => {
    const v = slot.get(m)?.[variable];
    return v === null || v === undefined || !Number.isFinite(v) ? null : v;
  });
  const present = values.filter((v) => v !== null);
  if (present.length === 0) return null;
  const mean = present.reduce((s, v) => s + v, 0) / present.length;
  const feats = values.map((v) => (v === null ? mean : v));
  const [s, c] = seasonTerms(target);

  return {
    row: [1, ...(transform ? feats.map(transform) : feats), s, c],
    available: present.length,
    values,
    mean,
    spread: present.length > 1 ? Math.max(...present) - Math.min(...present) : 0,
  };
}

/**
 * 合議予報を作る。
 *
 * MOS の係数があればそれを当てる。まだ学習できていない変数・リードタイムでは、
 * 補正なしの単純平均にそのまま落とす。学習できていないことは画面に出す。
 * 黙って単純平均を「補正済み」として見せない。
 */
export function blendOne(slot, models, target, { variable, coef, transform = null, inverse = null }) {
  const built = buildFeatureRow(slot, models, target, { variable, transform });
  if (!built) return null;

  let value = built.mean;
  let method = 'mean';
  if (coef?.beta) {
    const raw = predict(coef.beta, built.row);
    value = inverse ? inverse(raw) : raw;
    method = 'mos';
  }

  return {
    value: round(value, 2),
    method,
    modelMean: round(built.mean, 2),
    spread: round(built.spread, 2),
    available: built.available,
    models: Object.fromEntries(models.map((m, i) => [m, built.values[i]])),
  };
}

/** 降水確率。較正済みの係数があればそれを使い、無ければアンサンブル比率を素で出す */
export function blendRainProbability(slot, models, target, { coef, fallbackPop = null }) {
  const built = buildFeatureRow(slot, models, target, { variable: 'prcp', transform: log1p });
  if (!built) return null;

  if (coef?.beta) {
    return {
      value: round(predictProb(coef.beta, built.row), 3),
      method: 'logistic',
      modelMean: round(built.mean, 2),
    };
  }
  return {
    value: fallbackPop === null ? null : round(fallbackPop, 3),
    method: fallbackPop === null ? 'none' : 'ensemble',
    modelMean: round(built.mean, 2),
  };
}

/**
 * 予測区間。
 *
 * 分位点回帰の係数があればそれを使う。無ければアンサンブルの広がりを使い、
 * さらに無ければ「その lead の実績 MAE の 1.28 倍」で代用する。
 * 1.28 は正規分布で 80% 区間に相当する係数。粗いが、何も出さないよりは判断できる。
 *
 * どの経路でも、区間は必ず中央値（実際に画面へ出す予報値）を含むようにする。
 * アンサンブルの分位数はそのモデル単体の分布なので、7モデルを合議して補正した
 * 予報値がその外に出ることがある。「25.2〜29.2℃、予報は24.3℃」という表示は
 * 読む側にとって意味を成さない。広がりだけを借りて、中央値の周りに付け直す。
 *
 * @param {number|null} center 実際に表示する予報値
 */
export function blendInterval(slot, models, target, {
  variable, intervalCoef, ensembleQ, leadMae, center = null,
}) {
  const built = buildFeatureRow(slot, models, target, { variable });
  if (!built) return null;
  const mid = center !== null && Number.isFinite(center) ? center : built.mean;

  if (intervalCoef?.[0.1]?.beta && intervalCoef?.[0.9]?.beta) {
    const lo = predict(intervalCoef[0.1].beta, built.row);
    const hi = predict(intervalCoef[0.9].beta, built.row);
    // 学習が不十分だと上下が入れ替わることがある。その場合は並べ替える
    return clampAround(Math.min(lo, hi), Math.max(lo, hi), mid, 'quantile');
  }
  if (ensembleQ && ensembleQ.length === 5) {
    // p10/p50/p90 の間隔だけを借りて、合議した予報値の周りに付け直す
    const [p10, , p50, , p90] = ensembleQ;
    const down = Math.max(0, p50 - p10);
    const up = Math.max(0, p90 - p50);
    return clampAround(mid - down, mid + up, mid, 'ensemble');
  }
  if (leadMae !== null && leadMae !== undefined) {
    const half = leadMae * 1.28;
    return clampAround(mid - half, mid + half, mid, 'mae');
  }
  return null;
}

/** 区間が中央値を挟むようにする。挟んでいなければ中央値まで広げる */
function clampAround(low, high, mid, method) {
  return {
    low: round(Math.min(low, mid), 2),
    high: round(Math.max(high, mid), 2),
    method,
  };
}

export const log1p = (v) => Math.log1p(Math.max(0, v));
export const expm1 = (v) => Math.max(0, Math.expm1(v));

function round(n, digits) {
  if (n === null || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}

export { round };
