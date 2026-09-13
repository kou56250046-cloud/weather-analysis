import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { isMain } from '../scripts/lib/main.js';
import { ROOT } from '../scripts/lib/paths.js';

// 以前の判定式。Windows では成立するが Linux では成立しない
const brokenGuard = (argv1) => `file:///${argv1.replace(/\\/g, '/')}`;

test('以前の判定式は Linux のパスで壊れる', () => {
  const linux = '/home/runner/work/weather-analysis/weather-analysis/scripts/collect-forecast.js';
  // import.meta.url は file:///home/... （スラッシュ3つ）
  const real = `file://${linux}`;
  // 壊れた式は file:////home/... （スラッシュ4つ）を作る
  assert.equal(brokenGuard(linux), `file:////home/runner/work/weather-analysis/weather-analysis/scripts/collect-forecast.js`);
  assert.notEqual(brokenGuard(linux), real);
});

test('isMain: 実行中のファイルと一致したときだけ true', () => {
  // argv[1] を URL に直したものだけが true。
  // テストランナーが何を argv[1] に置くかに依存しないよう、そこから引く
  assert.equal(isMain(pathToFileURL(process.argv[1]).href), true);
  assert.equal(isMain('file:///どこか/別の/ファイル.js'), false);
  assert.equal(isMain(''), false);
});

test('scripts 配下に壊れた判定式が残っていない', async () => {
  const dir = join(ROOT, 'scripts');
  const names = (await readdir(dir)).filter((n) => n.endsWith('.js'));
  assert.ok(names.length >= 10, 'スクリプトが見つからない');

  for (const name of names) {
    const src = await readFile(join(dir, name), 'utf8');
    assert.ok(
      !src.includes('file:///${process.argv[1]'),
      `${name} に Linux で動かない判定式が残っている`,
    );
  }
});

test('すべての実行スクリプトが runIfMain を使っている', async () => {
  const dir = join(ROOT, 'scripts');
  const names = (await readdir(dir)).filter((n) => n.endsWith('.js'));

  for (const name of names) {
    const src = await readFile(join(dir, name), 'utf8');
    // main() を持つなら、起動の仕組みも持っていなければならない
    if (!/\nasync function main\(/.test(src)) continue;
    assert.ok(
      src.includes('runIfMain(import.meta.url, main)'),
      `${name} が main() を持つのに起動していない`,
    );
  }
});

/**
 * 実際に子プロセスとして走らせて、main() が呼ばれることを確かめる。
 * 判定式が壊れていると何も出力せず終了コード 0 で終わるので、
 * 「成功したのに何も起きない」を検知するにはこれが要る。
 */
test('子プロセスとして起動すると main() が実際に動く', () => {
  // ネットワークを使わないものを選ぶ
  const out = execFileSync(
    process.execPath,
    [join(ROOT, 'scripts', 'write-collect-status.js')],
    { cwd: ROOT, encoding: 'utf8', timeout: 60_000 },
  );
  assert.match(out, /変更 \d+ 件/, `main() が動いていない。出力: ${JSON.stringify(out)}`);
});
