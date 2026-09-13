// 収集が何をしたかを1枚の JSON に残す。
//
// 定時実行が「成功」と出るのに1つもコミットされない状態が続いたため、
// 実行のたびに作業ツリーの状態を記録して、画面とリポジトリの両方から追えるようにする。
//
// このファイルは毎回必ず変わるので、収集が空振りしても必ずコミットが立つ。
// 結果として Pages の配信も必ず走り、日付が止まったままになることがなくなる。
//
// 使い方: node scripts/write-collect-status.js
import { execFileSync } from 'node:child_process';
import { statSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { writeJson, readNdjson } from './lib/store.js';
import { DATA_DIR, ROOT, outPath } from './lib/paths.js';
import { nowJstIso } from './lib/time.js';

/** git の出力を取る。失敗しても全体は止めない */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch (err) {
    return `（git が失敗した: ${err.message.split('\n')[0]}）`;
  }
}

/** ファイルの更新時刻。書かれたかどうかを見る手掛かりになる */
function mtimeOf(relative) {
  const path = join(ROOT, relative);
  if (!existsSync(path)) return null;
  return new Date(statSync(path).mtime).toISOString();
}

async function main() {
  const porcelain = git(['status', '--porcelain', 'data/', 'public/data/']);
  const changed = porcelain && !porcelain.startsWith('（')
    ? porcelain.split('\n').filter(Boolean)
    : [];

  const log = await readNdjson(join(DATA_DIR, 'collect-log.ndjson'));
  const lastOk = {};
  for (const e of log) if (e.ok) lastOk[e.job] = e.ts;

  const status = {
    v: 1,
    ranAt: nowJstIso(),
    // ワークフローから渡る。手元で走らせたときは空
    event: process.env.GITHUB_EVENT_NAME ?? 'local',
    schedule: process.env.GITHUB_EVENT_SCHEDULE ?? null,
    runId: process.env.GITHUB_RUN_ID ?? null,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
    // 「変更なし」と判定された理由を追うための手掛かり
    changedCount: changed.length,
    changed: changed.slice(0, 60),
    headSha: git(['rev-parse', '--short', 'HEAD']),
    // 主要な出力がいつ書かれたか。収集が空振りしていれば古いままになる
    mtimes: {
      'public/data/meta.json': mtimeOf('public/data/meta.json'),
      'public/data/forecast-setagaya.json': mtimeOf('public/data/forecast-setagaya.json'),
      'public/data/hourly-setagaya.json': mtimeOf('public/data/hourly-setagaya.json'),
      'data/collect-log.ndjson': mtimeOf('data/collect-log.ndjson'),
    },
    lastCollect: lastOk,
    recentLog: log.slice(-8),
  };

  await writeJson(outPath('collect-status.json'), status, { pretty: true });

  console.log(`変更 ${changed.length} 件 / HEAD ${status.headSha} / event ${status.event}`);
  for (const line of changed.slice(0, 10)) console.log('  ', line);
}

if (import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
