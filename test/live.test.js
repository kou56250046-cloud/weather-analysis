import test from 'node:test';
import assert from 'node:assert/strict';
import { medianCode } from '../scripts/lib/openmeteo.js';
import { consensusCode } from '../scripts/build-derived.js';

// live.js は描画に document を使うが、取得と変換の関数は使わない
const { fileKeys, val, parseStamp, windDirName, timeLabel } = await import('../public/assets/live.js');

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
