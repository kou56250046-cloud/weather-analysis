import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { previousRunsNames } from '../scripts/lib/openmeteo.js';
import {
  buildRecords, buildSuppRecords, isChunkDone, estimateCalls, chunkRange,
} from '../scripts/backfill-previous-runs.js';
import { upsertNdjson, readNdjson } from '../scripts/lib/store.js';

const LOC = { key: 'setagaya', lat: 35.646, lon: 139.653 };

/** foldHourlyToDaily が返す形の日別行 */
const day = (date, over = {}) => ({
  date, tavg: 20, tmax: 24, tmin: 17, prcp: 0, rh: 70.5, wind: 5.2, sun: null, code: null, ...over,
});

// ------------------------------------------------------------------ 取得する変数

test('previousRunsNames: supp は気温・湿度・風の3種 × lead 7 だけを頼む', () => {
  const names = previousRunsNames('supp');
  assert.equal(names.length, 21);
  assert.ok(names.every((n) => /^(temperature_2m|relative_humidity_2m|wind_speed_10m)_previous_day[1-7]$/.test(n)), names.join(' '));
  assert.ok(!names.some((n) => /sunshine|precipitation/.test(n)));
});

test('previousRunsNames: 既存の core と all は変わらない', () => {
  assert.equal(previousRunsNames('core').length, 14);
  assert.equal(previousRunsNames('all').length, 35);
  assert.throws(() => previousRunsNames('nope'));
});

// ------------------------------------------------------------------ 補完行

test('buildSuppRecords: id は既存行の id に |rhwind を付けたもの', () => {
  const [base] = buildRecords(LOC, 'gfs_seamless', 1, [day('2024-01-20')]);
  const [supp] = buildSuppRecords(LOC, 'gfs_seamless', 1, [day('2024-01-20')]);
  assert.equal(supp.id, `${base.id}|rhwind`);
  assert.equal(supp.fetched, base.fetched);
  assert.equal(supp.target, base.target);
  assert.equal(supp.lead, 1);
  assert.equal(supp.rh, 70.5);
  assert.equal(supp.wind, 5.2);
  // 気温と降水は持たない。既存行の値を上書きする経路を作らない
  assert.equal('tmax' in supp, false);
  assert.equal('prcp' in supp, false);
});

test('buildSuppRecords: 湿度と風が両方無い日は行を作らない。片方あれば作る', () => {
  const rows = [
    day('2024-01-20', { rh: null, wind: null }),
    day('2024-01-21', { rh: null }),
    day('2024-01-22', { wind: null }),
  ];
  const out = buildSuppRecords(LOC, 'gfs_seamless', 3, rows);
  assert.deepEqual(out.map((r) => r.target), ['2024-01-21', '2024-01-22']);
  assert.equal(out[0].rh, null);
  assert.equal(out[1].wind, null);
});

test('buildSuppRecords: 同じ入力で2回 upsert しても行は増えない', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'supp-'));
  try {
    const path = join(dir, '2024-01.ndjson');
    const recs = buildSuppRecords(LOC, 'gfs_seamless', 2, [day('2024-01-20'), day('2024-01-21')]);
    const first = await upsertNdjson(path, recs);
    const again = await upsertNdjson(path, buildSuppRecords(LOC, 'gfs_seamless', 2, [day('2024-01-20'), day('2024-01-21')]));
    assert.equal(first.added, 2);
    assert.equal(again.added, 0);
    assert.equal((await readNdjson(path)).length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ 取得済みの判定

test('isChunkDone: 区間の全日が完了記録に入っていれば飛ばす', () => {
  const done = [{ model: 'gfs_seamless', start: '2024-01-01', end: '2024-03-30' }];
  assert.equal(isChunkDone(done, 'gfs_seamless', { start: '2024-01-01', end: '2024-03-30' }), true);
  assert.equal(isChunkDone(done, 'gfs_seamless', { start: '2024-02-01', end: '2024-02-10' }), true);
  // 1日でもはみ出せば取りに行く
  assert.equal(isChunkDone(done, 'gfs_seamless', { start: '2024-03-01', end: '2024-03-31' }), false);
  // モデルが違えば別物
  assert.equal(isChunkDone(done, 'icon_seamless', { start: '2024-01-01', end: '2024-01-10' }), false);
  assert.equal(isChunkDone([], 'gfs_seamless', { start: '2024-01-01', end: '2024-01-10' }), false);
});

test('isChunkDone: --from をずらして区切りが変わっても、複数の記録をつないで判定する', () => {
  // 1回目は 2024-01-01 起点で区切った
  const done = chunkRange('2024-01-01', '2024-06-28').map((c) => ({ model: 'gfs_seamless', ...c }));
  // 2回目は 2024-02-15 起点。区切りは記録と揃わないが、全日が覆われている
  for (const c of chunkRange('2024-02-15', '2024-06-28')) {
    assert.equal(isChunkDone(done, 'gfs_seamless', c), true, `${c.start}〜${c.end}`);
  }
  // 記録の外まで伸ばした区間は取りに行く
  assert.equal(isChunkDone(done, 'gfs_seamless', { start: '2024-06-01', end: '2024-07-05' }), false);
});

// ------------------------------------------------------------------ 使用量の見積もり

test('estimateCalls: 全期間・4地点・7モデルで 4,000〜4,500 call', () => {
  const chunks = chunkRange('2024-01-01', '2026-09-11');
  assert.equal(chunks.length, 11); // 985日 = 90日 × 10 + 85日
  const all = [];
  for (let i = 0; i < 4 * 7; i++) all.push(...chunks);
  const est = estimateCalls(all, 21);
  assert.ok(est >= 4000 && est <= 4500, `${est}`);
});

test('estimateCalls: 変数10以下・2週以下は1リクエスト1 call', () => {
  assert.equal(estimateCalls([{ start: '2024-01-01', end: '2024-01-10' }], 7), 1);
  assert.equal(estimateCalls([], 21), 0);
});

// ------------------------------------------------------------------ 読むときの合流

const { mergeSupplement } = await import('../scripts/build-derived.js');
const { groupForecasts, buildSamples } = await import('../scripts/lib/calibrate.js');

test('mergeSupplement: null の湿度と風だけを埋め、気温と降水には触らない', () => {
  const base = buildRecords(LOC, 'gfs_seamless', 1, [day('2024-01-20', { rh: null, wind: null })]);
  const supp = buildSuppRecords(LOC, 'gfs_seamless', 1, [day('2024-01-20', { tmax: 99, prcp: 99, rh: 66.6, wind: 4.4 })]);
  const [m] = mergeSupplement(base, supp);
  assert.equal(m.rh, 66.6);
  assert.equal(m.wind, 4.4);
  assert.equal(m.tmax, base[0].tmax);
  assert.equal(m.prcp, base[0].prcp);
  assert.equal(m.id, base[0].id);
  // 元の行は変えない
  assert.equal(base[0].rh, null);
});

test('mergeSupplement: 数値が入っている行（毎日の収集）は上書きしない', () => {
  const base = buildRecords(LOC, 'gfs_seamless', 1, [day('2024-01-20', { rh: 80, wind: null })]);
  const supp = buildSuppRecords(LOC, 'gfs_seamless', 1, [day('2024-01-20', { rh: 10, wind: 3 })]);
  const [m] = mergeSupplement(base, supp);
  assert.equal(m.rh, 80);
  assert.equal(m.wind, 3);
});

test('mergeSupplement: 対応の無い補完行は捨て、行数は変わらない', () => {
  const base = buildRecords(LOC, 'gfs_seamless', 1, [day('2024-01-20', { rh: null, wind: null })]);
  const supp = [
    ...buildSuppRecords(LOC, 'gfs_seamless', 2, [day('2024-01-20')]), // lead 違い = fetched 違い
    ...buildSuppRecords(LOC, 'icon_seamless', 1, [day('2024-01-20')]), // モデル違い
    ...buildSuppRecords(LOC, 'gfs_seamless', 1, [day('2024-01-21')]), // 予報行が無い日
  ];
  const out = mergeSupplement(base, supp);
  assert.equal(out.length, 1);
  assert.equal(out[0].rh, null);
  assert.equal(out[0].wind, null);
  assert.deepEqual(mergeSupplement(base, []), base);
});

test('mergeSupplement: 補完の有無で、気温と降水の学習サンプルは変わらない', () => {
  const models = ['gfs_seamless', 'icon_seamless'];
  const dates = Array.from({ length: 30 }, (_, i) => `2024-01-${String(i + 1).padStart(2, '0')}`);
  const fcst = [];
  const supp = [];
  for (const model of models) {
    for (const lead of [1, 2]) {
      const rows = dates.map((d, i) => day(d, { tmax: 10 + i * 0.3, prcp: i % 3, rh: null, wind: null }));
      fcst.push(...buildRecords(LOC, model, lead, rows));
      supp.push(...buildSuppRecords(LOC, model, lead, rows.map((r) => ({ ...r, rh: 60 + lead, wind: 3 }))));
    }
  }
  const obsByDate = new Map(dates.map((d, i) => [d, { date: d, tmax: 11 + i * 0.3, prcp: i % 2, rh: 70, wind: 2 }]));
  const without = groupForecasts(fcst);
  const withSupp = groupForecasts(mergeSupplement(fcst, supp));
  for (const variable of ['tmax', 'prcp']) {
    for (const lead of [1, 2]) {
      const a = buildSamples(without, obsByDate, { variable, lead, models });
      const b = buildSamples(withSupp, obsByDate, { variable, lead, models });
      assert.deepEqual(b.X, a.X, `${variable} lead ${lead}`);
      assert.deepEqual(b.y, a.y, `${variable} lead ${lead}`);
    }
  }
  // 湿度は補完ありでだけサンプルができる
  assert.equal(buildSamples(without, obsByDate, { variable: 'rh', lead: 1, models }).X.length, 0);
  assert.equal(buildSamples(withSupp, obsByDate, { variable: 'rh', lead: 1, models }).X.length, 30);
});

// ------------------------------------------------------------------ レビュー後に足した検査

const { foldHourlyToDaily, fetchPreviousRunsDaily } = await import('../scripts/lib/openmeteo.js');

test('mergeSupplement: 毎日の収集行（fetched が正時に丸めた取得時刻）とは対応づけない', () => {
  // 収集行は fetched が 16Z / 21Z。補完行は target − lead の T00:00Z
  const collected = {
    v: 1, id: 'setagaya|gfs_seamless|2024-01-19T16:00Z|2024-01-20', loc: 'setagaya', model: 'gfs_seamless',
    fetched: '2024-01-19T16:00Z', target: '2024-01-20', lead: 1, tmax: 9, prcp: 0, rh: null, wind: null,
  };
  const supp = buildSuppRecords(LOC, 'gfs_seamless', 1, [day('2024-01-20')]);
  const stats = {};
  const [m] = mergeSupplement([collected], supp, stats);
  assert.equal(m, collected);
  assert.deepEqual(stats, { supp: 1, filled: 0 });
});

test('mergeSupplement: 埋めた行数を数える。対応が崩れたことに気づけるように', () => {
  const base = buildRecords(LOC, 'gfs_seamless', 1, [day('2024-01-20', { rh: null, wind: null }), day('2024-01-21', { rh: null, wind: null })]);
  const supp = buildSuppRecords(LOC, 'gfs_seamless', 1, [day('2024-01-20'), day('2024-01-21')]);
  const stats = {};
  mergeSupplement(base, supp, stats);
  assert.deepEqual(stats, { supp: 2, filled: 2 });
  const none = {};
  mergeSupplement(base, [], none);
  assert.deepEqual(none, { supp: 0, filled: 0 });
});

test('foldHourlyToDaily: 湿度と風も 18 点に満たない日は null', () => {
  const times = Array.from({ length: 24 }, (_, h) => `2024-01-20T${String(h).padStart(2, '0')}:00`);
  const temp = times.map(() => 10);
  const sparse = times.map((_, h) => (h < 4 ? 50 : null)); // 4点だけ
  const enough = times.map((_, h) => (h < 18 ? 60 : null)); // 18点
  const [a] = foldHourlyToDaily(times, { temp, rh: sparse, wind: sparse });
  assert.equal(a.rh, null);
  assert.equal(a.wind, null);
  const [b] = foldHourlyToDaily(times, { temp, rh: enough, wind: enough });
  assert.equal(b.rh, 60);
  assert.equal(b.wind, 60);
});

test('fetchPreviousRunsDaily: 頼んだ変数が応答に無ければ投げる（黙って0件にしない）', async () => {
  const realFetch = globalThis.fetch;
  const time = Array.from({ length: 24 }, (_, h) => `2024-01-20T${String(h).padStart(2, '0')}:00`);
  const hourly = { time };
  for (const n of previousRunsNames('supp')) hourly[n] = time.map(() => 1);
  try {
    // 湿度だけ名前が変わった応答
    const renamed = { ...hourly };
    for (const k of Object.keys(renamed)) if (k.startsWith('relative_humidity_2m_')) delete renamed[k];
    globalThis.fetch = async () => new Response(JSON.stringify({ hourly: renamed }), { status: 200 });
    await assert.rejects(
      fetchPreviousRunsDaily(LOC, 'gfs_seamless', { startDate: '2024-01-20', endDate: '2024-01-20', vars: 'supp' }),
      /relative_humidity_2m_previous_day1/,
    );
    // 全部そろっていれば通る
    globalThis.fetch = async () => new Response(JSON.stringify({ hourly }), { status: 200 });
    const out = await fetchPreviousRunsDaily(LOC, 'gfs_seamless', { startDate: '2024-01-20', endDate: '2024-01-20', vars: 'supp' });
    assert.equal(out.get(1)[0].rh, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
