// 収集の成否を残す。失敗を握りつぶさず、画面から「いつ何が落ちたか」を見えるようにする。
import { join } from 'node:path';
import { upsertNdjson, readNdjson, makeId } from './store.js';
import { nowJstIso } from './time.js';
import { DATA_DIR } from './paths.js';

const LOG_PATH = join(DATA_DIR, 'collect-log.ndjson');

/** 直近 N 件だけ残す。無限に伸びても意味がない */
const KEEP = 400;

/**
 * 1回の収集ジョブの結果を記録する。
 * @param {object} entry
 * @param {string} entry.job      'forecast' | 'observation' | 'jma-forecast' | 'derive' | ...
 * @param {boolean} entry.ok
 * @param {number} [entry.added]
 * @param {string[]} [entry.errors]
 * @param {number} [entry.durationMs]
 */
export async function writeCollectLog(entry) {
  const ts = nowJstIso();
  const rec = {
    v: 1,
    id: makeId(entry.job, ts),
    ts,
    job: entry.job,
    ok: Boolean(entry.ok),
    added: entry.added ?? 0,
    errors: entry.errors ?? [],
    durationMs: entry.durationMs ?? 0,
  };
  const existing = await readNdjson(LOG_PATH);
  const trimmed = existing.slice(-(KEEP - 1));
  const { writeNdjson } = await import('./store.js');
  await writeNdjson(LOG_PATH, [...trimmed, rec]);
  return rec;
}

/** ログを読む */
export async function readCollectLog() {
  return readNdjson(LOG_PATH);
}

/**
 * ジョブを走らせて結果を必ず記録する。
 * 例外は握りつぶさずログに残したうえで再送出する。呼び出し側で他ジョブと切り離す。
 */
export async function runJob(job, fn) {
  const started = Date.now();
  const errors = [];
  let added = 0;
  let ok = false;
  try {
    const result = (await fn(errors)) ?? {};
    added = result.added ?? 0;
    ok = errors.length === 0;
    return result;
  } catch (err) {
    errors.push(`${err.name}: ${err.message}`);
    throw err;
  } finally {
    await writeCollectLog({ job, ok, added, errors, durationMs: Date.now() - started });
  }
}

export { LOG_PATH };
