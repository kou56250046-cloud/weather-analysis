// 気象庁の府県天気予報を保存する。比較対象の予報として使う。
// Yahoo 天気はこれが元データなので、「Yahoo より当たるか」の代理指標になる。
//
// 週間予報（block 1）と短期予報（block 0）を別のレコードとして持つ。
//
//   週間予報  17時発表。tempsMax / tempsMin が日別に並び、意味が一意に決まる。
//             信頼度 A/B/C も付く。気温の比較はこちらだけを使う。
//   短期予報  05時・11時・17時発表。今日と明日の 6時間ごとの降水確率。
//             気温は timeDefines の時刻と配列の対応が曖昧なので取らない。
//
// 使い方:
//   node scripts/collect-jma-forecast.js [--dry-run]
import { fetchForecast } from './lib/jma.js';
import { upsertNdjson, readJson, makeId } from './lib/store.js';
import { LOCATIONS_PATH, jmaFcstPath } from './lib/paths.js';
import { toRunStamp, toJstDate, diffDays, monthKey } from './lib/time.js';
import { runJob } from './lib/log.js';
import { runIfMain } from './lib/main.js';

const SCHEMA = 1;
const MODEL = 'jma_official';

/** "27" → 27、"" → null */
function num(s) {
  if (s === null || s === undefined || s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** timeSeries から、指定したキーを持つ最初のものを返す */
function findSeries(block, key) {
  return block.timeSeries?.find((ts) => ts.areas?.some((a) => a[key] !== undefined)) ?? null;
}

/** areas から予報区コードで引く。無ければ null */
function findArea(series, code) {
  return series?.areas?.find((a) => a.area.code === code) ?? null;
}

/**
 * 週間予報をレコードにする。
 * 気温の予報地点が真値の観測所と同じかどうかを `tempMatch` に残す。
 * 違う地点なら気温の比較は成立しないので、画面でそう表示する。
 */
export function buildWeekly(loc, block, fetched) {
  if (!block) return [];
  const report = block.reportDatetime;
  const reportDay = toJstDate(report);

  const popSeries = findSeries(block, 'pops');
  const tempSeries = findSeries(block, 'tempsMax');
  // 週間予報の降水確率は府県単位。class10 が無ければ府県コードで引く
  const popArea = findArea(popSeries, loc.jma.class10) ?? findArea(popSeries, loc.jma.officeCode)
    ?? popSeries?.areas?.[0] ?? null;
  const tempArea = tempSeries?.areas?.[0] ?? null;

  const tempMatch = tempArea?.area.code === loc.station.amedasCode;

  const out = [];
  const times = popSeries?.timeDefines ?? tempSeries?.timeDefines ?? [];
  for (let i = 0; i < times.length; i++) {
    const target = toJstDate(times[i]);
    const lead = diffDays(reportDay, target);
    const ti = tempSeries?.timeDefines?.indexOf(times[i]) ?? -1;

    const rec = {
      v: SCHEMA,
      id: makeId(loc.key, MODEL, 'weekly', report, target),
      loc: loc.key,
      model: MODEL,
      block: 'weekly',
      report,
      fetched,
      target,
      lead,
      tmax: ti >= 0 ? num(tempArea?.tempsMax?.[ti]) : null,
      tmin: ti >= 0 ? num(tempArea?.tempsMin?.[ti]) : null,
      tmaxUpper: ti >= 0 ? num(tempArea?.tempsMaxUpper?.[ti]) : null,
      tmaxLower: ti >= 0 ? num(tempArea?.tempsMaxLower?.[ti]) : null,
      tminUpper: ti >= 0 ? num(tempArea?.tempsMinUpper?.[ti]) : null,
      tminLower: ti >= 0 ? num(tempArea?.tempsMinLower?.[ti]) : null,
      pop: num(popArea?.pops?.[i]) === null ? null : num(popArea.pops[i]) / 100,
      code: num(popArea?.weatherCodes?.[i]),
      reliability: popArea?.reliabilities?.[i] || null,
      tempArea: tempArea?.area.code ?? null,
      tempAreaName: tempArea?.area.name ?? null,
      tempMatch,
      popArea: popArea?.area.code ?? null,
    };
    // 値が何も無い日（今日の枠が空の週間予報）は持たない
    if (rec.tmax === null && rec.tmin === null && rec.pop === null) continue;
    out.push(rec);
  }
  return out;
}

/**
 * 短期予報の降水確率を日別にまとめる。
 * 6時間ごとに出るので、その日の最大値を「日の降水確率」とする。
 * 気象庁の週間予報の降水確率も日単位なので、揃えるためこの定義にする。
 */
export function buildShort(loc, block, fetched) {
  if (!block) return [];
  const report = block.reportDatetime;
  const reportDay = toJstDate(report);

  const popSeries = findSeries(block, 'pops');
  const codeSeries = findSeries(block, 'weatherCodes');
  const popArea = findArea(popSeries, loc.jma.class10);
  if (!popArea) return [];
  const codeArea = findArea(codeSeries, loc.jma.class10);

  const byDay = new Map();
  (popSeries.timeDefines ?? []).forEach((t, i) => {
    const day = toJstDate(t);
    const p = num(popArea.pops?.[i]);
    if (p === null) return;
    byDay.set(day, Math.max(byDay.get(day) ?? 0, p));
  });

  const out = [];
  for (const [target, pop] of byDay) {
    const ci = codeSeries?.timeDefines?.findIndex((t) => toJstDate(t) === target) ?? -1;
    out.push({
      v: SCHEMA,
      id: makeId(loc.key, MODEL, 'short', report, target),
      loc: loc.key,
      model: MODEL,
      block: 'short',
      report,
      fetched,
      target,
      lead: diffDays(reportDay, target),
      tmax: null,
      tmin: null,
      pop: pop / 100,
      code: ci >= 0 ? num(codeArea?.weatherCodes?.[ci]) : null,
      reliability: null,
      popArea: popArea.area.code,
    });
  }
  return out;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const cfg = await readJson(LOCATIONS_PATH);
  if (!cfg) throw new Error('config/locations.json が無い。先に resolve-locations.js を走らせる');

  await runJob('jma-forecast', async (errors) => {
    const fetched = toRunStamp(new Date(new Date().setMinutes(0, 0, 0)));
    let added = 0;

    // 同じ府県の地点で同じ JSON を何度も取らない
    const cache = new Map();

    for (const loc of cfg.locations) {
      try {
        if (!cache.has(loc.jma.officeCode)) {
          cache.set(loc.jma.officeCode, await fetchForecast(loc.jma.officeCode));
        }
        const data = cache.get(loc.jma.officeCode);
        const records = [
          ...buildShort(loc, data[0], fetched),
          ...buildWeekly(loc, data[1], fetched),
        ];

        const byMonth = new Map();
        for (const r of records) {
          const k = monthKey(r.target);
          if (!byMonth.has(k)) byMonth.set(k, []);
          byMonth.get(k).push(r);
        }
        let n = 0;
        for (const [month, rows] of byMonth) {
          if (dryRun) { n += rows.length; continue; }
          n += (await upsertNdjson(jmaFcstPath(loc.key, month), rows)).added;
        }
        added += n;

        const weekly = records.filter((r) => r.block === 'weekly');
        const match = weekly[0]?.tempMatch;
        console.log(
          `${loc.key.padEnd(12)} 短期 ${records.length - weekly.length} / 週間 ${weekly.length} → ${n} 件追加`
          + `  気温予報地点=${weekly[0]?.tempAreaName ?? '-'} ${match ? '(真値と同一)' : '(真値と別地点。気温比較は参考値)'}`,
        );
      } catch (err) {
        errors.push(`${loc.key}: ${err.message}`);
        console.error(`${loc.key}: ${err.message}`);
      }
    }

    console.log(dryRun ? `dry-run: ${added} 件` : `合計 ${added} 件追加`);
    return { added };
  });
}

runIfMain(import.meta.url, main);
