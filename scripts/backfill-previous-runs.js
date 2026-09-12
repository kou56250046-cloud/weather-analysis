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
import { MODELS, fetchPreviousRunsDaily } from './lib/openmeteo.js';
import { upsertNdjson, readJson, makeId } from './lib/store.js';
import { LOCATIONS_PATH, fcstPath } from './lib/paths.js';
import { toJstDate, addDays, diffDays, monthKey } from './lib/time.js';

const SCHEMA = 1;
const LEADS = [1, 2, 3, 4, 5, 6, 7];

/** 1リクエストで取る日数。長くすると call の重みが増える */
const CHUNK_DAYS = 90;

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

async function main() {
  const from = arg('--from', DEFAULT_FROM);
  const to = arg('--to', addDays(toJstDate(new Date()), -1));
  const models = arg('--models') ? arg('--models').split(',') : MODELS;
  const allVars = arg('--vars') === 'all';
  const dryRun = process.argv.includes('--dry-run');

  const cfg = await readJson(LOCATIONS_PATH);
  if (!cfg) throw new Error('config/locations.json が無い。先に resolve-locations.js を走らせる');

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

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
