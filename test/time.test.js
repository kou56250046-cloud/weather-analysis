import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toJstDate, jstDateToUtc, toRunStamp, diffDays, addDays,
  leadDays, dayOfYear, seasonTerms, normalKey,
} from '../scripts/lib/time.js';

test('toJstDate: UTC から JST の暦日へ', () => {
  assert.equal(toJstDate('2026-09-12T12:00:00Z'), '2026-09-12'); // JST 21:00 同日
  assert.equal(toJstDate('2026-09-12T15:00:00Z'), '2026-09-13'); // JST 00:00 翌日
  assert.equal(toJstDate('2026-09-12T14:59:59Z'), '2026-09-12');
  assert.equal(toJstDate('2026-01-01T00:00:00Z'), '2026-01-01');
});

test('toJstDate: 不正な入力は投げる', () => {
  assert.throws(() => toJstDate('not-a-date'), TypeError);
});

test('jstDateToUtc: JST 00:00 を指す', () => {
  assert.equal(jstDateToUtc('2026-09-12').toISOString(), '2026-09-11T15:00:00.000Z');
});

test('toRunStamp: 分までに丸める', () => {
  assert.equal(toRunStamp('2026-09-12T12:00:37.412Z'), '2026-09-12T12:00Z');
});

test('diffDays: 月またぎとうるう年', () => {
  assert.equal(diffDays('2026-09-12', '2026-09-15'), 3);
  assert.equal(diffDays('2026-09-15', '2026-09-12'), -3);
  assert.equal(diffDays('2024-02-28', '2024-03-01'), 2); // 2024 はうるう年
  assert.equal(diffDays('2026-02-28', '2026-03-01'), 1);
  assert.equal(diffDays('2025-12-31', '2026-01-01'), 1);
});

test('addDays: 年またぎ', () => {
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(addDays('2026-01-01', -1), '2025-12-31');
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2026-09-12', 0), '2026-09-12');
});

test('leadDays: run の JST 暦日から数える', () => {
  assert.equal(leadDays('2026-09-12T12:00Z', '2026-09-12'), 0);
  assert.equal(leadDays('2026-09-12T12:00Z', '2026-09-19'), 7);
  // 00UTC の run は JST 09:00 同日。当日予報が lead=0
  assert.equal(leadDays('2026-09-12T00:00Z', '2026-09-12'), 0);
  // 18UTC の run は JST 翌日 03:00。翌日予報が lead=0 になる
  assert.equal(leadDays('2026-09-12T18:00Z', '2026-09-13'), 0);
});

test('dayOfYear', () => {
  assert.equal(dayOfYear('2026-01-01'), 1);
  assert.equal(dayOfYear('2026-12-31'), 365);
  assert.equal(dayOfYear('2024-12-31'), 366);
});

test('seasonTerms: 単位円上にある', () => {
  for (const d of ['2026-01-01', '2026-04-15', '2026-08-31', '2026-11-07']) {
    const [s, c] = seasonTerms(d);
    assert.ok(Math.abs(s * s + c * c - 1) < 1e-12, d);
  }
});

test('normalKey: うるう日は 02-28 に寄せる', () => {
  assert.equal(normalKey('2024-02-29'), '02-28');
  assert.equal(normalKey('2026-07-04'), '07-04');
});
