// MOS の学習。予報値から実測値への回帰を、地点・変数・リードタイムごとに学習する。
//
// 守ること: 評価する日より後の実測を、その日の係数の学習に使わない。
// 時系列を無視して交差検証すると、未来を見た係数で過去を当てることになり、
// 精度が実態よりずっと良く出る。ここが崩れると全体が無意味になるので、
// 学習に使ってよい期間の終端を必ず引数で渡す作りにしてある。
import { ridge, logistic, quantile, predict, predictProb } from './regress.js';
import { solveRidge, unstandardise } from './matrix.js';
import { seasonTerms } from './time.js';
import { usableObs, RAIN_THRESHOLD_MM } from './verify.js';

/** 学習を始めるのに必要な最低サンプル数 */
export const MIN_TRAIN = 60;

/** この数に満たない区分は、lead をまとめた係数へ寄せる */
export const MIN_SAMPLES = 120;

/** 係数を学習し直す間隔（日）。毎日やっても結果はほぼ同じで、時間だけかかる */
export const RETRAIN_EVERY = 7;

/** 試す正則化の強さ。前向き検証の成績で選ぶ */
export const LAMBDAS = [0.01, 0.1, 1, 10, 100];

/**
 * 予報レコードを (lead, target) → モデル別の値 に畳む。
 * 同じ lead と target に複数の取得時刻があるときは、新しい方を採る。
 */
export function groupForecasts(rows) {
  const byLeadTarget = new Map();
  for (const r of rows) {
    if (r.model === 'jma_official') continue;
    const key = `${r.lead}|${r.target}`;
    if (!byLeadTarget.has(key)) byLeadTarget.set(key, new Map());
    const slot = byLeadTarget.get(key);
    const prev = slot.get(r.model);
    if (!prev || String(r.fetched) > String(prev.fetched)) slot.set(r.model, r);
  }
  return byLeadTarget;
}

/**
 * 学習用のサンプルを組み立てる。
 *
 * 説明変数は [1, 各モデルの予報値…, sin(季節), cos(季節)]。
 * 予報可能日数を過ぎたモデルは値を持たないが、列を落とすと設計行列が
 * 行ごとに変わってしまう。その行の他モデルの平均で埋め、列は固定する。
 * 埋めたことを示す列は作らない。サンプル数に対して変数が増えすぎる。
 *
 * transform を渡すと y も変換される。変換後の y で「1mm以上か」を判定すると
 * 別の閾値を学習してしまうので、変換前の実測も yRaw として持っておく。
 * ラベルを作る側（fitRainProbability）は必ず yRaw を見る。
 *
 * @returns {{X:number[][], y:number[], yRaw:number[], dates:string[], models:string[], filled:number}}
 */
export function buildSamples(grouped, obsByDate, { variable, lead, models, transform = null }) {
  const X = [];
  const y = [];
  const yRaw = [];
  const dates = [];
  let filled = 0;

  const keys = [...grouped.keys()]
    .filter((k) => Number(k.split('|')[0]) === lead)
    .sort((a, b) => a.split('|')[1].localeCompare(b.split('|')[1]));

  for (const key of keys) {
    const target = key.split('|')[1];
    const obs = obsByDate.get(target);
    if (!obs) continue;
    const raw = usableObs(obs, variable);
    if (raw === null) continue;

    const slot = grouped.get(key);
    const values = models.map((m) => {
      const v = slot.get(m)?.[variable];
      return v === null || v === undefined || !Number.isFinite(v) ? null : v;
    });
    const present = values.filter((v) => v !== null);
    // 1つもモデルが無い日は学習にも評価にも使えない
    if (present.length === 0) continue;
    const mean = present.reduce((s, v) => s + v, 0) / present.length;

    const feats = values.map((v) => {
      if (v === null) { filled++; return mean; }
      return v;
    });
    const [s, c] = seasonTerms(target);
    X.push([1, ...(transform ? feats.map(transform) : feats), s, c]);
    y.push(transform ? transform(raw) : raw);
    yRaw.push(raw);
    dates.push(target);
  }
  return { X, y, yRaw, dates, models, filled };
}

/**
 * 前向き検証。
 *
 * 日付順に並べたサンプルを走査し、評価する行より前のデータだけで係数を学習する。
 * 学習し直すのは RETRAIN_EVERY 日ごと。その間は直近の係数を使い回す。
 *
 * @param {{X:number[][], y:number[], dates:string[]}} samples
 * @param {(X:number[][], y:number[]) => object|null} fit
 * @param {(model:object, x:number[]) => number} apply
 * @returns {{predictions:(number|null)[], fits:Array, evaluatedFrom:string|null}}
 */
export function walkForward(samples, fit, apply, { minTrain = MIN_TRAIN, retrainEvery = RETRAIN_EVERY } = {}) {
  const { X, y, dates } = samples;
  const predictions = new Array(X.length).fill(null);
  const fits = [];

  let current = null;
  let trainedUpTo = -1; // 学習に使った最後の行の添字
  let sinceRetrain = Infinity;

  for (let i = 0; i < X.length; i++) {
    // i 行目より前だけを学習に使う
    if (i >= minTrain && sinceRetrain >= retrainEvery) {
      const model = fit(X.slice(0, i), y.slice(0, i));
      if (model) {
        current = model;
        trainedUpTo = i - 1;
        fits.push({
          atIndex: i,
          evaluatedFrom: dates[i],
          trainFrom: dates[0],
          trainTo: dates[i - 1],
          trainN: i,
        });
        sinceRetrain = 0;
      }
    }
    if (current) predictions[i] = apply(current, X[i]);
    sinceRetrain++;
  }

  return {
    predictions,
    fits,
    finalModel: current,
    trainedUpTo,
    evaluatedFrom: fits[0]?.evaluatedFrom ?? null,
  };
}

/** 平均絶対誤差。null の予測は飛ばす */
function maeOf(y, pred) {
  let s = 0;
  let n = 0;
  for (let i = 0; i < y.length; i++) {
    if (pred[i] === null) continue;
    s += Math.abs(pred[i] - y[i]);
    n++;
  }
  return n === 0 ? null : { mae: s / n, n };
}

/**
 * 前向き検証を1パスで回す Ridge 専用の実装。
 *
 * 素直に書くと、学習し直すたびに XᵀX を先頭から計算し直すことになり、
 * リードタイム17本 × 変数5個 × 地点4つ で数分かかる。
 * XᵀX と Xᵀy は行を足すだけで更新できるので、走査しながら累積する。
 * これで全体が O(n·p²) の1パスに収まる。
 *
 * 標準化した系は、生のモーメントから解析的に組み立てられる。
 *   (ZᵀZ)_jk = (G_jk − n·m_j·m_k)/(s_j·s_k)
 *   (Zᵀy)_j  = (b_j − m_j·Σy)/s_j
 * 0列目（切片）は 1 のままなので、対角に n を置き非対角は 0 になる。
 *
 * λ の候補はすべて同じ累積から解けるので、一度の走査で全部試す。
 */
export function walkForwardRidgeMulti(samples, lambdas, { minTrain = MIN_TRAIN, retrainEvery = RETRAIN_EVERY } = {}) {
  const { X, y, dates } = samples;
  const n = X.length;
  if (n === 0) return null;
  const p = X[0].length;

  const G = Array.from({ length: p }, () => new Array(p).fill(0));
  const b = new Array(p).fill(0);
  let sumY = 0;

  const predictions = new Map(lambdas.map((l) => [l, new Array(n).fill(null)]));
  const betas = new Map(lambdas.map((l) => [l, null]));
  const fits = [];
  let sinceRetrain = Infinity;

  for (let i = 0; i < n; i++) {
    if (i >= minTrain && sinceRetrain >= retrainEvery) {
      const solved = solveStandardised(G, b, sumY, i, p, lambdas);
      if (solved) {
        for (const [lambda, beta] of solved) betas.set(lambda, beta);
        fits.push({
          atIndex: i,
          evaluatedFrom: dates[i],
          trainFrom: dates[0],
          trainTo: dates[i - 1],
          trainN: i,
        });
        sinceRetrain = 0;
      }
    }
    for (const lambda of lambdas) {
      const beta = betas.get(lambda);
      if (beta) predictions.get(lambda)[i] = predict(beta, X[i]);
    }
    sinceRetrain++;

    // i 行目を累積に足す。次の学習からこの行が入る
    const row = X[i];
    for (let j = 0; j < p; j++) {
      const vj = row[j];
      b[j] += vj * y[i];
      for (let k = j; k < p; k++) {
        const g = vj * row[k];
        G[j][k] += g;
        if (k !== j) G[k][j] += g;
      }
    }
    sumY += y[i];
  }

  return { predictions, betas, fits, evaluatedFrom: fits[0]?.evaluatedFrom ?? null };
}

/** 生のモーメントから標準化した正規方程式を組み立てて解く */
function solveStandardised(G, b, sumY, n, p, lambdas) {
  const mean = new Array(p).fill(0);
  const sd = new Array(p).fill(1);
  for (let j = 1; j < p; j++) {
    mean[j] = G[0][j] / n; // 0列目が 1 なので G[0][j] = Σ x_j
    const varj = (G[j][j] - n * mean[j] * mean[j]) / Math.max(1, n - 1);
    sd[j] = varj > 1e-12 ? Math.sqrt(varj) : 1;
  }

  const Zg = Array.from({ length: p }, () => new Array(p).fill(0));
  Zg[0][0] = n;
  for (let j = 1; j < p; j++) {
    for (let k = j; k < p; k++) {
      const v = (G[j][k] - n * mean[j] * mean[k]) / (sd[j] * sd[k]);
      Zg[j][k] = v;
      Zg[k][j] = v;
    }
  }
  const Zb = new Array(p).fill(0);
  Zb[0] = sumY;
  for (let j = 1; j < p; j++) Zb[j] = (b[j] - mean[j] * sumY) / sd[j];

  const diagW = Array.from({ length: p }, (_, j) => (j === 0 ? 0 : 1));
  const out = [];
  for (const lambda of lambdas) {
    const solved = solveRidge(Zg, Zb, lambda, diagW);
    if (!solved) return null;
    out.push([lambda, unstandardise(solved.x, mean, sd)]);
  }
  return out;
}

/**
 * 連続値の MOS を学習する。
 * λ は前向き検証の MAE が最小になるものを選ぶ。
 */
export function fitContinuousMos(samples, { lambdas = LAMBDAS } = {}) {
  if (samples.X.length < MIN_TRAIN + 10) return null;

  const wf = walkForwardRidgeMulti(samples, lambdas);
  if (!wf) return null;

  let best = null;
  for (const lambda of lambdas) {
    const score = maeOf(samples.y, wf.predictions.get(lambda));
    if (!score) continue;
    if (!best || score.mae < best.score.mae) best = { lambda, score };
  }
  if (!best) return null;

  return {
    kind: 'ridge',
    lambda: best.lambda,
    beta: wf.betas.get(best.lambda),
    n: samples.X.length,
    walkForward: {
      mae: round(best.score.mae, 3),
      n: best.score.n,
      evaluatedFrom: wf.evaluatedFrom,
      retrains: wf.fits.length,
      lastTrainTo: wf.fits.at(-1)?.trainTo ?? null,
    },
    predictions: wf.predictions.get(best.lambda),
    dates: samples.dates,
    observed: samples.y,
  };
}

/**
 * 反復解法（ロジスティック・分位点）の学習し直し間隔。
 * Ridge と違って累積では解けず、毎回反復するので間隔を広げる。
 * 28日ごとでも係数はほとんど動かない。
 */
export const RETRAIN_EVERY_ITERATIVE = 28;

/**
 * 降水の有無の確率を学習する。
 *
 * 閾値は必ず変換前の実測（yRaw）に当てる。降水の samples は説明変数も目的変数も
 * log1p してあるので、変換後の y に 1.0 を当てると log1p(prcp) >= 1.0、
 * すなわち prcp >= 1.72mm を学習することになる。
 * 採点側（probabilityScores）は生の 1.0mm で判定するので、学習している事象と
 * 採点している事象が食い違い、確率が系統的に過小へ寄る。
 */
export function fitRainProbability(samples, { threshold = RAIN_THRESHOLD_MM, lambda = 0.5 } = {}) {
  if (samples.X.length < MIN_TRAIN + 10) return null;
  const amounts = samples.yRaw ?? samples.y;
  const binary = amounts.map((v) => (v >= threshold ? 1 : 0));
  const inner = { ...samples, y: binary };

  const wf = walkForward(
    inner,
    (X, y) => logistic(X, y, { lambda, maxIter: 25 }),
    (m, x) => predictProb(m.beta, x),
    { retrainEvery: RETRAIN_EVERY_ITERATIVE },
  );
  const valid = wf.predictions.filter((p) => p !== null).length;
  if (valid === 0) return null;

  return {
    kind: 'logistic',
    lambda,
    beta: wf.finalModel?.beta ?? null,
    n: samples.X.length,
    walkForward: {
      n: valid,
      evaluatedFrom: wf.evaluatedFrom,
      retrains: wf.fits.length,
      lastTrainTo: wf.fits.at(-1)?.trainTo ?? null,
    },
    predictions: wf.predictions,
    dates: samples.dates,
    observed: binary,
    observedAmount: amounts,
  };
}

/** 予測区間の上下端を学習する */
export function fitInterval(samples, { taus = [0.1, 0.9] } = {}) {
  if (samples.X.length < MIN_TRAIN + 10) return null;
  const out = {};
  for (const tau of taus) {
    const wf = walkForward(
      samples,
      (X, y) => quantile(X, y, tau, { iterations: 400, lr: 0.25 }),
      (m, x) => predict(m.beta, x),
      { retrainEvery: RETRAIN_EVERY_ITERATIVE },
    );
    out[tau] = {
      beta: wf.finalModel?.beta ?? null,
      predictions: wf.predictions,
      evaluatedFrom: wf.evaluatedFrom,
    };
  }
  return { kind: 'quantile', taus, ...out, dates: samples.dates, observed: samples.y, n: samples.X.length };
}

/**
 * サンプルが少ない区分の係数を、まとめて学習した係数へ寄せる。
 * w = n / (n + MIN_SAMPLES)。n が小さいほど pooled 側の重みが大きくなる。
 */
export function shrinkToPooled(beta, pooledBeta, n, minSamples = MIN_SAMPLES) {
  if (!beta) return pooledBeta ? [...pooledBeta] : null;
  if (!pooledBeta || n >= minSamples) return [...beta];
  const w = n / (n + minSamples);
  return beta.map((b, i) => w * b + (1 - w) * (pooledBeta[i] ?? 0));
}

function round(n, digits) {
  if (n === null || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
