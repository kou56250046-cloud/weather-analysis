// 「このファイルが直接実行されたか」の判定。
//
// 以前は次のように書いていて、Windows でしか成立しなかった。
//
//   import.meta.url === `file:///${process.argv[1].replace(/\\/g, '/')}`
//
// Linux では process.argv[1] が `/home/runner/...` と先頭スラッシュ付きなので、
// `file:///` を足すと `file:////home/runner/...` とスラッシュが4つになる。
// import.meta.url は `file:///home/runner/...` なので一致せず、main() が呼ばれない。
//
// その結果 GitHub Actions（Ubuntu）では全スクリプトが何もせず終了コード 0 で終わり、
// ワークフローは成功と表示されるのにデータが1件も更新されない、という状態になっていた。
//
// pathToFileURL はプラットフォームごとの差を吸収する。自前で組み立てない。
import { pathToFileURL } from 'node:url';

/**
 * 引数の import.meta.url が、いま直接実行されているファイルかを返す。
 * @param {string} importMetaUrl 呼び出し側の import.meta.url
 */
export function isMain(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  return importMetaUrl === pathToFileURL(entry).href;
}

/**
 * 直接実行されたときだけ main を走らせる。失敗したら終了コードを立てる。
 * 各スクリプトで同じ catch を書かずに済ませる。
 */
export function runIfMain(importMetaUrl, main) {
  if (!isMain(importMetaUrl)) return;
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
