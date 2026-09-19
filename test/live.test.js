import test from 'node:test';
import assert from 'node:assert/strict';
import { medianCode } from '../scripts/lib/openmeteo.js';
import { consensusCode } from '../scripts/build-derived.js';

// live.js は描画に document を使うが、取得と変換の関数は使わない
const {
  fileKeys, val, parseStamp, windDirName, timeLabel,
  splitForecast, nextHours, degToDir16, radarUrl, timeline,
} = await import('../public/assets/live.js');

test('val: 品質フラグが 0 以外の値は使わない', () => {
  assert.equal(val({ temp: [23.6, 0] }, 'temp'), 23.6);
  assert.equal(val({ temp: [23.6, 1] }, 'temp'), null);
  assert.equal(val({ temp: [null, 0] }, 'temp'), null);
  assert.equal(val({ temp: 23.6 }, 'temp'), null); // 配列でない形は想定しない
  assert.equal(val({}, 'temp'), null);
  assert.equal(val(null, 'temp'), null);
});

test('val: 0 は欠測ではない', () => {
  // 降水量 0 を「値なし」にすると、降っていない時間が欠測に化ける
  assert.equal(val({ precipitation10m: [0, 0] }, 'precipitation10m'), 0);
});

test('parseStamp: アメダスの時刻は JST として読む', () => {
  const d = parseStamp('20260913193000');
  assert.equal(d.toISOString(), '2026-09-13T10:30:00.000Z');
});

test('fileKeys: 6時間ぶんを覆う3時間ファイルを並べる', () => {
  // 19:40 JST から6時間遡ると 13:40。13:30 台のブロック（12時台）まで要る
  const latest = new Date('2026-09-13T19:40:00+09:00');
  const keys = fileKeys(latest, 6);

  assert.ok(keys.length >= 3, `区間が足りない: ${keys.join(' ')}`);
  assert.ok(keys.every((k) => /^\d{8}_\d{2}$/.test(k)), `形式が違う: ${keys.join(' ')}`);
  // 新しい順ではなく古い順に並ぶ。読み込んだ順に時刻が進む
  assert.deepEqual(keys, [...keys].sort());
  // 最新のブロック（18時台）が含まれる
  assert.ok(keys.includes('20260913_18'), keys.join(' '));
  // 6時間前（13:40）を含むブロック（12時台）も含まれる
  assert.ok(keys.includes('20260913_12'), keys.join(' '));
});

test('fileKeys: 日付をまたいでも前日のファイルを拾う', () => {
  const latest = new Date('2026-09-13T01:20:00+09:00');
  const keys = fileKeys(latest, 6);
  assert.ok(keys.some((k) => k.startsWith('20260912')), `前日が無い: ${keys.join(' ')}`);
  assert.ok(keys.includes('20260913_00'), keys.join(' '));
});

test('windDirName: 0 は静穏、16 は北', () => {
  assert.equal(windDirName(0), '静穏');
  assert.equal(windDirName(16), '北');
  assert.equal(windDirName(4), '東');
  assert.equal(windDirName(8), '南');
  assert.equal(windDirName(null), '—');
  assert.equal(windDirName(99), '—');
});

test('timeLabel: 2桁に揃える', () => {
  assert.equal(timeLabel(new Date('2026-09-13T09:05:00+09:00')), '09:05');
  assert.equal(timeLabel(new Date('2026-09-13T19:40:00+09:00')), '19:40');
});

test('medianCode: 時間別と日別で同じ合議になる', () => {
  // 片方だけ直すと、同じ日の日別と時間別で違う天気マークが出る
  const cases = [
    [0, 1, 2, 3, 95],
    [61, 63, 61],
    [0, 0, 61, 63],
    [3],
    [45, 51, 95, 0, 2],
  ];
  for (const codes of cases) {
    assert.equal(medianCode(codes), consensusCode(codes), `不一致: ${codes.join(',')}`);
  }
});

test('medianCode: 空なら null', () => {
  assert.equal(medianCode([]), null);
  assert.equal(medianCode(null), null);
});

// ------------------------------------------------------------------ この先6時間

/** Open-Meteo の hourly を作る。n 本、12:00 JST から1時間刻み */
function hourly(n, over = {}) {
  const time = Array.from({ length: n }, (_, i) => `2026-09-19T${String(12 + i).padStart(2, '0')}:00`);
  return {
    time,
    temperature_2m: time.map((_, i) => 22 + i * 0.1),
    precipitation: time.map(() => 0),
    precipitation_probability: time.map(() => 10),
    weather_code: time.map(() => 3),
    wind_speed_10m: time.map(() => 2.5),
    wind_direction_10m: time.map(() => 90),
    ...over,
  };
}

test('splitForecast: 時間別が欠けても現在値は返す', () => {
  const current = { time: '2026-09-19T12:45', temperature_2m: 21.8 };
  assert.deepEqual(splitForecast({ current }).hourly, []);
  assert.deepEqual(splitForecast({ current, hourly: { time: 'x' } }).hourly, []);
  // 列の長さが time と違うと、どの値がどの時刻か分からない
  const broken = hourly(10, { precipitation: [0, 0] });
  assert.deepEqual(splitForecast({ current, hourly: broken }).hourly, []);
  const good = hourly(10);
  assert.equal(splitForecast({ current, hourly: good }).hourly, good);
  assert.equal(splitForecast({ current, hourly: good }).current, current);
});

test('splitForecast: 現在値が無ければ例外', () => {
  assert.throws(() => splitForecast({ hourly: hourly(10) }));
  assert.throws(() => splitForecast(null));
});

test('nextHours: JST として読み、起点より後を6本返す', () => {
  const after = new Date('2026-09-19T12:40:00+09:00');
  const rows = nextHours(hourly(10), after);
  assert.equal(rows.length, 6);
  assert.equal(rows[0].at.toISOString(), '2026-09-19T04:00:00.000Z'); // 13:00 JST
  assert.equal(rows[5].at.toISOString(), '2026-09-19T09:00:00.000Z'); // 18:00 JST
});

test('nextHours: 起点ちょうどの正時は含めない', () => {
  const rows = nextHours(hourly(10), new Date('2026-09-19T13:00:00+09:00'));
  assert.equal(timeLabel(rows[0].at), '14:00');
});

test('nextHours: 足りなければ取れた分だけ返す', () => {
  const rows = nextHours(hourly(4), new Date('2026-09-19T12:40:00+09:00'));
  assert.equal(rows.length, 3);
  assert.deepEqual(nextHours([], new Date()), []);
  assert.deepEqual(nextHours(hourly(4), null), []);
});

test('nextHours: 欠けた値は null のまま。0 は 0', () => {
  const h = hourly(10, { temperature_2m: Array(10).fill(null), weather_code: Array(10).fill(null) });
  const [r] = nextHours(h, new Date('2026-09-19T12:40:00+09:00'));
  assert.equal(r.temp, null);
  assert.equal(r.code, null);
  assert.equal(r.prcp, 0);
  assert.equal(r.windDirection, 4); // 90度は東
});

test('degToDir16: 度を16方位の番号に直す', () => {
  assert.equal(degToDir16(0), 16);
  assert.equal(degToDir16(360), 16);
  assert.equal(degToDir16(350), 16);
  assert.equal(degToDir16(90), 4);
  assert.equal(degToDir16(180), 8);
  assert.equal(degToDir16(22.5), 1);
  assert.equal(degToDir16(null), null);
  assert.equal(windDirName(degToDir16(270)), '西');
});

test('radarUrl: 気象庁の雨雲の動きを地点付近で開く', () => {
  const url = radarUrl({ lat: 35.689487, lon: 139.691706 });
  assert.equal(url,
    'https://www.jma.go.jp/bosai/nowc/#zoom:10/lat:35.689/lon:139.692/colordepth:normal/elements:hrpns&slmcs');
});

test('nextHours: 風速 0 は静穏。方位を出さない', () => {
  const h = hourly(10, { wind_speed_10m: Array(10).fill(0), wind_direction_10m: Array(10).fill(0) });
  const [r] = nextHours(h, new Date('2026-09-19T12:40:00+09:00'));
  assert.equal(windDirName(r.windDirection), '静穏');
});

test('timeLabel: ブラウザのタイムゾーンに依らず JST で出す', () => {
  // UTC 03:00 は JST 12:00。実行環境が UTC でも 12:00 になる
  assert.equal(timeLabel(new Date('2026-09-19T03:00:00Z')), '12:00');
  assert.equal(timeLabel(new Date('2026-09-19T15:30:00Z')), '00:30');
});

test('timeline: アメダスの行が抜けても時刻どおりに置き、抜けた枠は空にする', () => {
  const at = (hm) => new Date(`2026-09-19T${hm}:00+09:00`);
  // 09:00〜11:50 のファイルが取れず、行が飛んでいる
  const rows = [at('08:40'), at('08:50'), at('12:00'), at('12:10')].map((d) => ({ at: d, temp: 20 }));
  const fc = [{ at: at('13:00'), temp: 21 }, { at: at('14:00'), temp: 22 }];
  const tl = timeline(rows, fc);

  assert.equal(tl.nowIdx, 21); // 08:40 から 12:10 まで 21 枠
  assert.equal(tl.slots[2].obs, null); // 09:00 は抜けている
  assert.equal(tl.slots[20].obs, rows[2]); // 12:00
  assert.deepEqual(tl.fcAt.map((r) => r.i), [26, 32]);
  assert.equal(tl.slots.length, 33);
  assert.equal(timeLabel(tl.slots[32].at), '14:00');
});
