# 過去予報に湿度と風を補い、日別の湿度・風速にも統計補正を効かせる — 設計

## データ構造

既存の予報行は触らず、**湿度と風だけを持つ補完データ**を別ディレクトリに追記する。

```
data/fcst-supp/<loc>/<YYYY-MM>.ndjson     （前年以前は compress-old で .gz）
```

1行 = 1 (地点, モデル, 発表日, 対象日)。

```js
{
  v: 1,
  id: 'setagaya|gfs_seamless|2024-01-19T00:00Z|2024-01-20|rhwind', // 既存行の id + '|rhwind'
  loc: 'setagaya',
  model: 'gfs_seamless',
  fetched: '2024-01-19T00:00Z',  // 既存の previous-runs 行と同じ組み立て（target − lead の T00:00Z）
  target: '2024-01-20',
  lead: 1,
  rh: 72.4,     // 24点の平均（小数1桁）。既存の foldHourlyToDaily と同じ
  wind: 5.12,   // 時間別の最大（小数2桁）。毎日の収集（wind_speed_10m_max）と同じ定義
  src: 'previous-runs-supp',
}
```

- `id` は決定的。取り直しても同じ id になり、既定の upsert（同じ id は捨てる）で冪等になる
- 月の振り分けは既存と同じ `monthKey(target)`

## 読み込み時の合流

`build-derived.js` が `fcstDir` を読んだ直後に、補完データで欠けている値だけを埋める。

```js
/**
 * 予報行の rh / wind が null で、同じ (model, fetched, target) の補完行があれば、その値で埋める。
 * 元の行は変えず、埋めた行を新しいオブジェクトとして返す。
 * rh / wind が既に数値の行（毎日の収集）には触らない。
 */
export function mergeSupplement(fcstRows, suppRows) → rows
```

- キーは `${model}|${fetched}|${target}`
- 埋めるのは null の項目だけ。既存の数値を上書きしない
- tmax / tmin / prcp には一切触らない → 気温と降水の成績は前後で一致する
- 補完行に対応する予報行が無い（気温が 18 点未満で予報行が作られなかった日など）ときは捨てる

## 取得

`backfill-previous-runs.js` に `--supplement` モードを足す。

- 取る時間別変数は **temperature_2m + relative_humidity_2m + wind_speed_10m**（lead 1〜7 で 21 変数）。
  気温は日別に畳むとき「24点中18点以上」の判定に要るので取るが、保存しない
- `fetchPreviousRunsDaily` の `vars` に `'supp'` を足す（`'core'` / `'all'` と並ぶ3つ目）
- 出力は `data/fcst-supp/`。既定の upsert（既存 id は捨てる）
- **取得済み区間を飛ばす**: 行の有無では判定しない（気温不足やアーカイブ欠けで行ができない日があり、
  永遠に取得済みにならない。逆に lead ごとの書き込みの途中で止まると飛ばしすぎる）。
  区間の全 lead の upsert を書き終えたあとに、**完了記録** `data/fcst-supp/<loc>/_done.json` へ
  `{ model, start, end }` を追記する。判定は日付単位: 区間の全日が、同じモデルのいずれかの完了記録の範囲に入っていれば飛ばす。
  `--from` を変えて区間の区切りが変わっても効く
  - API が正常に応答して行が0件だった区間も完了とする（取り直しても増えない）
  - 失敗した区間（再試行3回後も 429 / 5xx / 構造エラー）は記録しない。次の実行で取り直す
  - （実装中に追加）それ以外の 4xx（アーカイブが無い期間など）は、取り直しても変わらないのでデータ無しとして記録する
  - （実装で分かったこと）API が 200 で JSON 以外（"Unexpected error"）を返すことがある。構造エラーとして記録せず、再実行で取れた
  - `readNdjsonDir` は `.ndjson` しか読まないので、`_done.json` は予報の読み込みに干渉しない
- **間隔**: 1リクエストの重みは約 2.1 × 6.4 ≈ 13.5 call。600 call/分を守るため、`--supplement` のときは
  リクエストの間に 2.5 秒空ける（約 24 リクエスト/分 ≈ 325 call/分）
- **見積もり**: 実行前に `地点 × モデル × Σ区間(変数数/10 × 日数/14)`（小数）を表示し、
  取得済みで飛ばす区間を除いた値が 8,000 を超えたら中止。既存の `core` / `all` の見積もりは変えない

### 使用量

2024-01-01〜2026-09-11（992 日、12 区間）× 4 地点 × 7 モデル = 336 リクエスト、約 4,200 call。
1日の枠（10,000）には収まるが、1時間の枠（5,000）に 429 の再試行と毎日の収集が重なると近づくので、
`--to 2025-04-30` と `--from 2025-05-01` の2回に分け、**2回の間を1時間以上空ける**（各約 2,100 call、各約 7 分）。

## 処理の流れ

```
backfill-previous-runs.js --supplement [--from] [--to]
  ├ 地点・モデル・区間を列挙
  ├ 補完ファイルを読み、取得済みの区間を除く
  ├ 見積もりを表示。8,000 超なら中止（exitCode 1）
  └ 区間ごとに
      ├ fetchPreviousRunsDaily(vars:'supp')  失敗（429 など）→ 既存の再試行3回 → だめならその区間を飛ばして数える
      ├ buildSuppRecords → lead・月ごとに upsert（data/fcst-supp）
      ├ 全部書けたら _done.json に { model, start, end } を追記（失敗した区間は書かない）
      └ 2.5 秒待つ

build-derived.js
  ├ fcstRows = readNdjsonDir(fcstDir)
  ├ suppRows = readNdjsonDir(fcstSuppDir)   無ければ []
  ├ fcstRows = mergeSupplement(fcstRows, suppRows)
  └ 以降は今までどおり（MOS_VARS に rh / wind は既に入っている）
```

## 触るファイル

| ファイル | 変更内容 |
|---|---|
| `scripts/lib/paths.js` | `fcstSuppDir(loc)` と `fcstSuppPath(loc, monthKey)` を足す |
| `scripts/lib/openmeteo.js` | `fetchPreviousRunsDaily` の `vars` に `'supp'`（気温・湿度・風）を足す |
| `scripts/backfill-previous-runs.js` | `--supplement` モード、`buildSuppRecords`、取得済み区間の判定、小数の見積もり、2.5 秒の間隔 |
| `scripts/build-derived.js` | 補完データを読み `mergeSupplement` で合流 |
| `scripts/compress-old.js` | 圧縮対象に `fcstSuppDir` を足す |
| `scripts/lib/store.js`（実装中に追加） | 一時ファイルの rename が Windows で EPERM / EBUSY になったとき、少し待って5回までやり直す。1回目の取得がこれで途中停止したため |
| `test/backfill-supp.test.js`（新規） | `buildSuppRecords` の id と冪等性、完了記録による取得済み判定、見積もり、`mergeSupplement`、補完の有無で tmax / prcp のサンプルが変わらないこと |
| `CLAUDE.md`（プロジェクト） | コマンド一覧に `--supplement` を足す |
| `.claude/specs/weather-accuracy/design.md` | データモデルに `fcst-supp` を足す |
| `data/fcst-supp/**`（新規データ） | 取得結果 |
| `public/data/*.json` | build-derived の出力 |

## 検討した代替案

| 案 | 採らなかった理由 |
|---|---|
| 既存行を `replaceExisting: true` で置き換える | 追記専用の規約に反する。Open-Meteo 側の再処理で tmax/prcp も変わりうるので、気温と降水の過去の成績が遡って動く。2024年の .gz が全部書き直しになる |
| 既存と同じディレクトリに、fetched をずらした新しい行を追記する | `groupForecasts` は fetched が大きい方を採るので、気温と降水も新しい行に置き換わる。上と同じ問題が起きる |
| `--vars all` をそのまま使う | 日照も取るので call が約 7,000 に増え、既存の見積もりでは 8,000 超で中止される。日照は MOS の対象外 |
| GitHub Actions で取る | 一度きりの作業にワークフローの入力追加と Pages 配信の呼び出しが要る。429 の様子を見ながら止められるローカルの方が安全 |
| 風速を日平均で取る（実測の定義に合わせる） | 毎日の収集が日最大なので、補完行と収集行で定義が食い違う。定義の差は MOS が吸収する |

## 実装して分かったこと

- 相模原（アメダス 0366）は湿度の観測が 2024-12-23 からしか無い。湿度の MOS サンプルは最大でも約 630 日で、
  受入条件の「n ≥ 700」は相模原の湿度では満たせない（補正は動いており、全 lead で baseline より MAE が小さい）
- previous-runs の応答は 21 変数 × 90 日で 1 リクエスト 20〜40 秒かかった。2.5 秒の間隔より応答待ちのほうが長く、
  1回（168 区間）に約 1 時間かかる
