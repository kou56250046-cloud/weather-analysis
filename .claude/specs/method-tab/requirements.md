# requirements — 解説タブ

## 背景

この画面の主張は「予報は外れる。どれくらい外れるかを先に言う」。
ところが、その主張を支える算出方法が画面のどこにも書かれていない。
各タブの `note` は結論だけを1〜2文で述べ、平均絶対誤差・ETS・Brier score・
80%予測区間・前向き検証といった語が定義されないまま出てくる。
降水確率が何を意味する数字なのかも書いていない。

精度を開示するという建て付けである以上、「どう算出したか」も同じ画面に置くべき。
気象の一般的な分析方法、降水確率の定義と算出、検証指標、そして本システムが
実際に走らせている計算を、数式込みで1か所に集約した解説タブを足す。

読み手の想定は、気象の専門家ではないが数式を読む素地はある人。
「なぜその数字が出るのか」をコードを開かずに追えるところまで書く。

## 受入条件

- [x] C1. タブが5枚になり、5枚目「解説」が既存4タブと同じ操作で開ける
- [x] C2. `?tab=method` で直接開ける。選択は localStorage に残る
- [x] C3. 5章立てで構成する
      (1) 数値予報の仕組みと限界 (2) 降水確率 (3) 予報を採点する指標
      (4) このシステムの算出方法 (5) この方法の限界
- [x] C4. 次の式を数式ブロックとして表示する
      MOS の線形式 / Ridge の最小化問題と解 / ロジスティック回帰 / ピンボール損失 /
      平均絶対誤差 / 二乗平均平方根誤差 / 偏り / 2×2分割表と適中率・空振り率・見逃し率・捕捉率 /
      ETS / Brier score と Brier skill score / 被覆率 / アンサンブル降水確率 /
      季節項 / 合議の分散低減 / 移動平均 / 平年差 / スキルスコアの一般形
- [x] C5. 数式は外部ライブラリ（MathJax / KaTeX）を使わず HTML と CSS だけで組む。
      `style.css` に外部 URL が増えていないことを grep で確認する
- [x] C6. 現行の `public/data`（世田谷・川崎・相模原・熱海のいずれを開いても）において、
      次の3か所が実際に描画される
      1. 連続値の誤差の式の直後 … `blend:mos / tmax / lead=3` の MAE・RMSE・偏り・検証日数
      2. 分割表の直後 … `blend:mos / rain` の最小 lead の H・F・M・C と適中率・ETS
      3. 被覆率の式の直後 … `scores.coverage['tmax|3']` の被覆率と平均幅
- [x] C7. `scores-<loc>.json` と `coef-<loc>.json` が両方 `null` でも解説本文は最後まで表示される。
      差し込み部分だけが消える
- [x] C8. 画面幅 400px でも本文は折り返し、式ブロックは横スクロールで読める。
      `body` に横スクロールが出ない
- [x] C9. 明・暗どちらの配色でも読める。判定は次の2つ
      (a) `style.css` に新規の `--` 変数定義が増えていない（grep）
      (b) 明・暗・自動の3状態で目視して本文と式が読める
- [x] C10. `node --test test/*.test.js` が通る。`sw.js` の `SHELL_ASSETS` に新モジュールを足し、
      `CACHE_VERSION` を上げる
- [x] C11. 記述が実装と一致している。判定できる形にするため、
      `.claude/specs/method-tab/traceability.md` に「解説に書いた式・定数・主張 → 参照した実装位置
      （ファイル:行）」の対応表を作り、全行が実在を指していることを確認する。
      実際には呼ばれていない関数（`shrinkToPooled`）を「やっている」と書かない
- [x] C12. 較正後の降水確率を採点対象に加える。`build-derived.js` の `buildMosForecastRows` に
      `rain` の前向き検証予測を `pop` として通し、`blend:mos` の pop 行が
      `scores-<loc>.json` に出るようにする。
      **完了条件**: 4地点すべてで `source='blend:mos', variable='pop'` の行が1件以上あり、
      `brierSkillScore` が数値で入っている
- [x] C13. 成績タブの信頼度図が、較正後の確率（`blend:mos`）を描く。
      `tab-scores.js:335` の find が素のモデルへフォールバックしない
- [x] C14. 較正後の確率も前向き検証であることを示す。`leakcheck.json` に `rain` の行を足し、
      成績タブの「未来を見ていない証拠」と同じ形で評価開始日・学習終端を持たせる

## 非目標

- **数値予報モデルそのものの教科書は書かない。** 支配方程式は名前と役割まで。
  離散化・物理過程のパラメタリゼーションには踏み込まない
- **汎用の数式組版エンジンを作らない。** この画面で要る式だけを組める最小の部品にとどめる
- **解説タブに新規のグラフを描かない。** 誤差成長・信頼度図・分割表・分散低減はどれも
  作図を誘発するが、図が要る話は既存タブへの参照にとどめる。表と式だけで書く
- **五十音順の用語集は作らない。** 用語は章の流れの中で定義する
- **解説文をデータ駆動にしない。** JSON から文章や式を生成しない。本文は静的に持つ
- **他タブの `note` 文面は書き換えない。他タブから解説への用語リンクも作らない。**
  多少の重複は許容する
- 多言語化しない。日本語だけ
- 印刷用レイアウト・PDF 出力は作らない
- 新しい収集・集計スクリプトは作らない。収集（`collect-*.js`）には一切触らない
- `public/data/` の既存フィールドの意味を変えない。追加（`blend:mos` の pop 行、`leakcheck` の
  rain 行）だけで済ませ、読み込み側の後方互換を壊さない

## 触るファイル

| ファイル | 変更 |
|---|---|
| `public/assets/tab-method.js` | 新規。解説タブ本体と数式部品 |
| `public/assets/app.js` | `import` 1行 / `TABS` 1行 / `loadFor` 1行 / 冒頭コメント「タブ4枚」の更新 |
| `public/assets/style.css` | 数式ブロックと記号表と章リンクのスタイル |
| `public/sw.js` | `SHELL_ASSETS` に1行、`CACHE_VERSION` を v3 へ |
| `scripts/build-derived.js` | `buildMosForecastRows` に pop を通す / leak に rain を足す |
| `public/data/*.json` | 再生成（`node scripts/build-derived.js`） |
| `.claude/specs/method-tab/` | この仕様と `traceability.md` |
| `.claude/specs/weather-accuracy/design.md` | 実装とずれている記述の訂正（T14） |

## 検証方法

1. `node scripts/build-derived.js` が4地点とも完走し、`blend:mos` の pop 行が生成される
2. `node --test test/*.test.js` が全て通る（`sw.js` の実在検査を含む）
3. `node scripts/serve.js` で開き、5タブを往復。`?tab=method` で直接開く
4. 幅 400px と 1200px の両方で本文が読める。式ブロックだけが横スクロールする
5. 配色を明・暗・自動で切り替えて読める
6. `public/data/scores-*.json` と `coef-*.json` を一時的に退避しても解説が最後まで表示される
7. `traceability.md` の各行を実際に開いて突き合わせる。特に次の定数
   `MAX_QUALITY_FLAG = 1`（`verify.js:9`）/ `RAIN_THRESHOLD_MM = 1.0`（`verify.js:6`）/
   `MIN_TRAIN = 60` と学習開始の下限 `MIN_TRAIN + 10 = 70`（`calibrate.js:13,258`）/
   `RETRAIN_EVERY = 7`（`calibrate.js:19`）/ `RETRAIN_EVERY_ITERATIVE = 28`（`calibrate.js:294`）/
   `LAMBDAS = [0.01, 0.1, 1, 10, 100]`（`calibrate.js:22`）/ 区間の `1.28`（`blend.js:88,115`）/
   季節項の周期 `365.2425`（`time.js:70`）/ 畳み込みの「24点中18点」（`openmeteo.js:328`）/
   ERA5 オフセットの `n ≥ 30`（`normals.js:76`）/ 実況の品質フラグ `!== 0`（`live.js:27`）
