// 線形3種。すべて自前で解く。外部ライブラリを入れない。
//
//   ridge         重回帰 + L2 正則化。MOS の本体。気温・風・湿度に使う
//   logistic      ロジスティック回帰（IRLS）。降水の有無の確率に使う
//   quantile      分位点回帰（劣勾配降下）。予測区間の上下端に使う
//
// どれも設計行列の 0 列目を切片とする。切片には正則化をかけない。
import {
  gramian, matTvec, matvec, solveRidge, standardise, unstandardise,
} from './matrix.js';

/**
 * Ridge 重回帰。
 * 説明変数は標準化してから解き、係数を元のスケールへ戻す。
 * こうしないと、気温（20前後）と季節項（-1〜1）に同じ λ をかけることになり、
 * 正則化の強さが列ごとにばらばらになる。
 *
 * @param {number[][]} X 設計行列。0列目は 1（切片）
 * @param {number[]} y
 * @param {number} lambda
 * @returns {{beta:number[], lambda:number, n:number, p:number}|null}
 */
export function ridge(X, y, lambda = 1) {
  if (X.length === 0 || X.length !== y.length) return null;
  const p = X[0].length;
  if (X.length <= p) return null; // サンプルが足りない

  const { Z, mean, sd } = standardise(X);
  const G = gramian(Z);
  const b = matTvec(Z, y);
  // 切片（0列目）には正則化をかけない
  const diagW = Array.from({ length: p }, (_, j) => (j === 0 ? 0 : 1));

  const solved = solveRidge(G, b, lambda, diagW);
  if (!solved) return null;

  return {
    beta: unstandardise(solved.x, mean, sd),
    lambda: solved.lambda,
    n: X.length,
    p,
  };
}

/** 係数を当てて予測する */
export function predict(beta, x) {
  let s = 0;
  for (let j = 0; j < beta.length; j++) s += beta[j] * x[j];
  return s;
}

/**
 * ロジスティック回帰。IRLS（反復再重み付け最小二乗）で解く。
 *
 * 完全分離すると係数が発散するので、常に少量の L2 をかける。
 * 収束判定は係数の最大変化が tol を下回ったとき。
 *
 * @param {number[][]} X
 * @param {number[]} y 0 か 1
 * @param {{lambda?:number, maxIter?:number, tol?:number}} opts
 */
export function logistic(X, y, { lambda = 0.5, maxIter = 50, tol = 1e-8 } = {}) {
  if (X.length === 0 || X.length !== y.length) return null;
  const p = X[0].length;
  if (X.length <= p) return null;

  const { Z, mean, sd } = standardise(X);
  const diagW = Array.from({ length: p }, (_, j) => (j === 0 ? 0 : 1));

  let beta = new Array(p).fill(0);
  // 切片の初期値を基準率のロジットに置くと収束が速い
  const base = y.reduce((s, v) => s + v, 0) / y.length;
  beta[0] = Math.log(Math.min(Math.max(base, 1e-6), 1 - 1e-6) / (1 - Math.min(Math.max(base, 1e-6), 1 - 1e-6)));

  let iterations = 0;
  for (let iter = 0; iter < maxIter; iter++) {
    iterations = iter + 1;
    const eta = matvec(Z, beta);
    const mu = eta.map(sigmoid);
    // 重み w = μ(1-μ)。0 に近づくと数値が壊れるので下限を置く
    const w = mu.map((m) => Math.max(m * (1 - m), 1e-6));

    // 作業応答 z = η + (y - μ)/w、重み付き最小二乗を解く
    const zWork = eta.map((e, i) => e + (y[i] - mu[i]) / w[i]);
    const sw = w.map(Math.sqrt);
    const Xw = Z.map((row, i) => row.map((v) => v * sw[i]));
    const yw = zWork.map((v, i) => v * sw[i]);

    const solved = solveRidge(gramian(Xw), matTvec(Xw, yw), lambda, diagW);
    if (!solved) return null;

    const delta = Math.max(...solved.x.map((v, j) => Math.abs(v - beta[j])));
    beta = solved.x;
    if (delta < tol) break;
  }

  return {
    beta: unstandardise(beta, mean, sd),
    lambda,
    n: X.length,
    p,
    iterations,
  };
}

export function sigmoid(z) {
  // オーバーフローを避けるため符号で場合分けする
  if (z >= 0) return 1 / (1 + Math.exp(-z));
  const e = Math.exp(z);
  return e / (1 + e);
}

/** 係数を当てて確率を返す */
export function predictProb(beta, x) {
  return sigmoid(predict(beta, x));
}

/**
 * 分位点回帰。ピンボール損失を劣勾配降下で最小化する。
 *
 * 閉じた解が無いので反復で解く。初期値に Ridge の解を置くと、
 * τ=0.5 付近から始まるので収束が安定する。
 * 学習率はサンプル数で正規化する。
 *
 * @param {number[][]} X
 * @param {number[]} y
 * @param {number} tau 0〜1
 */
export function quantile(X, y, tau, { lr = 0.05, iterations = 3000, momentum = 0.9, lambda = 0.1 } = {}) {
  if (X.length === 0 || X.length !== y.length) return null;
  const p = X[0].length;
  if (X.length <= p) return null;

  const { Z, mean, sd } = standardise(X);
  const init = ridge(Z, y, lambda);
  if (!init) return null;
  // ridge() は内部で再標準化するので、そのまま Z 空間の係数として使える
  let beta = [...init.beta];
  let velocity = new Array(p).fill(0);

  const n = Z.length;
  for (let it = 0; it < iterations; it++) {
    const grad = new Array(p).fill(0);
    for (let i = 0; i < n; i++) {
      const r = y[i] - predict(beta, Z[i]);
      // ピンボール損失の劣勾配。r > 0 なら -τ、r < 0 なら (1-τ)
      const g = r > 0 ? -tau : (1 - tau);
      for (let j = 0; j < p; j++) grad[j] += g * Z[i][j];
    }
    for (let j = 0; j < p; j++) {
      grad[j] /= n;
      if (j > 0) grad[j] += (lambda / n) * beta[j]; // 切片以外に L2
      velocity[j] = momentum * velocity[j] - lr * grad[j];
      beta[j] += velocity[j];
    }
  }

  return {
    beta: unstandardise(beta, mean, sd),
    tau,
    n: X.length,
    p,
  };
}

/** ピンボール損失。分位点回帰の当てはまりを測る */
export function pinballLoss(yTrue, yPred, tau) {
  let s = 0;
  for (let i = 0; i < yTrue.length; i++) {
    const r = yTrue[i] - yPred[i];
    s += r > 0 ? tau * r : (tau - 1) * r;
  }
  return s / yTrue.length;
}

export { standardise, unstandardise, matvec };
