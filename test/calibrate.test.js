import test from 'node:test';
import assert from 'node:assert/strict';
import {
  groupForecasts, buildSamples, walkForward, walkForwardRidgeMulti,
  fitContinuousMos, shrinkToPooled, MIN_TRAIN,
} from '../scripts/lib/calibrate.js';
import { ridge, predict } from '../scripts/lib/regress.js';
import { addDays } from '../scripts/lib/time.js';

const MODELS = ['m1', 'm2', 'm3'];

/**
 * 合成データ。真の気温に対して、モデルごとに決まった偏りを乗せる。
 * MOS がその偏りを消せるかを見る。
 */
function synth({ days = 400, start = '2025-01-01', bias = { m1: 2, m2: -1.5, m3: 0 } } = {}) {
  let seed = 7;
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 4294967296;
  };
  const rows = [];
  const obsByDate = new Map();

  for (let i = 0; i < days; i++) {
    const date = addDays(start, i);
    const truth = 18 + 10 * Math.sin((2 * Math.PI * i) / 365) + (rand() - 0.5) * 4;
    obsByDate.set(date, { tmax: Math.round(truth * 10) / 10 });
    for (const m of MODELS) {
      rows.push({
        model: m,
        lead: 3,
        target: date,
        fetched: `${addDays(date, -3)}T00:00Z`,
        tmax: Math.round((truth + bias[m] + (rand() - 0.5) * 1.5) * 10) / 10,
      });
    }
  }
  return { rows, obsByDate };
}

test('groupForecasts: lead と target で束ね、新しい取得時刻を優先する', () => {
  const grouped = groupForecasts([
    { model: 'm1', lead: 1, target: '2026-09-02', fetched: '2026-09-01T00:00Z', tmax: 20 },
    { model: 'm1', lead: 1, target: '2026-09-02', fetched: '2026-09-01T12:00Z', tmax: 22 },
    { model: 'm2', lead: 1, target: '2026-09-02', fetched: '2026-09-01T00:00Z', tmax: 21 },
    { model: 'm1', lead: 2, target: '2026-09-03', fetched: '2026-09-01T00:00Z', tmax: 25 },
  ]);
  assert.equal(grouped.size, 2);
  const slot = grouped.get('1|2026-09-02');
  assert.equal(slot.get('m1').tmax, 22); // 新しい方
  assert.equal(slot.get('m2').tmax, 21);
});

test('groupForecasts: 気象庁予報は混ぜない', () => {
  const grouped = groupForecasts([
    { model: 'jma_official', lead: 1, target: '2026-09-02', fetched: 'x', tmax: 20 },
  ]);
  assert.equal(grouped.size, 0);
});

test('buildSamples: 設計行列の形と季節項', () => {
  const { rows, obsByDate } = synth({ days: 10 });
  const s = buildSamples(groupForecasts(rows), obsByDate, {
    variable: 'tmax', lead: 3, models: MODELS,
  });
  assert.equal(s.X.length, 10);
  assert.equal(s.X[0].length, 1 + MODELS.length + 2); // 切片 + モデル + sin/cos
  assert.equal(s.X[0][0], 1);
  // 季節項は単位円上
  const [sn, cs] = [s.X[0][4], s.X[0][5]];
  assert.ok(Math.abs(sn * sn + cs * cs - 1) < 1e-12);
  assert.deepEqual(s.dates, s.dates.slice().sort());
});

test('buildSamples: 欠けたモデルは他モデルの平均で埋める', () => {
  const rows = [
    { model: 'm1', lead: 1, target: '2026-09-02', fetched: 'a', tmax: 20 },
    { model: 'm2', lead: 1, target: '2026-09-02', fetched: 'a', tmax: 24 },
    // m3 は無い
  ];
  const obs = new Map([['2026-09-02', { tmax: 22 }]]);
  const s = buildSamples(groupForecasts(rows), obs, { variable: 'tmax', lead: 1, models: MODELS });
  assert.equal(s.X.length, 1);
  assert.equal(s.X[0][3], 22); // (20+24)/2
  assert.equal(s.filled, 1);
});

test('buildSamples: モデルが1つも無い日は捨てる', () => {
  const obs = new Map([['2026-09-02', { tmax: 22 }]]);
  const rows = [{ model: 'm1', lead: 1, target: '2026-09-02', fetched: 'a', tmax: null }];
  const s = buildSamples(groupForecasts(rows), obs, { variable: 'tmax', lead: 1, models: MODELS });
  assert.equal(s.X.length, 0);
});

test('buildSamples: 観測の品質が足りない日は捨てる', () => {
  const rows = [{ model: 'm1', lead: 1, target: '2026-09-02', fetched: 'a', tmax: 20 }];
  const obs = new Map([['2026-09-02', { tmax: 22, q: { tmax: 3 } }]]);
  const s = buildSamples(groupForecasts(rows), obs, { variable: 'tmax', lead: 1, models: MODELS });
  assert.equal(s.X.length, 0);
});

test('walkForward: 評価日より後のデータを学習に使わない', () => {
  const { rows, obsByDate } = synth({ days: 200 });
  const samples = buildSamples(groupForecasts(rows), obsByDate, {
    variable: 'tmax', lead: 3, models: MODELS,
  });
  const wf = walkForward(samples, (X, y) => ridge(X, y, 1), (m, x) => predict(m.beta, x));

  assert.ok(wf.fits.length > 0);
  for (const f of wf.fits) {
    // 学習期間の終端は、評価を始める日より前
    assert.ok(f.trainTo < f.evaluatedFrom, `${f.trainTo} < ${f.evaluatedFrom}`);
    assert.equal(f.trainN, f.atIndex);
  }
  // 最低サンプル数に達するまでは予測を出さない
  for (let i = 0; i < MIN_TRAIN; i++) assert.equal(wf.predictions[i], null);
  assert.ok(wf.predictions.at(-1) !== null);
});

test('fitContinuousMos: モデルの偏りを消す', () => {
  const { rows, obsByDate } = synth({ days: 500, bias: { m1: 2.5, m2: -1.8, m3: 0.4 } });
  const samples = buildSamples(groupForecasts(rows), obsByDate, {
    variable: 'tmax', lead: 3, models: MODELS,
  });
  const fit = fitContinuousMos(samples);
  assert.ok(fit, 'MOS が学習できていない');

  // 補正前: 3モデルの単純平均
  const idx = samples.dates.map((_, i) => i).filter((i) => fit.predictions[i] !== null);
  const rawMae = idx.reduce((s, i) => {
    const mean = (samples.X[i][1] + samples.X[i][2] + samples.X[i][3]) / 3;
    return s + Math.abs(mean - samples.y[i]);
  }, 0) / idx.length;

  // 補正前: 最も当たる単独モデル
  const bestSingle = Math.min(...[1, 2, 3].map((col) =>
    idx.reduce((s, i) => s + Math.abs(samples.X[i][col] - samples.y[i]), 0) / idx.length));

  assert.ok(fit.walkForward.mae < rawMae,
    `MOS ${fit.walkForward.mae} が単純平均 ${rawMae.toFixed(3)} に負けている`);
  assert.ok(fit.walkForward.mae < bestSingle,
    `MOS ${fit.walkForward.mae} が最良単独 ${bestSingle.toFixed(3)} に負けている`);
  assert.ok(LAMBDA_CANDIDATES.includes(fit.lambda), `λ が候補外: ${fit.lambda}`);
});

const LAMBDA_CANDIDATES = [0.01, 0.1, 1, 10, 100];

test('fitContinuousMos: サンプルが少なければ null', () => {
  assert.equal(fitContinuousMos({ X: [[1, 2]], y: [1], dates: ['2026-01-01'] }), null);
});

test('shrinkToPooled: n が小さいほど pooled 側へ寄る', () => {
  const beta = [10, 10];
  const pooled = [0, 0];
  const few = shrinkToPooled(beta, pooled, 10, 120);
  const many = shrinkToPooled(beta, pooled, 1000, 120);
  assert.ok(few[0] < many[0]);
  assert.ok(Math.abs(few[0] - 10 * (10 / 130)) < 1e-12);
  // 閾値以上ならそのまま
  assert.deepEqual(shrinkToPooled(beta, pooled, 120, 120), beta);
});

test('shrinkToPooled: 係数が無ければ pooled をそのまま使う', () => {
  assert.deepEqual(shrinkToPooled(null, [1, 2], 5), [1, 2]);
  assert.equal(shrinkToPooled(null, null, 5), null);
});

test('walkForwardRidgeMulti: 素朴な実装と同じ予測を出す', () => {
  const { rows, obsByDate } = synth({ days: 300 });
  const samples = buildSamples(groupForecasts(rows), obsByDate, {
    variable: 'tmax', lead: 3, models: MODELS,
  });

  for (const lambda of [0.01, 1, 100]) {
    const naive = walkForward(samples, (X, y) => ridge(X, y, lambda), (m, x) => predict(m.beta, x));
    const fast = walkForwardRidgeMulti(samples, [lambda]);
    const fastPred = fast.predictions.get(lambda);

    assert.equal(fast.fits.length, naive.fits.length, `λ=${lambda} の学習回数`);
    for (let i = 0; i < samples.X.length; i++) {
      if (naive.predictions[i] === null) {
        assert.equal(fastPred[i], null, `λ=${lambda} i=${i}`);
        continue;
      }
      assert.ok(Math.abs(fastPred[i] - naive.predictions[i]) < 1e-8,
        `λ=${lambda} i=${i}: 素朴 ${naive.predictions[i]} / 高速 ${fastPred[i]}`);
    }
  }
});
