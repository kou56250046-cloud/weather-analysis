// 気象庁の公式日別値を取って NDJSON に追記する。これが検証の真値になる。
//
// 1リクエストで1か月分が返る。既定では当月と前月を取り直す。
// 気象庁の値は後から訂正されることがあるので、直近の月は replaceExisting で上書きする。
// 過去の月は触らない。
//
// 使い方:
//   node scripts/collect-observation.js                    当月と前月
//   node scripts/collect-observation.js --from 2024-01     指定月から当月まで
//   node scripts/collect-observation.js --dry-run
import { fetchDailyMonth } from './lib/jma.js';
import { upsertNdjson, readJson, makeId } from './lib/store.js';
import { LOCATIONS_PATH, obsPath } from './lib/paths.js';
import { toJstDate, monthKey } from './lib/time.js';
import { runJob } from './lib/log.js';

const SCHEMA = 1;

/** 訂正を取り込むために上書きし直す月数（当月を含む） */
const REFRESH_MONTHS = 2;

/** 保存する変数 */
const FIELDS = ['tavg', 'tmax', 'tmin', 'prcp', 'prcpMax1h', 'rh', 'rhMin', 'wind', 'windMax', 'gust', 'sun', 'snow'];

/**
 * 1か月分の日別表をレコードに変換する。
 * 値が全て欠測の日（未来日、観測開始前）は捨てる。
 */
export function buildRecords(loc, year, month, rows) {
  const out = [];
  for (const { day, values, flags } of rows) {
    const hasAny = FIELDS.some((k) => values[k] !== null && values[k] !== undefined);
    if (!hasAny) continue;

    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const rec = {
      v: SCHEMA,
      id: makeId(loc.key, date),
      loc: loc.key,
      date,
      src: 'etrn',
      station: loc.station.blockNo,
    };
    for (const k of FIELDS) rec[k] = values[k] ?? null;

    // 品質フラグは 0 以外だけ持つ。全部持つとファイルが倍になる
    const q = {};
    for (const k of FIELDS) {
      if (rec[k] !== null && flags[k] !== 0) q[k] = flags[k];
    }
    if (Object.keys(q).length > 0) rec.q = q;

    out.push(rec);
  }
  return out;
}

/** 当月から遡って対象の年月を列挙する */
export function monthsToFetch({ from = null, today = toJstDate(new Date()) } = {}) {
  const [curY, curM] = [Number(today.slice(0, 4)), Number(today.slice(5, 7))];
  const months = [];
  if (from) {
    let [y, m] = [Number(from.slice(0, 4)), Number(from.slice(5, 7))];
    while (y < curY || (y === curY && m <= curM)) {
      months.push({ year: y, month: m });
      m += 1;
      if (m > 12) { m = 1; y += 1; }
    }
  } else {
    for (let back = REFRESH_MONTHS - 1; back >= 0; back--) {
      let y = curY;
      let m = curM - back;
      while (m <= 0) { m += 12; y -= 1; }
      months.push({ year: y, month: m });
    }
  }
  return months;
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  const fromIdx = argv.indexOf('--from');
  const from = fromIdx >= 0 ? argv[fromIdx + 1] : null;

  const cfg = await readJson(LOCATIONS_PATH);
  if (!cfg) throw new Error('config/locations.json が無い。先に resolve-locations.js を走らせる');

  const months = monthsToFetch({ from });
  const today = toJstDate(new Date());
  const refreshFrom = monthsToFetch({}).at(0);

  await runJob('observation', async (errors) => {
    let added = 0;
    let updated = 0;

    for (const loc of cfg.locations) {
      for (const { year, month } of months) {
        try {
          const rows = await fetchDailyMonth(loc.station, year, month);
          const records = buildRecords(loc, year, month, rows);
          if (records.length === 0) continue;

          // 訂正が入りうる直近の月だけ上書きする
          const isRecent = year > refreshFrom.year
            || (year === refreshFrom.year && month >= refreshFrom.month);

          if (!dryRun) {
            const res = await upsertNdjson(
              obsPath(loc.key, year),
              records,
              { replaceExisting: isRecent },
            );
            added += res.added;
            updated += res.updated;
          } else {
            added += records.length;
          }
          console.log(`${loc.key.padEnd(12)} ${year}-${String(month).padStart(2, '0')} ${records.length} 日分`);
        } catch (err) {
          errors.push(`${loc.key}/${year}-${month}: ${err.message}`);
          console.error(`${loc.key} ${year}-${month}: ${err.message}`);
        }
      }
    }

    console.log(dryRun
      ? `dry-run: ${added} 件（書き込んでいない）`
      : `${added} 件追加 / ${updated} 件更新（当日 ${today}、${monthKey(today)} まで）`);
    return { added };
  });
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
