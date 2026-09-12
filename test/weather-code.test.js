import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { consensusCode } from '../scripts/build-derived.js';
import { PUBLIC_DIR } from '../scripts/lib/paths.js';

// weather-icon.js は描画に document を使うが、判定の関数は使わない。
// 読み込むだけなら Node でも通る
const { describeCode, inferKind, KIND_LABEL } = await import('../public/assets/weather-icon.js');

test('describeCode: 主要な天気コードを読み分ける', () => {
  assert.deepEqual(describeCode(0), { kind: 'clear', label: '快晴' });
  assert.deepEqual(describeCode(3), { kind: 'cloudy', label: '曇り' });
  assert.equal(describeCode(63).kind, 'rain');
  assert.equal(describeCode(75).kind, 'heavy-snow');
  assert.equal(describeCode(95).kind, 'thunder');
  assert.equal(describeCode(45).kind, 'fog');
});

test('describeCode: 知らないコードは曇り、null は不明', () => {
  assert.equal(describeCode(9999).kind, 'cloudy');
  assert.equal(describeCode(null).kind, 'unknown');
  assert.equal(describeCode(undefined).kind, 'unknown');
});

test('describeCode: 文字列で来ても数値として扱う', () => {
  assert.equal(describeCode('61').kind, 'rain');
});

test('KIND_LABEL: 描き分ける種別すべてに名前がある', () => {
  const kinds = new Set();
  // CODE_MAP に載っている全コードの種別を集める
  for (let code = 0; code <= 99; code++) {
    const d = describeCode(code);
    kinds.add(d.kind);
  }
  for (const k of kinds) {
    assert.ok(KIND_LABEL[k], `${k} に名前が無い`);
  }
});

test('inferKind: 降水量と確率から見た目を決める', () => {
  assert.equal(inferKind({ prcp: 0, pop: 0.05 }), 'clear');
  assert.equal(inferKind({ prcp: 0, pop: 0.3 }), 'partly-cloudy');
  assert.equal(inferKind({ prcp: 0, pop: 0.7 }), 'showers');
  assert.equal(inferKind({ prcp: 0.5, pop: 0.4 }), 'drizzle');
  assert.equal(inferKind({ prcp: 4, pop: 0.8 }), 'rain');
  assert.equal(inferKind({ prcp: 25, pop: 0.9 }), 'heavy-rain');
});

test('inferKind: 気温が低ければ雪にする', () => {
  assert.equal(inferKind({ prcp: 4, pop: 0.8, tmax: 1 }), 'snow');
  assert.equal(inferKind({ prcp: 25, pop: 0.9, tmax: 0 }), 'heavy-snow');
  // 気温が高ければ雨のまま
  assert.equal(inferKind({ prcp: 4, pop: 0.8, tmax: 12 }), 'rain');
});

test('inferKind: 何も分からなければ晴れに倒す', () => {
  assert.equal(inferKind({}), 'clear');
});

test('consensusCode: 荒天の度合いで並べた中央を返す', () => {
  // 1つだけ雷雨を出すモデルがあっても引きずられない
  assert.equal(consensusCode([0, 1, 2, 3, 95]), 2);
  // 全員が雨なら雨
  assert.equal(consensusCode([61, 63, 61]), 61);
  // 晴れ寄りと雨寄りが割れたら間を取る
  assert.equal(consensusCode([0, 0, 61, 63]), 0);
});

test('consensusCode: 空なら null', () => {
  assert.equal(consensusCode([]), null);
  assert.equal(consensusCode(null), null);
});

test('consensusCode: 知らないコードが混ざっても落ちない', () => {
  const v = consensusCode([0, 1234, 63]);
  assert.ok(Number.isFinite(v));
});

test('manifest: 参照しているアイコンが実在する', async () => {
  const manifest = JSON.parse(
    await readFile(join(PUBLIC_DIR, 'manifest.webmanifest'), 'utf8'),
  );
  assert.ok(manifest.icons.length >= 2);
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'), 'maskable が無い');
  assert.equal(manifest.start_url, './', 'サブディレクトリ配信のため相対でなければならない');
  assert.equal(manifest.scope, './');

  for (const icon of manifest.icons) {
    assert.ok(existsSync(join(PUBLIC_DIR, icon.src)), `${icon.src} が無い`);
  }
  for (const s of manifest.shortcuts ?? []) {
    for (const icon of s.icons ?? []) {
      assert.ok(existsSync(join(PUBLIC_DIR, icon.src)), `${icon.src} が無い`);
    }
  }
});

test('サービスワーカー: 最初に入れる部品がすべて実在する', async () => {
  const sw = await readFile(join(PUBLIC_DIR, 'sw.js'), 'utf8');
  const block = sw.slice(sw.indexOf('const SHELL_ASSETS'), sw.indexOf('];', sw.indexOf('const SHELL_ASSETS')));
  const paths = [...block.matchAll(/'\.\/([^']*)'/g)].map((m) => m[1]);

  assert.ok(paths.length > 5, '部品の一覧が読み取れていない');
  for (const p of paths) {
    if (p === '') continue; // './' はディレクトリそのもの
    assert.ok(existsSync(join(PUBLIC_DIR, p)), `sw.js が存在しない ${p} を読もうとしている`);
  }
});

test('index.html: PWA に要る参照が揃っている', async () => {
  const html = await readFile(join(PUBLIC_DIR, 'index.html'), 'utf8');
  assert.match(html, /rel="manifest"/, 'manifest への link が無い');
  assert.match(html, /rel="apple-touch-icon"/, 'iOS 用のアイコンが無い');
  assert.match(html, /name="theme-color"/, 'theme-color が無い');
  assert.match(html, /serviceWorker/, 'サービスワーカーの登録が無い');
  // 相対パスでなければ GitHub Pages のサブディレクトリで壊れる
  assert.doesNotMatch(html, /(href|src)="\/[^/]/, '絶対パスの参照がある');
});
