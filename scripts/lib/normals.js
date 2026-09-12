// 平年値と長期集計。
//
// 平年値は気象庁が公表している 1991-2020 の日別平年値をそのまま使う。
// 30年分の日別値を自分で平均する手もあるが、公表値には観測所の移転補正などの
// 統計処理が入っており、自前集計だと公表値と一致しない。
//
// ERA5 から作らないのは、格子点の再解析値が観測点の実測と系統的にずれるため。
// 「今年は平年より暑い」を言うとき、平年値と今年の値が同じ物差しでないと意味がない。
import { normalKey, dayOfYear } from './time.js';
import { usableObs } from './verify.js';

/** 平年値の基準期間 */
export const NORMAL_FROM = 1991;
export const NORMAL_TO = 2020;

/** 平年値を出す変数 */
export const NORMAL_VARS = ['tavg', 'tmax', 'tmin', 'prcp', 'sun'];

/** 'MM-DD' を 1-365 の通し番号に直す。2/29 は 2/28 と同じ番号 */
function keyToIndex(key) {
  return dayOfYear(`2001-${key}`); // 2001 は平年
}

/**
 * 気象庁の公式平年値（月ごとの表）を 1-365 の日別配列に組み直す。
 * うるう日 2/29 は表に載るが、平年の暦に合わせて 2/28 に寄せる。
 *
 * 平滑化はしない。気象庁側で既に統計処理が済んでいる値なので、
 * こちらで均すと公表値と一致しなくなる。
 *
 * @param {Map<number, Array<{day:number, values:object}>>} byMonth 月 → 日別行
 */
export function buildNormals(byMonth, { from = NORMAL_FROM, to = NORMAL_TO } = {}) {
  const days = [];
  for (let index = 1; index <= 365; index++) {
    const key = indexToKey(index);
    const month = Number(key.slice(0, 2));
    const day = Number(key.slice(3, 5));
    const row = byMonth.get(month)?.find((r) => r.day === day);
    const entry = { key, index };
    for (const v of NORMAL_VARS) {
      entry[v] = row ? round(row.values[v] ?? null, 2) : null;
    }
    days.push(entry);
  }
  const missing = days.filter((d) => d.tmax === null).length;
  return { days, from, to, source: 'jma-official', missingDays: missing };
}

/** 1-365 の通し番号を 'MM-DD' に直す */
function indexToKey(index) {
  return new Date(Date.UTC(2001, 0, index)).toISOString().slice(5, 10);
}

/** 日付から平年値を引く */
export function normalFor(normals, date, variable) {
  const idx = keyToIndex(normalKey(date));
  return normals.days[idx - 1]?.[variable] ?? null;
}

/**
 * ERA5 と実測の系統差。重複期間の差の中央値で測る。
 * ERA5 の長期トレンドを実測と並べて見せるとき、この分だけずらす。
 */
export function era5Offset(archiveRows, obsRows, variable = 'tmax') {
  const obsByDate = new Map(obsRows.map((r) => [r.date, r]));
  const diffs = [];
  for (const a of archiveRows) {
    const o = obsByDate.get(a.date);
    if (!o) continue;
    const ov = usableObs(o, variable);
    const av = a[variable];
    if (ov === null || av === null || av === undefined) continue;
    diffs.push(av - ov);
  }
  if (diffs.length < 30) return { offset: null, n: diffs.length };
  diffs.sort((x, y) => x - y);
  const mid = Math.floor(diffs.length / 2);
  const median = diffs.length % 2 ? diffs[mid] : (diffs[mid - 1] + diffs[mid]) / 2;
  return { offset: round(median, 3), n: diffs.length };
}

/** 年ごとの集計。分析タブの長期トレンド用 */
export function yearlyStats(rows, { source = 'obs' } = {}) {
  const byYear = new Map();
  const get = source === 'obs' ? usableObs : (r, k) => (r[k] ?? null);

  for (const row of rows) {
    const year = Number(row.date.slice(0, 4));
    if (!byYear.has(year)) {
      byYear.set(year, {
        year, days: 0,
        tmaxSum: 0, tmaxN: 0, tminSum: 0, tminN: 0, tavgSum: 0, tavgN: 0,
        prcpSum: 0, prcpN: 0,
        manatsu: 0, mousho: 0, natsubi: 0, nettaiya: 0, mafuyu: 0, fuyubi: 0,
        rainDays: 0,
      });
    }
    const y = byYear.get(year);
    y.days++;
    const tmax = get(row, 'tmax');
    const tmin = get(row, 'tmin');
    const tavg = get(row, 'tavg');
    const prcp = get(row, 'prcp');

    if (tmax !== null) {
      y.tmaxSum += tmax; y.tmaxN++;
      if (tmax >= 25) y.natsubi++;      // 夏日
      if (tmax >= 30) y.manatsu++;      // 真夏日
      if (tmax >= 35) y.mousho++;       // 猛暑日
      if (tmax < 0) y.mafuyu++;         // 真冬日
    }
    if (tmin !== null) {
      y.tminSum += tmin; y.tminN++;
      if (tmin >= 25) y.nettaiya++;     // 熱帯夜
      if (tmin < 0) y.fuyubi++;         // 冬日
    }
    if (tavg !== null) { y.tavgSum += tavg; y.tavgN++; }
    if (prcp !== null) {
      y.prcpSum += prcp; y.prcpN++;
      if (prcp >= 1.0) y.rainDays++;
    }
  }

  return [...byYear.values()]
    .sort((a, b) => a.year - b.year)
    .map((y) => ({
      year: y.year,
      days: y.days,
      // 観測日数が足りない年は平均を出さない。年の途中で始まった年を混ぜない
      complete: y.days >= 350,
      tmax: y.tmaxN ? round(y.tmaxSum / y.tmaxN, 2) : null,
      tmin: y.tminN ? round(y.tminSum / y.tminN, 2) : null,
      tavg: y.tavgN ? round(y.tavgSum / y.tavgN, 2) : null,
      prcp: y.prcpN ? round(y.prcpSum, 1) : null,
      natsubi: y.natsubi,
      manatsu: y.manatsu,
      mousho: y.mousho,
      nettaiya: y.nettaiya,
      fuyubi: y.fuyubi,
      mafuyu: y.mafuyu,
      rainDays: y.rainDays,
    }));
}

function round(n, digits) {
  if (n === null || !Number.isFinite(n)) return null;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
