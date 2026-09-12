// 前年以前の NDJSON を gzip 化する。読み込み側は .gz も透過的に扱う。
// 予報データは年 30MB 前後になるので、放っておくとリポジトリが膨らむ。
import { compressOld, readJson } from './lib/store.js';
import { LOCATIONS_PATH, fcstDir, jmaFcstDir, obsDir } from './lib/paths.js';
import { toJstDate } from './lib/time.js';

async function main() {
  const cfg = await readJson(LOCATIONS_PATH);
  if (!cfg) throw new Error('config/locations.json が無い');

  // 今年と去年は触らない。訂正が入ることがあるのと、読み書きの頻度が高い
  const keepFrom = Number(toJstDate(new Date()).slice(0, 4)) - 1;
  let total = 0;

  for (const loc of cfg.locations) {
    for (const dir of [fcstDir(loc.key), jmaFcstDir(loc.key), obsDir(loc.key)]) {
      const done = await compressOld(dir, keepFrom);
      if (done.length) {
        console.log(`${dir}: ${done.length} ファイルを圧縮`);
        total += done.length;
      }
    }
  }
  console.log(`${keepFrom} 年より前を圧縮。合計 ${total} ファイル`);
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
