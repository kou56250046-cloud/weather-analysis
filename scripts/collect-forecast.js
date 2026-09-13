// 7モデルの予報とアンサンブルを取って NDJSON に追記する。
// 1日2回まわす想定。同じ時間帯に2回走っても行は増えない。
//
// 使い方:
//   node scripts/collect-forecast.js
//   node scripts/collect-forecast.js --dry-run     書き込まず、作るレコードを表示する
import {
  MODELS, ENSEMBLE_MODELS, fetchForecastDaily, fetchEnsembleDaily, fetchForecastHourly,
} from './lib/openmeteo.js';
import { upsertNdjson, readJson, writeJson, makeId } from './lib/store.js';
import { LOCATIONS_PATH, fcstPath, hourlyPath } from './lib/paths.js';
import { toRunStamp, toJstDate, diffDays, monthKey } from './lib/time.js';
import { runJob } from './lib/log.js';
import { runIfMain } from './lib/main.js';

const SCHEMA = 1;

/**
 * 1地点ぶんの予報レコードを作る。
 * `fetched` は取得時刻を時単位に丸めたもの。モデルの初期時刻ではない。
 * Open-Meteo は初期時刻を返さないので、「いつ見た予報か」を基準に lead を数える。
 */
export function buildRecords(loc, byModel, ensembleByModel, fetchedIso) {
  const fetched = toRunStamp(new Date(new Date(fetchedIso).setMinutes(0, 0, 0)));
  const fetchedDay = toJstDate(fetched);
  const records = [];

  for (const [model, rows] of byModel) {
    const ens = ensembleByModel.get(model);
    const ensByDate = ens ? new Map(ens.map((e) => [e.date, e])) : null;

    for (const row of rows) {
      const lead = diffDays(fetchedDay, row.date);
      if (lead < 0) continue; // past_days を使っていないので通常は起きない
      const e = ensByDate?.get(row.date) ?? null;
      records.push({
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
        code: row.code,
        pop: e?.pop ?? null,
        q: e?.q ?? null,
        members: e?.members ?? null,
      });
    }
  }
  return records;
}

/** target の月ごとにファイルを分けて書く */
export async function writeRecords(locKey, records, { dryRun = false } = {}) {
  const byMonth = new Map();
  for (const r of records) {
    const key = monthKey(r.target);
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key).push(r);
  }
  let added = 0;
  for (const [month, rows] of byMonth) {
    if (dryRun) { added += rows.length; continue; }
    const res = await upsertNdjson(fcstPath(locKey, month), rows);
    added += res.added;
  }
  return added;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const cfg = await readJson(LOCATIONS_PATH);
  if (!cfg) throw new Error('config/locations.json が無い。先に resolve-locations.js を走らせる');

  await runJob('forecast', async (errors) => {
    const fetchedIso = new Date().toISOString();
    let added = 0;

    for (const loc of cfg.locations) {
      try {
        const byModel = await fetchForecastDaily(loc, { models: MODELS });

        const ensembleByModel = new Map();
        for (const model of ENSEMBLE_MODELS) {
          try {
            ensembleByModel.set(model, await fetchEnsembleDaily(loc, model));
          } catch (err) {
            // アンサンブルが落ちても決定論的な予報は使える。分位数だけ諦める
            errors.push(`${loc.key}/ensemble/${model}: ${err.message}`);
          }
        }

        const records = buildRecords(loc, byModel, ensembleByModel, fetchedIso);
        const n = await writeRecords(loc.key, records, { dryRun });
        added += n;

        // 今日と明日の時間別。履歴は残さず、最新の1枚を上書きする。
        // 日別と違って補正を当てられないので、その旨を持たせておく
        try {
          const hourly = await fetchForecastHourly(loc);
          if (!dryRun) {
            await writeJson(hourlyPath(loc.key), {
              v: 1,
              loc: loc.key,
              fetched: toRunStamp(new Date(new Date(fetchedIso).setMinutes(0, 0, 0))),
              models: MODELS,
              corrected: false,
              rows: hourly,
            });
          }
        } catch (err) {
          // 時間別が取れなくても日別の予報は使える
          errors.push(`${loc.key}/hourly: ${err.message}`);
        }

        console.log(`${loc.key.padEnd(12)} ${records.length} 件生成 / ${n} 件追加`);
        if (dryRun && records.length) {
          console.log(`  例: ${JSON.stringify(records[0])}`);
        }
      } catch (err) {
        errors.push(`${loc.key}: ${err.message}`);
        console.error(`${loc.key}: ${err.message}`);
      }
    }

    console.log(dryRun ? `dry-run: 合計 ${added} 件（書き込んでいない）` : `合計 ${added} 件追加`);
    return { added };
  });
}

runIfMain(import.meta.url, main);
