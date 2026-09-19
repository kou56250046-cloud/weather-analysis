// NDJSON の読み書き。追記専用で、決定論的 id により再取得しても行が増えない。
// 書き込みは一時ファイル経由の rename。途中で落ちても既存ファイルを壊さない。
import { readFile, writeFile, rename, mkdir, readdir, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { dirname, join, basename } from 'node:path';

/** NDJSON を読む。`.gz` も透過的に扱う。無ければ空配列 */
export async function readNdjson(path) {
  const gz = `${path}.gz`;
  let buf;
  if (existsSync(path)) {
    buf = await readFile(path);
  } else if (existsSync(gz)) {
    buf = gunzipSync(await readFile(gz));
  } else {
    return [];
  }
  const out = [];
  for (const line of buf.toString('utf8').split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      out.push(JSON.parse(s));
    } catch {
      // 途中で切れた行は捨てる。収集が中断された直後に起きうる
      console.warn(`[store] 壊れた行を無視: ${path}: ${s.slice(0, 80)}`);
    }
  }
  return out;
}

/** ディレクトリ配下の NDJSON をすべて読んで連結する */
export async function readNdjsonDir(dir) {
  if (!existsSync(dir)) return [];
  const names = (await readdir(dir))
    .filter((n) => n.endsWith('.ndjson') || n.endsWith('.ndjson.gz'))
    .sort();
  const seen = new Set();
  const out = [];
  for (const name of names) {
    // 同名の .ndjson と .ndjson.gz が並んだら生の方だけ読む
    const stem = name.replace(/\.gz$/, '');
    if (seen.has(stem)) continue;
    seen.add(stem);
    out.push(...(await readNdjson(join(dir, stem))));
  }
  return out;
}

/**
 * レコードを追記する。既存の id と重複するものは既定で書かない。
 *
 * `replaceExisting` を立てると、既存 id の中身を新しい値で置き換える。
 * 気象庁の日別値は後から訂正されることがあるため、直近の月だけこちらを使う。
 * どちらの経路でも行数は増えないので冪等性は保たれる。
 *
 * @returns {Promise<{added:number, updated:number, skipped:number, total:number}>}
 */
export async function upsertNdjson(path, records, { replaceExisting = false } = {}) {
  const existing = await readNdjson(path);
  if (records.length === 0) {
    return { added: 0, updated: 0, skipped: 0, total: existing.length };
  }

  const index = new Map();
  existing.forEach((r, i) => index.set(r.id, i));

  const merged = [...existing];
  let added = 0;
  let updated = 0;
  let skipped = 0;

  for (const r of records) {
    if (!r.id) {
      throw new TypeError(`id のないレコードは書けない: ${JSON.stringify(r).slice(0, 120)}`);
    }
    const at = index.get(r.id);
    if (at === undefined) {
      index.set(r.id, merged.length);
      merged.push(r);
      added++;
    } else if (replaceExisting) {
      if (JSON.stringify(merged[at]) === JSON.stringify(r)) {
        skipped++;
      } else {
        merged[at] = r;
        updated++;
      }
    } else {
      skipped++;
    }
  }

  if (added === 0 && updated === 0) {
    return { added: 0, updated: 0, skipped, total: existing.length };
  }
  await writeNdjson(path, merged);
  return { added, updated, skipped, total: merged.length };
}

/**
 * 一時ファイルを本物に差し替える。
 * Windows ではウイルス対策や検索インデックスが一瞬ファイルを掴み、rename が EPERM / EBUSY で落ちることがある。
 * 長い取得の途中でこれが1回起きるだけで全体が止まるので、少し待って数回やり直す。
 */
async function renameWithRetry(from, to, tries = 5) {
  for (let i = 1; ; i++) {
    try {
      await rename(from, to);
      return;
    } catch (err) {
      if (i >= tries || (err.code !== 'EPERM' && err.code !== 'EBUSY')) throw err;
      await new Promise((resolve) => { setTimeout(resolve, 200 * i); });
    }
  }
}

/** NDJSON を丸ごと書き直す。一時ファイル経由 */
export async function writeNdjson(path, records) {
  await mkdir(dirname(path), { recursive: true });
  const body = records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
  const tmp = `${path}.tmp`;
  await writeFile(tmp, body, 'utf8');
  await renameWithRetry(tmp, path);
  // 生を書いたら、同名の .gz は古いので消す
  const gz = `${path}.gz`;
  if (existsSync(gz)) await unlink(gz);
}

/** JSON を書く。一時ファイル経由 */
export async function writeJson(path, data, { pretty = false } = {}) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, pretty ? 2 : 0), 'utf8');
  await renameWithRetry(tmp, path);
}

/** JSON を読む。無ければ fallback */
export async function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(await readFile(path, 'utf8'));
}

/** 指定年より前の NDJSON を gzip 化して容量を抑える */
export async function compressOld(dir, keepFromYear) {
  if (!existsSync(dir)) return [];
  const done = [];
  for (const name of await readdir(dir)) {
    if (!name.endsWith('.ndjson')) continue;
    const year = Number(basename(name).slice(0, 4));
    if (!Number.isFinite(year) || year >= keepFromYear) continue;
    const path = join(dir, name);
    const raw = await readFile(path);
    await writeFile(`${path}.gz.tmp`, gzipSync(raw, { level: 9 }));
    await renameWithRetry(`${path}.gz.tmp`, `${path}.gz`);
    await unlink(path);
    done.push(name);
  }
  return done;
}

/** id を決定的に組み立てる。`|` で連結するだけ */
export function makeId(...parts) {
  for (const p of parts) {
    if (p === null || p === undefined || String(p).includes('|')) {
      throw new TypeError(`id の部品が不正: ${p}`);
    }
  }
  return parts.join('|');
}
