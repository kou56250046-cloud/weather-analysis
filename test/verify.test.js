import test from 'node:test';
import assert from 'node:assert/strict';
import {
  continuousScores, categoricalScores, probabilityScores,
  reliabilityBins, coverage, usableObs, pairUp,
} from '../scripts/lib/verify.js';

test('continuousScores: 手計算と一致する', () => {
  // 誤差 +1, -2, +3 → MAE=2, RMSE=√(14/3)=2.160, bias=2/3
  const s = continuousScores([[11, 10], [8, 10], [13, 10]]);
  assert.equal(s.n, 3);
  assert.equal(s.mae, 2);
  assert.equal(s.rmse, 2.16);
  assert.equal(s.bias, 0.667);
  assert.equal(s.maxAbsError, 3);
});

test('continuousScores: null を含むペアは除く', () => {
  const s = continuousScores([[11, 10], [null, 10], [8, null], [12, 10]]);
  assert.equal(s.n, 2);
  assert.equal(s.mae, 1.5);
});

test('continuousScores: 有効なペアが無ければ null', () => {
  assert.equal(continuousScores([]), null);
  assert.equal(continuousScores([[null, 1], [2, null]]), null);
});

test('categoricalScores: 分割表が正しい', () => {
  // しきい値 1.0mm。[予報, 実測]
  const s = categoricalScores([
    [5, 3],    // hit
    [5, 0],    // false alarm
    [0, 3],    // miss
    [0, 0],    // correct negative
    [0, 0],    // correct negative
  ]);
  assert.equal(s.hit, 1);
  assert.equal(s.falseAlarm, 1);
  assert.equal(s.miss, 1);
  assert.equal(s.correctNegative, 2);
  assert.equal(s.accuracy, 0.6);
  assert.equal(s.falseAlarmRatio, 0.5);
  assert.equal(s.missRatio, 0.5);
  assert.equal(s.hitRate, 0.5);
  assert.equal(s.rainDays, 2);
});

test('categoricalScores: しきい値ちょうどは「降った」に入れる', () => {
  const s = categoricalScores([[1.0, 1.0]]);
  assert.equal(s.hit, 1);
  const s2 = categoricalScores([[0.9, 0.9]]);
  assert.equal(s2.correctNegative, 1);
});

test('categoricalScores: 常に「降らない」と言う予報は ETS が 0', () => {
  const pairs = [];
  for (let i = 0; i < 100; i++) pairs.push([0, i < 30 ? 5 : 0]);
  const s = categoricalScores(pairs);
  assert.equal(s.accuracy, 0.7); // 適中率は高いが
  assert.equal(s.ets, 0);        // 技術は無い
});

test('probabilityScores: Brier score が手計算と一致する', () => {
  // 確率 0.8 で降った、0.2 で降らなかった → (0.2² + 0.2²)/2 = 0.04
  const s = probabilityScores([[0.8, 5], [0.2, 0]]);
  assert.equal(s.n, 2);
  assert.equal(s.brier, 0.04);
  assert.equal(s.baseRate, 0.5);
  // 気候値 0.5 の Brier は 0.25。スキルスコアは 1 - 0.04/0.25 = 0.84
  assert.equal(s.brierClimatology, 0.25);
  assert.equal(s.brierSkillScore, 0.84);
});

test('probabilityScores: 完璧な予報は Brier 0', () => {
  const s = probabilityScores([[1, 5], [0, 0], [1, 2]]);
  assert.equal(s.brier, 0);
  assert.equal(s.brierSkillScore, 1);
});

test('reliabilityBins: 正しいビンに入る', () => {
  const bins = reliabilityBins([
    [0.05, 0], [0.05, 0], // 0.0-0.1 に2件、うち降水0
    [0.65, 5], [0.65, 0], // 0.6-0.7 に2件、うち降水1
    [1.0, 5],             // 1.0 は最終ビンに入れる
  ]);
  assert.equal(bins.length, 10);
  assert.equal(bins[0].n, 2);
  assert.equal(bins[0].observed, 0);
  assert.equal(bins[6].n, 2);
  assert.equal(bins[6].observed, 0.5);
  assert.equal(bins[9].n, 1);
  assert.equal(bins[9].observed, 1);
  // 空のビンは null のまま
  assert.equal(bins[3].n, 0);
  assert.equal(bins[3].observed, null);
});

test('coverage: 区間に入った割合と平均幅', () => {
  const c = coverage([
    [10, 20, 15],  // 入る
    [10, 20, 25],  // 外れる
    [10, 20, 10],  // 境界は入る
    [10, 20, 20],  // 境界は入る
  ]);
  assert.equal(c.n, 4);
  assert.equal(c.coverage, 0.75);
  assert.equal(c.meanWidth, 10);
});

test('usableObs: 品質フラグが 2 以上なら使わない', () => {
  assert.equal(usableObs({ tmax: 30, q: { tmax: 0 } }, 'tmax'), 30);
  assert.equal(usableObs({ tmax: 30, q: { tmax: 1 } }, 'tmax'), 30); // 準正常値は使う
  assert.equal(usableObs({ tmax: 30, q: { tmax: 2 } }, 'tmax'), null); // 資料不足
  assert.equal(usableObs({ tmax: 30 }, 'tmax'), 30); // フラグ無しは正常
  assert.equal(usableObs({ tmax: null }, 'tmax'), null);
  assert.equal(usableObs(null, 'tmax'), null);
});

test('usableObs: 変数ごとに判定し、日ごと落とさない', () => {
  const obs = { tmax: 30, prcp: 5, q: { prcp: 3 } };
  assert.equal(usableObs(obs, 'tmax'), 30);
  assert.equal(usableObs(obs, 'prcp'), null);
});

test('pairUp: target で突き合わせる', () => {
  const forecasts = [
    { target: '2026-09-01', tmax: 30 },
    { target: '2026-09-02', tmax: 31 },
    { target: '2026-09-03', tmax: 32 }, // 観測が無い
    { target: '2026-09-04', tmax: null },
  ];
  const obs = new Map([
    ['2026-09-01', { tmax: 29 }],
    ['2026-09-02', { tmax: 30, q: { tmax: 3 } }], // 欠測
    ['2026-09-04', { tmax: 28 }],
  ]);
  const pairs = pairUp(forecasts, obs, 'tmax');
  assert.equal(pairs.length, 1);
  assert.deepEqual(pairs[0], [30, 29, '2026-09-01']);
});
