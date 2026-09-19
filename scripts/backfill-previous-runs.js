// 過去に出された予報を遡って取る。検証とバイアス補正のタネになる。
//
// これが無いと、精度の話ができるようになるまで半年待つことになる。
// Previous Runs API は lead 1〜7 の予報を数年分遡れるので、初日から検証できる。
// lead 8 以降に遡れる手段は無い。そこは今日から溜まるのを待つ。
//
// 変数を増やすと API の課金単位（call）が増える。既定は気温と降水だけにする。
// 湿度と風は --vars all で足せるが、期間を短くしないと1日の上限に近づく。
//
// 使い方:
//   node scripts/backfill-previous-runs.js                      2024-01-01 から昨日まで
//   node scripts/backfill-previous-runs.js --from 2025-01-01
//   node scripts/backfill-previous-runs.js --vars all --from 2026-01-01
//   node scripts/backfill-previous-runs.js --models jma_seamless --from 2018-01-01
//   node scripts/backfill-previous-runs.js --supplement --to 2025-04-30
//
// --supplement は、気温と降水だけで取った既存の予報に、湿度と風を後から補う。
// 既存の予報行は書き換えず、data/fcst-supp に別の行として追記する（build-derived が読むときに合流する）。
// 取り終えた区間は _done.json に記録し、再実行したときは API を叩かずに飛ばす。
// _done.json が壊れたら消して取り直せばよい。行の id は決定的なので、取り直しても行は増えない。
import { MODELS, fetchPreviousRunsDaily } from './lib/openmeteo.js';
import { upsertNdjson, readJson, writeJson, makeId } from './lib/store.js';
import {
  LOCATIONS_PATH, fcstPath, fcstSuppPath, fcstSuppDonePath,
} from './lib/paths.js';
import { toJstDate, addDays, diffDays, monthKey } from './lib/time.js';
import { runIfMain } from './lib/main.js';

const SCHEMA = 1;
const LEADS = [1, 2, 3, 4, 5, 6, 7];

/** 1リクエストで取る日数。長くすると call の重みが増える */
const CHUNK_DAYS = 90;

/**
 * --supplement のリクエスト間隔。1リクエストの重みは約 13.5 call（21変数 × 90日）。
 * 600 call/分の上限に対して余裕を持たせる（約 24 リクエスト/分 ≈ 325 call/分）
 */
const SUPP_GAP_MS = 2500;

/**
 * --supplement 1回の上限。2.5 秒間隔だと1時間あたり 5,000 call の枠を1回で使い切れるので、
 * 1日の枠（10,000）ではなく1時間の枠に合わせる。超えるなら --from / --to で分け、1時間空ける
 */
const SUPP_MAX_CALLS = 4500;

/** 既定の開始日。ほとんどのモデルのアーカイブはここから */
const DEFAULT_FROM = '2024-01-01';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/** 期間を CHUNK_DAYS ごとに区切る */
export function chunkRange(from, to, days = CHUNK_DAYS) {
  const out = [];
  let start = from;
  while (diffDays(start, to) >= 0) {
    const end = diffDays(start, to) < days ? to : addDays(start, days - 1);
    out.push({ start, end });
    start = addDays(end, 1);
  }
  return out;
}

/**
 * lead 別の日別予報をレコードにする。
 * `fetched` は「その予報が出ていたはずの日」。lead 日前の朝として組み立てる。
 * 実際の初期時刻は API から分からないので、lead を基準に逆算した目安である。
 */
export function buildRecords(loc, model, lead, rows) {
  const out = [];
  for (const row of rows) {
    if (row.tmax === null && row.prcp === null) continue;
    const issuedDay = addDays(row.date, -lead);
    const fetched = `${issuedDay}T00:00Z`; // 便宜上の発表時刻。lead が真の情報
    out.push({
      v: SCHEMA,
      id: makeId(loc.key, model, fetched, row.date),
      loc: loc.key,
      model,
      fetched,
      target: row.date,
      lead,
      tavg: row.tavg,
      tmax: row.tmax,
      tmin: row.tmin,
      prcp: row.prcp,
      rh: row.rh,
      wind: row.wind,
      sun: row.sun,
      code: null,
      pop: null,
      q: null,
      members: null,
      src: 'previous-runs',
    });
  }
  return out;
}

// ------------------------------------------------------------------ 湿度と風の補完

/**
 * 湿度と風だけを持つ補完行。既存の previous-runs 行と同じ組み立てで fetched を作り、
 * build-derived が (model, fetched, target) で対応づけられるようにする。
 * id は既存行の id に '|rhwind' を付けたもの。取り直しても同じ id になる。
 */
export function buildSuppRecords(loc, model, lead, rows) {
  const out = [];
  for (const row of rows) {
    if (row.rh === null && row.wind === null) continue;
    const fetched = `${addDays(row.date, -lead)}T00:00Z`;
    out.push({
      v: SCHEMA,
      id: `${makeId(loc.key, model, fetched, row.date)}|rhwind`,
      loc: loc.key,
      model,
      fetched,
      target: row.date,
      lead,
      rh: row.rh,
      wind: row.wind,
      src: 'previous-runs-supp',
    });
  }
  return out;
}

/**
 * 区間の全日が、同じモデルの完了記録のどれかに入っているか。
 * 日付単位で見るので、--from を変えて区間の区切りが変わっても効く。
 */
export function isChunkDone(done, model, { start, end }) {
  const ranges = done.filter((d) => d.model === model);
  if (ranges.length === 0) return false;
  for (let day = start; diffDays(day, end) >= 0; day = addDays(day, 1)) {
    if (!ranges.some((r) => diffDays(r.start, day) >= 0 && diffDays(day, r.end) >= 0)) return false;
  }
  return true;
}

/**
 * Open-Meteo の重みでの概算。変数が10を超える分と、期間が2週を超える分が小数で効く。
 * @param {Array<{start:string,end:string}>} chunks 実際にリクエストする区間（地点・モデル分を並べたもの）
 */
export function estimateCalls(chunks, varCount) {
  let total = 0;
  for (const { start, end } of chunks) {
    const days = diffDays(start, end) + 1;
    total += Math.max(1, varCount / 10) * Math.max(1, days / 14);
  }
  return Math.round(total);
}

const sleepMs = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

async function mainSupplement({ from, to, models, dryRun, cfg }) {
  const chunks = chunkRange(from, to);
  const varCount = 3 * LEADS.length;

  // 取り終えた区間を除く
  const doneByLoc = new Map();
  const jobs = [];
  for (const loc of cfg.locations) {
    const done = await readJson(fcstSuppDonePath(loc.key), []);
    doneByLoc.set(loc.key, done);
    for (const model of models) {
      for (const chunk of chunks) {
        if (!isChunkDone(done, model, chunk)) jobs.push({ loc, model, chunk });
      }
    }
  }
  const skipped = cfg.locations.length * models.length * chunks.length - jobs.length;
  const estCalls = estimateCalls(jobs.map((j) => j.chunk), varCount);

  console.log(`補完（湿度・風） 期間 ${from} 〜 ${to}（${chunks.length} 区間）`);
  console.log(`地点 ${cfg.locations.length} × モデル ${models.length} × 変数 ${varCount}`);
  console.log(`取得済みで飛ばす区間 ${skipped}、取りに行く区間 ${jobs.length}`);
  console.log(`API 呼び出しの概算 ${estCalls} call（1回の上限 ${SUPP_MAX_CALLS}。1時間の枠 5,000）`);
  if (jobs.length === 0) {
    console.log('取得済みで全区間を飛ばした');
    return;
  }
  if (estCalls > SUPP_MAX_CALLS) {
    console.error(`1時間の枠（5,000）に近い（上限 ${SUPP_MAX_CALLS}）。--from / --to で期間を分け、1時間空けて実行すること。中止する`);
    process.exitCode = 1;
    return;
  }
  console.log('');

  let added = 0;
  let failed = 0;
  for (const [n, { loc, model, chunk }] of jobs.entries()) {
    if (n > 0) await sleepMs(SUPP_GAP_MS);
    let byLead;
    try {
      // 頼んだ変数が応答に1つでも無ければ fetchPreviousRunsDaily が投げる。
      // 変数名が変わったのに「0件で完了」と記録して二度と取らない、を避ける
      byLead = await fetchPreviousRunsDaily(loc, model, {
        startDate: chunk.start, endDate: chunk.end, leads: LEADS, vars: 'supp',
      });
    } catch (err) {
      // どんな失敗も完了にしない。4xx も含め、ログに残して次の実行で取り直す
      failed++;
      console.error(`  ${loc.key}/${model} ${chunk.start}: ${err.message.slice(0, 90)}`);
      continue;
    }

    let chunkAdded = 0;
    for (const [lead, rows] of byLead) {
      const byMonth = new Map();
      for (const r of buildSuppRecords(loc, model, lead, rows)) {
        const k = monthKey(r.target);
        if (!byMonth.has(k)) byMonth.set(k, []);
        byMonth.get(k).push(r);
      }
      for (const [month, batch] of byMonth) {
        if (dryRun) { chunkAdded += batch.length; continue; }
        chunkAdded += (await upsertNdjson(fcstSuppPath(loc.key, month), batch)).added;
      }
    }
    added += chunkAdded;

    // 全 lead を書き終えてから完了を記録する。途中で止まった区間は次の実行で取り直す
    if (!dryRun) {
      const done = doneByLoc.get(loc.key);
      done.push({ model, start: chunk.start, end: chunk.end });
      await writeJson(fcstSuppDonePath(loc.key), done, { pretty: true });
    }
    console.log(`${loc.key.padEnd(12)} ${model.padEnd(22)} ${chunk.start} 〜 ${chunk.end}  ${chunkAdded} 件`);
  }

  console.log('');
  console.log(dryRun ? `dry-run: ${added} 件（書き込んでいない）` : `合計 ${added} 件追加、${failed} 区間が失敗`);
  if (failed > 0) console.log('失敗した区間は、時間を空けて同じコマンドを再実行すれば取り直す');
}

async function main() {
  const from = arg('--from', DEFAULT_FROM);
  const to = arg('--to', addDays(toJstDate(new Date()), -1));
  const models = arg('--models') ? arg('--models').split(',') : MODELS;
  const allVars = arg('--vars') === 'all';
  const dryRun = process.argv.includes('--dry-run');

  const cfg = await readJson(LOCATIONS_PATH);
  if (!cfg) throw new Error('config/locations.json が無い。先に resolve-locations.js を走らせる');

  if (process.argv.includes('--supplement')) {
    // まだ出ていない予報まで区間に入れると、欠けたまま完了と記録して二度と取らない。昨日で打ち切る
    const yesterday = addDays(toJstDate(new Date()), -1);
    const suppTo = diffDays(to, yesterday) < 0 ? yesterday : to;
    if (suppTo !== to) console.log(`--to ${to} は未来を含むので ${suppTo} で打ち切る`);
    await mainSupplement({
      from, to: suppTo, models, dryRun, cfg,
    });
    return;
  }

  const chunks = chunkRange(from, to);
  const varCount = (allVars ? 5 : 2) * LEADS.length;
  const estCalls = cfg.locations.length * models.length * chunks.length
    * Math.max(1, Math.ceil(varCount / 10)) * Math.max(1, Math.ceil(CHUNK_DAYS / 14));

  console.log(`期間 ${from} 〜 ${to}（${chunks.length} 区間）`);
  console.log(`地点 ${cfg.locations.length} × モデル ${models.length} × 変数 ${varCount}`);
  console.log(`API 呼び出しの概算 ${estCalls} call（1日の上限 10,000）`);
  if (estCalls > 8000) {
    console.error('上限に近い。--from を短くするか --models で絞ること。中止する');
    process.exitCode = 1;
    return;
  }
  console.log('');

  let added = 0;
  let failed = 0;

  for (const loc of cfg.locations) {
    for (const model of models) {
      let locAdded = 0;
      for (const { start, end } of chunks) {
        try {
          const byLead = await fetchPreviousRunsDaily(loc, model, {
            startDate: start,
            endDate: end,
            leads: LEADS,
            vars: allVars ? 'all' : 'core',
          });
          for (const [lead, rows] of byLead) {
            const records = buildRecords(loc, model, lead, rows);
            const byMonth = new Map();
            for (const r of records) {
              const k = monthKey(r.target);
              if (!byMonth.has(k)) byMonth.set(k, []);
              byMonth.get(k).push(r);
            }
            for (const [month, batch] of byMonth) {
              if (dryRun) { locAdded += batch.length; continue; }
              locAdded += (await upsertNdjson(fcstPath(loc.key, month), batch)).added;
            }
          }
        } catch (err) {
          // モデルによってはアーカイブの開始が遅い。区間ごとに諦めて先へ進む
          failed++;
          console.error(`  ${loc.key}/${model} ${start}: ${err.message.slice(0, 90)}`);
        }
      }
      added += locAdded;
      console.log(`${loc.key.padEnd(12)} ${model.padEnd(22)} ${locAdded} 件`);
    }
  }

  console.log('');
  console.log(dryRun ? `dry-run: ${added} 件（書き込んでいない）` : `合計 ${added} 件追加、${failed} 区間が失敗`);
}

runIfMain(import.meta.url, main);
