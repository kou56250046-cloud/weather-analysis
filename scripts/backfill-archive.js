// ERA5 再解析の日別値を取る。長期トレンドの表示に使う。
//
// これは予報の検証には使わない。検証の真値は気象庁の観測値（data/obs）。
// ERA5 は格子点の再解析値なので、観測点の実測とは系統的にずれる。
// 重ねて表示するときは、重複期間の差の中央値でオフセットを合わせる。
//
// Open-Meteo の無料枠には1日あたりの上限がある。86年分を4地点まとめて取ると
// 途中で HTTP 429 が返って歯抜けになる。取得済みの区間は飛ばすので、
// 429 が出たら日を改めてもう一度走らせれば続きから埋まる。
//
// 使い方:
//   node scripts/backfill-archive.js                 1940-01-01 から取れるところまで
//   node scripts/backfill-archive.js --from 1991-01-01
import { fetchArchiveDaily } from './lib/openmeteo.js';
import { upsertNdjson, readNdjson, readJson, makeId } from './lib/store.js';
import { LOCATIONS_PATH, archivePath } from './lib/paths.js';
import { toJstDate, addDays, diffDays } from './lib/time.js';
import { runIfMain } from './lib/main.js';

const SCHEMA = 1;

/** ERA5 は 5 日遅れ。余裕を見て 7 日前までにする */
const LAG_DAYS = 7;

/** 1リクエストの年数。長くすると call の重みが増える */
const CHUNK_YEARS = 5;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

export function chunkYears(from, to, years = CHUNK_YEARS) {
  const out = [];
  let startYear = Number(from.slice(0, 4));
  const endYear = Number(to.slice(0, 4));
  while (startYear <= endYear) {
    const chunkEndYear = Math.min(startYear + years - 1, endYear);
    const start = startYear === Number(from.slice(0, 4)) ? from : `${startYear}-01-01`;
    const end = chunkEndYear === endYear ? to : `${chunkEndYear}-12-31`;
    out.push({ start, end });
    startYear = chunkEndYear + 1;
  }
  return out;
}

async function main() {
  const from = arg('--from', '1940-01-01');
  const to = arg('--to', addDays(toJstDate(new Date()), -LAG_DAYS));
  const dryRun = process.argv.includes('--dry-run');

  const cfg = await readJson(LOCATIONS_PATH);
  if (!cfg) throw new Error('config/locations.json が無い。先に resolve-locations.js を走らせる');

  const chunks = chunkYears(from, to);
  console.log(`期間 ${from} 〜 ${to}（${chunks.length} 区間 × ${cfg.locations.length} 地点）`);
  console.log(`概算 ${diffDays(from, to)} 日分 / 地点`);
  console.log('');

  let added = 0;
  let skipped = 0;
  for (const loc of cfg.locations) {
    let locAdded = 0;
    // 既にある日付を見て、埋まっている区間は取りに行かない。
    // ERA5 は 429 を返すことがあるので、中断しても再実行で続きから埋まるようにする
    const have = new Set((await readNdjson(archivePath(loc.key))).map((r) => r.date));

    for (const { start, end } of chunks) {
      const expected = diffDays(start, end) + 1;
      let present = 0;
      for (let d = start; diffDays(d, end) >= 0; d = addDays(d, 1)) {
        if (have.has(d)) present++;
      }
      // 9割以上あれば埋まっているとみなす。ERA5 に無い日が混ざっていても止まらない
      if (present >= expected * 0.9) { skipped++; continue; }

      try {
        const rows = await fetchArchiveDaily(loc, { startDate: start, endDate: end });
        const records = rows
          .filter((r) => r.tmax !== null || r.tmin !== null || r.prcp !== null)
          .map((r) => ({
            v: SCHEMA,
            id: makeId(loc.key, r.date),
            loc: loc.key,
            date: r.date,
            src: 'era5',
            tmax: r.tmax, tmin: r.tmin, prcp: r.prcp,
          }));
        if (dryRun) { locAdded += records.length; continue; }
        locAdded += (await upsertNdjson(archivePath(loc.key), records)).added;
        process.stdout.write('.');
      } catch (err) {
        console.error(`\n  ${loc.key} ${start}〜${end}: ${err.message.slice(0, 100)}`);
      }
    }
    added += locAdded;
    console.log(`\n${loc.key.padEnd(12)} ${locAdded} 日分`);
  }

  console.log('');
  console.log(dryRun
    ? `dry-run: ${added} 件（書き込んでいない）`
    : `合計 ${added} 件追加、${skipped} 区間は既に埋まっていたので省略`);
}

runIfMain(import.meta.url, main);
