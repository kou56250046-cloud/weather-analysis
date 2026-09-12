// 時刻の変換をここに集約する。
// 生データの `run` は UTC、`target` / `date` は JST の暦日。
// 取り違えると検証が丸ごと1日ずれるので、素の Date 演算を他所で書かない。

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Date | ISO文字列 → JST の暦日 'YYYY-MM-DD' */
export function toJstDate(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) throw new TypeError(`invalid date: ${input}`);
  return new Date(d.getTime() + JST_OFFSET_MS).toISOString().slice(0, 10);
}

/** JST の暦日 'YYYY-MM-DD' → その日の 00:00 JST を表す Date */
export function jstDateToUtc(ymd) {
  assertYmd(ymd);
  return new Date(Date.parse(`${ymd}T00:00:00+09:00`));
}

/** Date | ISO文字列 → 'YYYY-MM-DDTHH:mmZ'（分まで。秒以下は捨てる） */
export function toRunStamp(input) {
  const d = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(d.getTime())) throw new TypeError(`invalid date: ${input}`);
  return `${d.toISOString().slice(0, 16)}Z`;
}

/** 2つの JST 暦日の差（日数）。b - a */
export function diffDays(a, b) {
  assertYmd(a);
  assertYmd(b);
  return Math.round((jstDateToUtc(b) - jstDateToUtc(a)) / DAY_MS);
}

/** JST 暦日に n 日足す */
export function addDays(ymd, n) {
  assertYmd(ymd);
  return toJstDate(new Date(jstDateToUtc(ymd).getTime() + n * DAY_MS + JST_OFFSET_MS));
}

/**
 * リードタイム（日）。run（UTC）の JST 暦日から target までの日数。
 * 12UTC の run は JST では同日 21:00 なので、翌日の予報が lead=1 になる。
 */
export function leadDays(runIso, targetYmd) {
  return diffDays(toJstDate(runIso), targetYmd);
}

/** 'YYYY-MM' 形式の月キー */
export function monthKey(ymd) {
  assertYmd(ymd);
  return ymd.slice(0, 7);
}

/** 年 */
export function yearKey(ymd) {
  assertYmd(ymd);
  return ymd.slice(0, 4);
}

/** 通日（1-366）。季節項の sin/cos に使う */
export function dayOfYear(ymd) {
  assertYmd(ymd);
  const y = Number(ymd.slice(0, 4));
  return diffDays(`${y}-01-01`, ymd) + 1;
}

/** 季節項 [sin, cos]。周期は 365.2425 日 */
export function seasonTerms(ymd) {
  const t = (2 * Math.PI * dayOfYear(ymd)) / 365.2425;
  return [Math.sin(t), Math.cos(t)];
}

/** うるう日を 2/28 に寄せた 'MM-DD'。平年値の索引に使う */
export function normalKey(ymd) {
  assertYmd(ymd);
  const md = ymd.slice(5);
  return md === '02-29' ? '02-28' : md;
}

/** 現在時刻の JST ISO 文字列（ログ用） */
export function nowJstIso(now = new Date()) {
  return `${new Date(now.getTime() + JST_OFFSET_MS).toISOString().slice(0, 19)}+09:00`;
}

function assertYmd(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new TypeError(`expected YYYY-MM-DD, got: ${s}`);
  }
}

export { DAY_MS, JST_OFFSET_MS };
