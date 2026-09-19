# 過去予報に湿度と風を補い、日別の湿度・風速にも統計補正を効かせる — タスク

## T1 取得の下回り
- 触るファイル: `scripts/lib/paths.js`, `scripts/lib/openmeteo.js`
- やること: `fcstSuppDir` / `fcstSuppPath` を足す。`fetchPreviousRunsDaily` の `vars:'supp'` で気温・湿度・風の3種だけを要求する
- **完了条件:** `vars:'supp'` で組み立てた URL の `hourly=` が 21 変数（3種 × lead 7）で、`sunshine_duration` と `precipitation` を含まないことを単体テストで確認

## T2 補完レコードと取得済み判定
- 触るファイル: `scripts/backfill-previous-runs.js`, `test/backfill-supp.test.js`
- やること: `buildSuppRecords`、取得済み区間の判定、小数の見積もり関数を足し、export する
- **完了条件:** テストで次を確認。id が既存行の id + `|rhwind` になる／rh と wind が両方 null の日は行を作らない／同じ入力で2回作って upsert しても行数が増えない／完了記録の範囲に全日が入る区間は除外され、1日でもはみ出す区間は除外されない／`--from` をずらして区切りが変わっても完了記録が効く／992日・4地点・7モデルの見積もりが 4,000〜4,500

## T3 `--supplement` モード
- 触るファイル: `scripts/backfill-previous-runs.js`
- やること: `--supplement` で T1・T2 をつなぎ、`data/fcst-supp` へ upsert。2.5 秒間隔、8,000 超で中止
- **完了条件:** `--supplement --from 2026-09-01 --to 2026-09-10 --models jma_seamless` を実行して、4地点の `data/fcst-supp/<loc>/2026-09.ndjson` ができ、同じコマンドの2回目は「取得済みで全区間を飛ばした」と出て API を叩かない

## T4 合流
- 触るファイル: `scripts/build-derived.js`, `test/backfill-supp.test.js`
- やること: `mergeSupplement` を足し、`buildLocation` で fcst の直後に合流する
- **完了条件:** テストで、null だけが埋まる／数値は上書きしない／tmax・prcp は変わらない／対応の無い補完行は捨てる／補完ありとなしで tmax と prcp の `buildSamples` の X と y が一致する、を確認。T3 の小さなデータで build-derived が通る

## T5 本番の取り直し（2回）
- やること: 取り直し前に、比較用の成績を採る必要は無い（T6 で `data/fcst-supp` を退避して比べる）。
  `--supplement --to 2025-04-30` を実行し、**1時間以上空けて** `--supplement --from 2025-05-01 --to 2026-09-11` を実行。
  429 が出たら1時間空けて同じコマンドを再実行する（完了記録で取得済みは飛ぶ）
- **完了条件:** 4地点 × 7モデルの全区間が取得済みになる（3回目の実行で見積もり 0 call）。失敗した区間が 0

## T6 再計算と検証
- 触るファイル: `scripts/compress-old.js`、出力 `public/data/*.json`
- やること: compress-old に補完ディレクトリを足して実行、build-derived を実行
- **完了条件:** requirements の受入条件をすべて照合する。気温・降水の一致は `data/fcst-supp` を一時退避した build と戻した build の `scores-*.json` を突き合わせて確かめる。`git diff --stat data/fcst` が空であること

## T7 正典とコマンドの書き戻し
- 触るファイル: プロジェクトの `CLAUDE.md`、`.claude/specs/weather-accuracy/design.md`
- やること: コマンド一覧に `--supplement` を、データモデルに `fcst-supp` を足す
- **完了条件:** 両方に記載がある
