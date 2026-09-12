// 行列演算。依存を入れないので最低限だけ自前で持つ。
// 行列は number[][]、ベクトルは number[]。列優先にしない。

/** XᵀX を作る。対称なので上三角だけ計算して写す */
export function gramian(X) {
  const n = X.length;
  const p = X[0].length;
  const G = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let j = 0; j < p; j++) {
    for (let k = j; k < p; k++) {
      let s = 0;
      for (let i = 0; i < n; i++) s += X[i][j] * X[i][k];
      G[j][k] = s;
      G[k][j] = s;
    }
  }
  return G;
}

/** Xᵀy */
export function matTvec(X, y) {
  const p = X[0].length;
  const out = new Array(p).fill(0);
  for (let i = 0; i < X.length; i++) {
    for (let j = 0; j < p; j++) out[j] += X[i][j] * y[i];
  }
  return out;
}

/** Xβ */
export function matvec(X, b) {
  return X.map((row) => row.reduce((s, v, j) => s + v * b[j], 0));
}

/**
 * Cholesky 分解 A = LLᵀ。A は対称正定値。
 * 正定値でなければ null を返す。呼び出し側で正則化を強めて再試行する。
 */
export function cholesky(A) {
  const p = A.length;
  const L = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let i = 0; i < p; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j];
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k];
      if (i === j) {
        if (s <= 1e-12) return null; // 正定値でない
        L[i][j] = Math.sqrt(s);
      } else {
        L[i][j] = s / L[j][j];
      }
    }
  }
  return L;
}

/** LLᵀx = b を前進後退代入で解く */
export function choleskySolve(L, b) {
  const p = L.length;
  const y = new Array(p).fill(0);
  for (let i = 0; i < p; i++) {
    let s = b[i];
    for (let k = 0; k < i; k++) s -= L[i][k] * y[k];
    y[i] = s / L[i][i];
  }
  const x = new Array(p).fill(0);
  for (let i = p - 1; i >= 0; i--) {
    let s = y[i];
    for (let k = i + 1; k < p; k++) s -= L[k][i] * x[k];
    x[i] = s / L[i][i];
  }
  return x;
}

/**
 * (A + λD) x = b を解く。D は対角の重み（切片に正則化をかけないため）。
 * 正定値にならなければ λ を10倍して最大5回まで再試行する。
 */
export function solveRidge(A, b, lambda, diagWeights) {
  let lam = lambda;
  for (let attempt = 0; attempt < 6; attempt++) {
    const M = A.map((row, i) => row.map((v, j) => (i === j ? v + lam * diagWeights[i] : v)));
    const L = cholesky(M);
    if (L) return { x: choleskySolve(L, b), lambda: lam };
    lam = lam === 0 ? 1e-6 : lam * 10;
  }
  return null;
}

/** 平均と標準偏差。標準偏差が 0 の列は 1 として扱い、ゼロ除算を避ける */
export function standardise(X, { skipFirstColumn = true } = {}) {
  const n = X.length;
  const p = X[0].length;
  const mean = new Array(p).fill(0);
  const sd = new Array(p).fill(1);

  for (let j = 0; j < p; j++) {
    if (skipFirstColumn && j === 0) continue;
    let s = 0;
    for (let i = 0; i < n; i++) s += X[i][j];
    const m = s / n;
    let v = 0;
    for (let i = 0; i < n; i++) v += (X[i][j] - m) ** 2;
    mean[j] = m;
    sd[j] = Math.sqrt(v / Math.max(1, n - 1)) || 1;
  }

  const Z = X.map((row) => row.map((v, j) => (skipFirstColumn && j === 0 ? v : (v - mean[j]) / sd[j])));
  return { Z, mean, sd };
}

/**
 * 標準化した空間で得た係数を、元のスケールへ戻す。
 * 切片列（0番）はそのまま、他は β_j / sd_j、切片から Σ β_j·mean_j/sd_j を引く。
 */
export function unstandardise(beta, mean, sd, { skipFirstColumn = true } = {}) {
  const out = [...beta];
  let shift = 0;
  for (let j = 0; j < beta.length; j++) {
    if (skipFirstColumn && j === 0) continue;
    out[j] = beta[j] / sd[j];
    shift += out[j] * mean[j];
  }
  if (skipFirstColumn) out[0] = beta[0] - shift;
  return out;
}
