# weather-analysis

複数の数値予報モデルを合議し、過去の予報と実測から統計補正（MOS）を学習して、
精度を開示する天気予報ダッシュボード。あわせて過去気象データの分析を行う。

**何ではないか**
- 雨雲レーダーやナウキャストではない。分単位の実況は扱わない
- 自前の数値予報モデルではない。既存モデルの出力を合議・補正する
- 全国サービスではない。`config/locations.json` に定義した地点のみ

---

## 絶対的な制約

### 1. npm 依存ゼロ

- `package.json` の `dependencies` / `devDependencies` は**空のまま維持する**
- Node 標準（`node:fs` `node:path` `node:zlib` / グローバル `fetch`）だけで書く
- チャートライブラリを入れない。グラフは SVG と Canvas を自前で描く
- `npm install` を実行しなくても全工程が通ること

### 2. CDN を使わない

スクリプト・フォント・アイコンを外部から読み込まない。`public/` 内で完結させる。
PWA のアイコン PNG も画像ライブラリを使わず、`scripts/lib/png.js` で自前に書き出す。

### 3. 無料の範囲を出ない

- Open-Meteo は**非商用枠**（10,000 call/日）。API キーを持たない
- 気象庁 bosai JSON は公式 API ではない。仕様変更を前提に、失敗しても全体が止まらない作りにする
- GitHub は public リポジトリ + Actions + Pages。有料機能を使わない

### 4. 個人を特定できる位置情報を持たない

座標は市区町村の代表点と最寄りアメダス観測所に丸める。番地レベルの座標を保存しない。

---

## static-zero テンプレからの意図的な逸脱

土台は `~/.claude/templates/static-zero.md` だが、次の1点だけ外す。

- **`file://` での直接オープンには対応しない。** データ量が大きく Pages 配信前提のため、
  `public/data/*.json` を `fetch` で読む。ローカルでも簡易サーバー経由で見る。

npm 依存ゼロと CDN 不使用は維持する。

---

## 仕様書

正典は `.claude/specs/weather-accuracy/`。

| ファイル | 内容 |
|---|---|
| `requirements.md` | 背景・受入条件・非目標 |
| `design.md` | データソース・データモデル・アルゴリズム |
| `tasks.md` | 実装タスク。上から順に処理する |

会話の中で決めたことは、必ずここへ書き戻す。

---

## コマンド

```bash
node scripts/resolve-locations.js            # 地点定義を解決して config/locations.json を作る
node scripts/collect-forecast.js             # 予報を収集（--dry-run で書き込まない）
node scripts/collect-observation.js          # 気象庁の日別実測を収集
node scripts/collect-jma-forecast.js         # 気象庁の府県天気予報を収集（比較対象）
node scripts/collect-normals.js              # 1991-2020 の日別平年値を収集（初回だけ）
node scripts/build-derived.js                # 検証・MOS学習・合議を再計算し public/data を出力
node scripts/backfill-previous-runs.js       # 過去の予報を遡って取得
node scripts/backfill-previous-runs.js --supplement --to 2025-04-30  # 遡った予報に湿度と風を補う（取得済みの区間は飛ばす）
node scripts/backfill-archive.js             # ERA5 長期データを取得（429 が出たら日を改めて再実行）
node scripts/compress-old.js                 # 前年以前の NDJSON を gzip 化
node scripts/make-icons.js                   # PWA のアイコンを生成（図柄を変えたときだけ）
node scripts/serve.js                        # public/ をローカル配信（既定 8790 番。8787 は AI Radar）
node --test test/*.test.js                   # 単体テスト
```

---

## ドメイン固有のルール

### 用語

| 語 | 意味 |
|---|---|
| lead（リードタイム） | 予報の対象日 − 予報の発表日。単位は日。0 が当日 |
| run | モデルの初期時刻。`2026-09-12T12:00Z` 形式 |
| target | 予報の対象日。`2026-09-15` 形式 |
| MOS | Model Output Statistics。予報値から実測値への回帰による統計補正 |
| 前向き検証 | ある日を評価するとき、その日より前のデータだけで学習した係数を使う |

### 時刻

- 生データの `run` は **UTC**。ISO 8601 で `Z` を付ける
- `target` と `date` は **JST の暦日**。タイムゾーン表記を付けない
- 両者を取り違えると検証が丸ごと1日ずれる。変換は `lib/time.js` の関数だけを使う

### 学習でのリーク禁止

画面に出す精度は**必ず前向き検証の値**にする。学習データでの当てはまりを精度として出さない。
係数を学習する関数には、学習に使ってよい期間の終端を必ず引数で渡す。

### 欠測の扱い

- 実測レコードの `n`（日内の観測個数）が閾値未満の日は検証対象から除外する
- 欠測を 0 で埋めない。`null` のまま持ち、集計側で除外する
- グラフで欠測日を線で繋がない

### PWA

- `public/manifest.webmanifest` の `start_url` と `scope` は**必ず相対パス**にする。
  GitHub Pages は `/weather-analysis/` の下に配信されるので、絶対パスにすると壊れる
- `public/index.html` の参照も同じ理由ですべて相対にする
- `public/sw.js` のキャッシュ方針は2種類。部品はキャッシュ優先、データはネットワーク優先。
  予報は毎日変わるので、繋がっているときに古い値を見せない
- `sw.js` の `SHELL_ASSETS` に載せたファイルは実在しなければならない。
  画面のモジュールを増やしたらここにも足す（テストで検査している）
- キャッシュの持ち方を変えたら `CACHE_VERSION` を上げる。上げないと古い版が残る

### 時間別と実況

- **時間別予報（今日と明日）には統計補正が当たっていない。** 補正は日別の最高・最低気温に
  対して学習しているので、時間ごとの値に当てる根拠が無い。7モデルの単純平均をそのまま出し、
  補正していないことを画面に書く。日別の値とわずかに食い違う
- 時間別は履歴を残さない。`data/hourly/<loc>.json` を毎回上書きする
- **「現在の天気の詳細」はブラウザから直接取る。** 気象庁も Open-Meteo も CORS を許可している。
  押した瞬間の値が欲しいので、サービスワーカーで挟んでキャッシュしない
- アメダスの `gust` `maxTemp` `minTemp` は**その日のここまでの最大・最小**であって
  10分ごとの観測値ではない。時系列の線にしてはいけない
- アメダスの値は `[値, 品質フラグ]` の形。フラグが 0 以外なら使わない。ただし **0 という値は欠測ではない**

### 天気アイコン

- WMO の天気コードから `public/assets/weather-icon.js` が描き分ける
- **形と色だけで情報を伝えない。** 必ず名前（晴れ・雨など）を併記する
- 合議した天気コードが無い日は降水量と確率から推定し、「推定」と明示する

### スクリプトの起動

- 直接実行の判定は **必ず `lib/main.js` の `runIfMain`** を使う。自前で組み立てない
- 以前 `import.meta.url === \`file:///${process.argv[1]...}\`` と書いていて、
  Linux では `file:////home/...` とスラッシュが4つになり一致しなかった。
  その結果 GitHub Actions では全スクリプトが何もせず終了コード 0 で終わり、
  ワークフローは成功と出るのにデータが1件も更新されない状態が続いた
- **Windows でしか動かさないと気づけない類の不具合。** 疑わしいところは
  子プロセスとして起動して出力を確かめるテストを書く（`test/main-guard.test.js`）

### データ追記

- NDJSON は追記専用。既存行を書き換えない
- 行の `id` は決定的に作る。再取得しても行が増えないこと（冪等性）を必ず確認する
- スキーマを変えるときは `v` を上げ、読み込み側で旧版も読めるようにする

### 湿度・風の補完（`data/fcst-supp`）

遡って取った過去予報は気温と降水だけなので、湿度と風は `--supplement` で別ディレクトリに補い、
`build-derived.js` が読むときに合流する。既存の `data/fcst` は書き換えない。
地点やモデルを足したとき、期間を延ばしたときに再実行する。

- 1回の上限は約 4,500 call（1時間の枠 5,000 に合わせてある）。超えるなら `--from` / `--to` で分け、**1時間空ける**
- 取り終えた区間は `_done.json` に記録され、再実行では飛ばす。失敗した区間（429 / 4xx / 5xx / 応答の形の変化）は記録しないので、
  時間を空けて同じコマンドを流せば取り直す
- `_done.json` が壊れたら消して流し直せばよい。行の `id` は決定的なので行は増えない
- 取ったあとは `compress-old.js` → `build-derived.js` の順。build のログの「補完 x/y 行」で x が y を大きく下回ったら、
  予報行の `fetched` の組み立てが変わって対応が取れていない
- 気温と降水の成績が変わっていないことは、`data/fcst-supp` を一時退避した build と戻した build の `scores-*.json` で比べる
- 詳細: `.claude/specs/backfill-rh-wind/`
