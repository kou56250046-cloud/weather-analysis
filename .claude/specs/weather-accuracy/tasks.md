# tasks — 実装タスク

上から順に処理する。各タスクの完了時に「確認」の内容を実際に実行して通す。

## T1. 土台

- [x] `package.json`（dependencies 空）、`.gitignore`、`README.md`
- [x] `.claude/CLAUDE.md`、`.claude/specs/weather-accuracy/*`
- [x] `scripts/lib/time.js` JST 暦日と UTC run の変換、lead の計算
- [x] `scripts/serve.js` 依存ゼロの静的配信
- 確認: `node --test test/time.test.js` が通る

## T2. 地点解決

- [x] `scripts/resolve-locations.js` 市区町村代表座標 → 最近傍アメダス観測所 + 府県予報区コード
- [x] `config/locations.json` を生成
- 確認: 4地点の観測所名と距離を出力し、常識的な近さか目視確認する

## T3. 収集基盤

- [x] `scripts/lib/http.js` fetch ラッパ。ホスト別最低間隔、タイムアウト、指数バックオフ、UA
- [x] `scripts/lib/store.js` NDJSON の読み書き。決定論的 id による冪等 upsert、原子的書き込み、gz 対応
- [x] `scripts/lib/log.js` 収集ログの追記
- 確認: `node --test test/store.test.js` が通る（同じ行を2回入れても増えない）

## T4. API クライアント

- [x] `scripts/lib/openmeteo.js` forecast / ensemble / previous-runs / archive
- [x] `scripts/lib/jma.js` amedastable / amedas point / area / 府県予報
- [x] 時間別 → 日次の畳み込み（`lib/openmeteo.js` の `foldHourlyToDaily`。独立モジュールにはしなかった）
- 確認: 真値は気象庁の公式日別値をそのまま使う設計に変更したため、自前集計との一致確認は不要になった。
  代わりに `parseCell` が品質マーク（`)` `]` `--` `///`）を正しく読み分けることを確認した

## T5. 収集スクリプト

- [x] `scripts/collect-forecast.js`（`--dry-run` 対応）
- [x] `scripts/collect-observation.js`（`--from` で過去にも遡れる）
- [x] `scripts/collect-jma-forecast.js`
- [x] `scripts/collect-normals.js`（公式の日別平年値。当初計画に無かったが必要になった）
- 確認: 2回連続実行して NDJSON の行数が増えない

## T6. バックフィル

- [x] `scripts/backfill-previous-runs.js` lead 1〜7 の過去予報
- [x] `scripts/backfill-archive.js` ERA5 1940〜
- 確認: 取得件数と期間を出力。中断して再実行しても重複しない

## T7. 回帰

- [x] `scripts/lib/matrix.js` 転置・積・Cholesky 分解と前進後退代入
- [x] `scripts/lib/regress.js` Ridge 重回帰 / ロジスティック回帰(IRLS) / 分位点回帰
- 確認: `node --test test/regress.test.js`。既知係数の復元、一様分布での p10/p90 一致

## T8. 検証と較正

- [x] `scripts/lib/verify.js` MAE / RMSE / バイアス / 分割表 / Brier / reliability
- [x] `scripts/lib/calibrate.js` 前向き検証、λ 選択、縮小推定、リークチェック出力
- [x] `scripts/lib/blend.js` 係数を当てて合議予報と予測区間を生成
- [x] `scripts/lib/normals.js` 平年値の組み立て・ERA5 オフセット・年次集計
- 確認: `node --test test/verify.test.js`、`node --test test/calibrate.test.js`

## T9. 派生ビルド

- [x] `scripts/build-derived.js` 総再計算して `public/data/*.json` を出力
- 確認: 前向き検証で MOS の MAE が 単純平均・最良単独モデル より小さい。
  80%区間の被覆率が 70〜88%。`leakcheck.json` に学習範囲が出る

## T10. 画面

- [x] `public/assets/style.css` トークンと配色。ライト/ダーク対応
- [x] `public/assets/tip.js` ツールチップ
- [x] `public/assets/chart-svg.js` 折れ線・帯・棒・ヒートマップ・散布
- [x] `public/assets/chart-canvas.js` 大量点用
- [x] `public/index.html` + `public/assets/app.js` 4タブ
- [x] 予報タブ / 成績タブ / 平年比タブ / 分析タブ
- 確認: `node scripts/serve.js` で配信し claude-in-chrome で4タブ × 代表2地点を確認。
  400px 幅で横スクロールが出ない。欠測日が線で繋がれない

## T11. 自動化

- [x] `.github/workflows/collect.yml`
- [x] `.github/workflows/deploy-pages.yml`
- [x] `.github/workflows/backfill.yml`
- [x] `scripts/compress-old.js`（前年以前を gzip 化。当初計画に無かった）
- 確認: `workflow_dispatch` で手動実行し、コミットと Pages 更新を確認してから cron を有効にする

## T13. PWA と天気アイコン（当初計画に無し・後から追加）

- [x] `scripts/lib/png.js` 依存ゼロの PNG 書き出しと図形ラスタライザ
- [x] `scripts/make-icons.js` 雲と太陽のアイコンを 5 サイズ生成
- [x] `public/manifest.webmanifest` 相対パス・maskable・ショートカット
- [x] `public/sw.js` 部品はキャッシュ優先、データはネットワーク優先
- [x] `public/assets/weather-icon.js` WMO コードから天気アイコンを描き分ける
- [x] `build-derived.js` に天気コードの合議（荒天の度合いで並べた中央値）を追加
- [x] 予報タブに日ごとのカード帯・天気の列・今日の大きなアイコン
- [x] ホーム画面追加の案内とオフライン表示
- 確認: `node --test test/weather-code.test.js`。
  manifest とサービスワーカーが実在しないファイルを参照していないことも検査している

## T14. 時間別予報と実況（当初計画に無し・後から追加）

- [x] `openmeteo.js` に `fetchForecastHourly`。7モデルの時間別を平均し、天気コードは中央の荒天度を採る
- [x] `collect-forecast.js` が `data/hourly/<loc>.json` を上書き保存（履歴は残さない）
- [x] `build-derived.js` が `public/data/hourly-<loc>.json` を出力
- [x] 予報タブに「1時間ごと（今日と明日）」。気温・体感・降水確率・降水量・3時間ごとの天気マーク
- [x] `public/assets/live.js`。押したときだけアメダスの10分値を直近6時間ぶん取る
- [x] 予報タブに「現在の天気の詳細を取得する」ボタン
- [x] `meta.json` にアメダス観測所番号を追加（画面から直接取るのに要る）
- 確認: `node --test test/live.test.js`。
  品質フラグの扱い、3時間ファイルの割り出し、日別と時間別で天気の合議が一致することを検査

## T15. 収集が公開に反映されない問題

- [x] `collect.yml` から `deploy-pages.yml` を `workflow_call` で呼ぶ。
  GITHUB_TOKEN の push は他のワークフローを起動しないため、Pages に永久に反映されなかった
- [x] コミット手順を診断可能にし、変更の有無をステップ要約に出す
- [ ] 次の実行で、コミットが作られない原因が要約に出るか確認する

## T12. 公開

- [ ] public リポジトリ作成、初回 push
- [ ] Pages の公開設定（`main` / `public`）
- [ ] バックフィルを1回回して初期データを投入
- 確認: 公開 URL で全タブが表示される


---

## 計画から変えたところ

| 変えたこと | 理由 |
|---|---|
| 真値をアメダス10分値 → 気象庁の公式日別値 | `bosai` は直近10日しか遡れず、過去の予報を検証できない。`etrn` なら数十年遡れて値も公表値そのもの |
| 平年値を30年分の自前集計 → 公式の日別平年値 | 12リクエストで済み、観測所の移転補正も入った公表値になる |
| 予報レコードの `run` → `fetched` | Open-Meteo はモデル初期時刻を返さない。「いつ見た予報か」を基準にする方が正直 |
| `lib/aggregate.js` を作らず `openmeteo.js` に統合 | 時間別→日次の畳み込みは Previous Runs でしか使わない |
| Previous Runs のバックフィルを気温と降水だけに | 変数を増やすと API の課金単位が跳ね上がる |
| ERA5 を3変数に絞り、取得済み区間を飛ばす作りに | 86年分×4地点で時間あたりの上限に当たる。再実行で続きから埋める |
| 前向き検証を累積1パスの実装に | 素朴な実装だと数分かかる。素朴版との一致をテストで固定した |
| 予測区間を必ず予報値の周りに付け直す | アンサンブルの分位数だけを使うと、区間が予報値を挟まないことがある |
| `compress-old.js` を追加 | 予報データが年30MB前後になる |
