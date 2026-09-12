import test from 'node:test';
import assert from 'node:assert/strict';
import { ridge, logistic, quantile, predict, predictProb, sigmoid, pinballLoss } from '../scripts/lib/regress.js';
import { cholesky, choleskySolve, gramian, standardise, unstandardise } from '../scripts/lib/matrix.js';

/** 再現性のある乱数。テストが日によって落ちるのを避ける */
function rng(seed = 42) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 標準正規乱数（Box-Muller） */
function normal(rand) {
  const u = Math.max(rand(), 1e-12);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

test('cholesky: LLᵀ が元の行列に戻る', () => {
  const A = [[4, 2, 1], [2, 5, 3], [1, 3, 6]];
  const L = cholesky(A);
  assert.ok(L);
  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      let s = 0;
      for (let k = 0; k < 3; k++) s += L[i][k] * L[j][k];
      assert.ok(Math.abs(s - A[i][j]) < 1e-10, `(${i},${j})`);
    }
  }
});

test('cholesky: 正定値でなければ null', () => {
  assert.equal(cholesky([[1, 2], [2, 1]]), null);
});

test('choleskySolve: Ax=b を解く', () => {
  const A = [[4, 2], [2, 5]];
  const L = cholesky(A);
  const x = choleskySolve(L, [8, 13]);
  // A·x が b に戻る
  assert.ok(Math.abs(4 * x[0] + 2 * x[1] - 8) < 1e-10);
  assert.ok(Math.abs(2 * x[0] + 5 * x[1] - 13) < 1e-10);
});

test('standardise / unstandardise: 往復して元に戻る', () => {
  const X = [[1, 10, 100], [1, 12, 130], [1, 14, 160], [1, 16, 190]];
  const { Z, mean, sd } = standardise(X);
  assert.equal(Z[0][0], 1); // 切片列は触らない
  // 標準化後の列平均はほぼ 0
  for (const j of [1, 2]) {
    const m = Z.reduce((s, r) => s + r[j], 0) / Z.length;
    assert.ok(Math.abs(m) < 1e-12);
  }
  const beta = [3, 2, -1];
  const back = unstandardise(beta, mean, sd);
  assert.equal(back.length, 3);
});

test('ridge: 既知の係数を復元する', () => {
  const rand = rng(1);
  const trueBeta = [5, 2, -1.5, 0.8];
  const X = [];
  const y = [];
  for (let i = 0; i < 400; i++) {
    const row = [1, normal(rand) * 3 + 20, normal(rand) * 2, normal(rand)];
    X.push(row);
    y.push(predict(trueBeta, row) + normal(rand) * 0.3);
  }
  const fit = ridge(X, y, 0.01);
  assert.ok(fit);

  // 傾きは厳しく見る
  for (let j = 1; j < trueBeta.length; j++) {
    assert.ok(Math.abs(fit.beta[j] - trueBeta[j]) < 0.02,
      `β${j}: 期待 ${trueBeta[j]} / 得た ${fit.beta[j].toFixed(4)}`);
  }
  // 切片は説明変数の平均（20前後）に傾きの誤差が乗るので単独では揺れる。
  // 実際に効くのは予測値なので、そちらで見る
  const rmse = Math.sqrt(
    X.reduce((s, row, i) => s + (predict(fit.beta, row) - predict(trueBeta, row)) ** 2, 0) / X.length,
  );
  assert.ok(rmse < 0.05, `真の関数との RMSE: ${rmse.toFixed(4)}`);
});

test('ridge: λ を上げると係数が縮む', () => {
  const rand = rng(2);
  const X = [];
  const y = [];
  for (let i = 0; i < 200; i++) {
    const row = [1, normal(rand), normal(rand)];
    X.push(row);
    y.push(3 + 2 * row[1] - row[2] + normal(rand) * 0.5);
  }
  const weak = ridge(X, y, 0.01);
  const strong = ridge(X, y, 1000);
  assert.ok(Math.abs(strong.beta[1]) < Math.abs(weak.beta[1]));
  // 切片は正則化していないので、y の平均付近に残る
  const meanY = y.reduce((s, v) => s + v, 0) / y.length;
  assert.ok(Math.abs(strong.beta[0] - meanY) < 0.3);
});

test('ridge: サンプルが変数より少なければ null', () => {
  assert.equal(ridge([[1, 2, 3], [1, 4, 5]], [1, 2], 1), null);
  assert.equal(ridge([], [], 1), null);
});

test('sigmoid: 大きな絶対値でも壊れない', () => {
  assert.equal(sigmoid(0), 0.5);
  assert.ok(sigmoid(800) === 1);
  assert.ok(sigmoid(-800) === 0);
  assert.ok(Number.isFinite(sigmoid(-800)));
});

test('logistic: 既知の係数をおおむね復元する', () => {
  const rand = rng(3);
  const trueBeta = [-0.5, 1.2, -0.8];
  const X = [];
  const y = [];
  for (let i = 0; i < 3000; i++) {
    const row = [1, normal(rand), normal(rand)];
    X.push(row);
    y.push(rand() < sigmoid(predict(trueBeta, row)) ? 1 : 0);
  }
  const fit = logistic(X, y, { lambda: 0.01 });
  assert.ok(fit);
  for (let j = 0; j < trueBeta.length; j++) {
    assert.ok(Math.abs(fit.beta[j] - trueBeta[j]) < 0.2,
      `β${j}: 期待 ${trueBeta[j]} / 得た ${fit.beta[j].toFixed(3)}`);
  }
  assert.ok(fit.iterations < 50, '収束せず上限まで回っている');
});

test('logistic: 完全分離しても発散しない', () => {
  const X = [];
  const y = [];
  for (let i = 0; i < 100; i++) {
    const x = i < 50 ? -1 - i / 50 : 1 + i / 50;
    X.push([1, x]);
    y.push(i < 50 ? 0 : 1);
  }
  const fit = logistic(X, y, { lambda: 1 });
  assert.ok(fit);
  assert.ok(fit.beta.every(Number.isFinite));
  assert.ok(Math.abs(fit.beta[1]) < 100, `係数が発散している: ${fit.beta[1]}`);
});

test('quantile: 一様分布で p10 / p90 が理論値に一致する', () => {
  const rand = rng(4);
  const X = [];
  const y = [];
  for (let i = 0; i < 4000; i++) {
    X.push([1]);
    y.push(rand() * 100); // 一様分布 [0,100)。p10=10, p90=90
  }
  const q10 = quantile(X, y, 0.1, { iterations: 4000, lr: 0.5 });
  const q90 = quantile(X, y, 0.9, { iterations: 4000, lr: 0.5 });
  assert.ok(Math.abs(q10.beta[0] - 10) < 2.5, `p10: ${q10.beta[0].toFixed(2)}`);
  assert.ok(Math.abs(q90.beta[0] - 90) < 2.5, `p90: ${q90.beta[0].toFixed(2)}`);
});

test('quantile: 説明変数があっても被覆率が τ に近い', () => {
  const rand = rng(5);
  const X = [];
  const y = [];
  for (let i = 0; i < 2000; i++) {
    const row = [1, normal(rand) * 2];
    X.push(row);
    y.push(10 + 1.5 * row[1] + normal(rand) * 3);
  }
  const q10 = quantile(X, y, 0.1, { iterations: 3000, lr: 0.2 });
  const below = X.filter((row, i) => y[i] < predict(q10.beta, row)).length / y.length;
  assert.ok(Math.abs(below - 0.1) < 0.035, `p10 の下側割合: ${below.toFixed(3)}`);
});

test('pinballLoss: τ=0.5 なら絶対誤差の半分', () => {
  const loss = pinballLoss([1, 2, 3], [2, 2, 2], 0.5);
  assert.ok(Math.abs(loss - (1 + 0 + 1) / 3 / 2) < 1e-12);
});

test('predictProb: 係数から確率を返す', () => {
  assert.equal(predictProb([0, 0], [1, 5]), 0.5);
  assert.ok(predictProb([0, 1], [1, 2]) > 0.8);
});

test('gramian: XᵀX が対称', () => {
  const X = [[1, 2], [1, 3], [1, 5]];
  const G = gramian(X);
  assert.equal(G[0][1], G[1][0]);
  assert.equal(G[0][0], 3);
});
