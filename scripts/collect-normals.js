// 気象庁が公表している 1991-2020 の日別平年値を取る。
// 12リクエスト × 地点数で済む。年に一度も変わらないので、普段は走らせなくてよい。
//
// 使い方: node scripts/collect-normals.js [--force]
import { fetchNormalsMonth } from './lib/jma.js';
import { buildNormals } from './lib/normals.js';
import { readJson, writeJson } from './lib/store.js';
import { LOCATIONS_PATH, DATA_DIR } from './lib/paths.js';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

export const normalsPath = (locKey) => join(DATA_DIR, 'normals', `${locKey}.json`);

async function main() {
  const force = process.argv.includes('--force');
  const cfg = await readJson(LOCATIONS_PATH);
  if (!cfg) throw new Error('config/locations.json が無い。先に resolve-locations.js を走らせる');

  for (const loc of cfg.locations) {
    const path = normalsPath(loc.key);
    if (existsSync(path) && !force) {
      console.log(`${loc.key.padEnd(12)} 既にある。取り直すなら --force`);
      continue;
    }
    const byMonth = new Map();
    for (let month = 1; month <= 12; month++) {
      byMonth.set(month, await fetchNormalsMonth(loc.station, month));
      process.stdout.write('.');
    }
    const normals = buildNormals(byMonth);
    await writeJson(path, {
      v: 1,
      loc: loc.key,
      station: loc.station.blockNo,
      stationName: loc.station.name,
      ...normals,
    });
    const sample = normals.days.find((d) => d.key === '08-01');
    console.log(
      `\n${loc.key.padEnd(12)} ${loc.station.name} 欠損 ${normals.missingDays} 日`
      + `  8/1 の平年: 最高 ${sample?.tmax}℃ / 最低 ${sample?.tmin}℃`,
    );
  }
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
