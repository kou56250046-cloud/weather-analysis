# traceability — 解説タブの記述と実装の対応

解説タブに書いた式・定数・主張が、どの実装を指しているかの一覧。
受入条件 C11 の成果物。**解説を直したらこの表も直す。**
食い違いを見つけたときに正しいのはコードのほうで、解説と本表が古い。

行番号は 2026-09-14 時点。関数名のほうが安定するので、ずれたら関数名で探す。

## 第1章 数値予報の仕組み

一般的な気象学の内容で、このリポジトリの実装を指すものではない。
唯一ここに紐づくのは次の2つ。

| 記述 | 実装 |
|---|---|
| 合議に7モデルを使う（K = 7） | `scripts/lib/openmeteo.js:18` `MODELS` |
| 熱海を「急峻地形で系統誤差が大きい地点」として選んでいる | `.claude/specs/weather-accuracy/requirements.md` 対象地点の表 |

## 第2章 降水確率

| 記述 | 実装 |
|---|---|
| 降水ありのしきい値 1.0mm | `scripts/lib/verify.js:6` `RAIN_THRESHOLD_MM = 1.0` |
| アンサンブル比率 `P_raw = (1/M)Σ1[R_m ≥ 1.0]` | `scripts/lib/openmeteo.js:240`（`fetchEnsembleDaily` の `pop`） |
| アンサンブルは ECMWF と GFS | `scripts/lib/openmeteo.js:29` `ENSEMBLE_MODELS` |
| ロジスティックで較正する | `scripts/lib/calibrate.js` `fitRainProbability` / `scripts/lib/blend.js:62` `blendRainProbability` |
| 学習ラベルの閾値は**変換前の実測**に当てる（1mm ちょうど） | `scripts/lib/calibrate.js` `fitRainProbability` の `samples.yRaw` / `buildSamples` の `yRaw` |
| 10%刻みに丸めていない | `scripts/lib/blend.js:70`（`round(…, 3)` で確率をそのまま持つ） |
| 較正後の確率を前向き検証で採点している | `scripts/build-derived.js:105` `buildMosForecastRows`（`rain` の予測を `pop` として通す） |
| 信頼度図が較正後のものになる | `public/assets/tab-scores.js:335`（`source === 'blend:mos'` を先に探す） |

「0% は 0〜5% 未満の丸め」「量・時間・面積の割合ではない」は気象庁の定義であって
実装ではない。

## 第3章 採点の指標

| 記述 | 実装 |
|---|---|
| MAE / RMSE / bias / 最大の外し | `scripts/lib/verify.js:23` `continuousScores` |
| 分割表 H / F / M / C | `scripts/lib/verify.js:58` `categoricalScores` |
| 適中率・空振り率・見逃し率・捕捉率 | 同上 `accuracy` / `falseAlarmRatio` / `missRatio` / `hitRate` |
| `H_rand = (H+F)(H+M)/N`、ETS | 同上 `hitsRandom` / `ets` |
| Brier score と BS_clim、BSS | `scripts/lib/verify.js:98` `probabilityScores` |
| 信頼度図は10分割 | `scripts/lib/verify.js:129` `reliabilityBins`（既定 `bins = 10`） |
| 被覆率 | `scripts/lib/verify.js:160` `coverage` |
| 被覆率は「付け直す前」の上下端で測っている | `scripts/build-derived.js` 予測区間の被覆率を出すブロック（`iv[0.1].predictions` を直接使う） |
| 自作も単独モデルも気象庁も同じ関数で採点 | `scripts/build-derived.js` `scoreOne` を全ソースで共用 |

## 第4章 このシステムの算出方法

### データ源

| 記述 | 実装 |
|---|---|
| 7モデル | `scripts/lib/openmeteo.js:18` |
| 検証の真値は気象庁の日別値（`src: 'etrn'`） | `scripts/collect-observation.js:42` |
| 実況はアメダス10分値をブラウザから直接 | `public/assets/live.js` |
| 比較対象は気象庁の府県天気予報 | `scripts/collect-jma-forecast.js` |
| ERA5 は 1940年以降 | `scripts/backfill-archive.js` / `scripts/lib/openmeteo.js:348` |
| 平年値は気象庁公表の 1991–2020 | `scripts/lib/normals.js:13-14` `NORMAL_FROM` / `NORMAL_TO` |

### 説明変数と回帰

| 記述 | 実装 |
|---|---|
| `x = [1, f₁…f₇, sin, cos]` | `scripts/lib/calibrate.js:83`（`buildSamples`） |
| 降水は説明変数にも `log1p` がかかる | `scripts/build-derived.js` の `buildSamples(..., { transform: log1p })` / `scripts/lib/blend.js:63` |
| 季節項の周期 365.2425 | `scripts/lib/time.js:70` `seasonTerms` |
| 欠けたモデルはその行の他モデルの平均で埋める | `scripts/lib/calibrate.js:78-81` |
| Ridge の最小化問題と解、切片に罰則をかけない | `scripts/lib/regress.js:23` `ridge` / `diagW` の 0 番目 |
| 標準化してから解いて戻す | `scripts/lib/regress.js:28,38` `standardise` / `unstandardise` |
| λ 候補 {0.01, 0.1, 1, 10, 100} | `scripts/lib/calibrate.js:22` `LAMBDAS` |
| λ は前向き検証の MAE で選ぶ | `scripts/lib/calibrate.js` `fitContinuousMos` |
| λ の選択だけは評価期間ぜんぶの成績を見ている（解説4章に注記あり） | 同上。`maxOf` を全期間に対して取り、最小の λ を採用している |
| 降水量は `log(1+y)` で回帰して `e^ŷ − 1` で戻す | `scripts/build-derived.js`（`prcpFit.predictions` の `expm1`）/ `scripts/lib/blend.js:130-131` |
| ロジスティックは IRLS、上限25回 | `scripts/lib/regress.js:62` `logistic` / `scripts/lib/calibrate.js:304`（`maxIter: 25`） |
| 完全分離を避けるため常に L2 | `scripts/lib/regress.js:62`（`lambda = 0.5` 既定） |

### 予測区間

| 記述 | 実装 |
|---|---|
| ピンボール損失 `ρ_τ(r) = r(τ − 1[r<0])` | `scripts/lib/regress.js:146` |
| τ = 0.1 と 0.9 | `scripts/lib/calibrate.js:330` `fitInterval` |
| 3段のフォールバック（分位点 → アンサンブル幅 → MAE） | `scripts/lib/blend.js:94` `blendInterval` |
| ±1.28 × MAE が80%区間に相当 | `scripts/lib/blend.js:88,115` |
| 区間は必ず予報値を含むように付け直す | `scripts/lib/blend.js:122` `clampAround` |

### 前向き検証

| 記述 | 実装 |
|---|---|
| `ŷ_i = β̂(D_{<i})ᵀ x_i` | `scripts/lib/calibrate.js:101` `walkForward` / `:167` `walkForwardRidgeMulti` |
| 70本に満たない区分は学習しない | `scripts/lib/calibrate.js:258,298,331`（`MIN_TRAIN + 10`） |
| 予測を出し始めるのは60本目から | `scripts/lib/calibrate.js:13` `MIN_TRAIN = 60` |
| Ridge の再学習は7日ごと | `scripts/lib/calibrate.js:19` `RETRAIN_EVERY = 7` |
| ロジスティック・分位点は28日ごと | `scripts/lib/calibrate.js:294` `RETRAIN_EVERY_ITERATIVE = 28` |
| 学習の終端と評価の開始を出している | `scripts/build-derived.js:226,255` `leak.push(...)` → `public/data/leakcheck.json` |

### その他

| 記述 | 実装 |
|---|---|
| 天気コードは荒天の度合いで並べて中央 | `scripts/build-derived.js:173` `CODE_SEVERITY` / `:184` `consensusCode`、`scripts/lib/openmeteo.js:182` `medianCode` |
| 合議コードが無い日は降水量と確率から推定 | `public/assets/weather-icon.js:55` `inferKind` |
| 平年差 `a = o − N(月日)` | `scripts/build-derived.js` の `vsNormal` / `scripts/lib/normals.js:56` `normalFor` |
| うるう日は 2/28 に寄せる | `scripts/lib/time.js:75` `normalKey` |
| 平年値を平滑化しない | `scripts/lib/normals.js:28-30` のコメントと `buildNormals` |
| ERA5 の系統差は中央値、30日未満なら測らない | `scripts/lib/normals.js:65` `era5Offset`（`diffs.length < 30`） |
| 10年移動平均は窓11点、端は描かない | `public/assets/tab-analysis.js:124` `movingAverage`（`window = 10`、`slice.length < window / 2` で `null`） |
| 検証用の品質フラグは 1 以下 | `scripts/lib/verify.js:9,19` `MAX_QUALITY_FLAG = 1` |
| 実況のアメダスはフラグ 0 のみ、値の 0 は欠測ではない | `public/assets/live.js:25-27` |
| 時間別に補正を当てていない | `scripts/lib/openmeteo.js:133` `fetchForecastHourly` / `scripts/build-derived.js:456` `corrected: false` |

## 第5章 限界

| 記述 | 実装 |
|---|---|
| 補正するのは日別の5変数 | `scripts/build-derived.js:29` `MOS_VARS`（tmax / tmin / rh / wind）+ `prcp` |
| 予報側の日別値は 00〜23時の24点中18点以上 | `scripts/lib/openmeteo.js:328` `foldHourlyToDaily` |
| 日別実測に日内の観測個数を持っていない | `scripts/collect-observation.js:24` `FIELDS`（`n` が無い） |
| 地点は4つ | `config/locations.json` |

## 既知の食い違い（解説には書かず、ここに残す）

| 箇所 | 内容 |
|---|---|
| `.claude/CLAUDE.md` の「実測レコードの `n` が閾値未満の日は検証対象から除外する」 | 日別実測に `n` を持っていないため未実装。近いのは予報側の畳み込み条件（24点中18点）。解説では「足切りは品質フラグだけ」と書いてある |
| `scripts/lib/calibrate.js:353` `shrinkToPooled` | 実装とテストはあるが `build-derived.js` から呼ばれていない。解説には書かない |
