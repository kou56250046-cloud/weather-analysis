# tasks — 解説タブ

上から順に処理する。1タスクごとに完了条件を満たすことを確かめてから次へ進む。

- [x] T0. `scripts/build-derived.js` を直す。`buildMosForecastRows` に `rain` の前向き検証予測を
      `pop` として通し、`leak` に `rain` の行を足す。そのうえで `node scripts/build-derived.js` を
      走らせて `public/data` を再生成する。
      **完了条件**: 4地点の `scores-<loc>.json` に `source='blend:mos', variable='pop'` の行があり、
      `brier` と `reliability` を持つ。`leakcheck.json` に `variable='rain'` の行がある。
      成績タブの信頼度図が `blend:mos` を描く（C12 / C13 / C14）

- [x] T1. `public/assets/style.css` に `.formula` `.frac` `.sqrt` `.bigop` `.symbols` `.method-toc`
      を足す。
      **完了条件**: 新規の `--` 変数定義が増えていない（grep）。560px 未満で `.symbols` が1列になる

- [x] T2. `public/assets/tab-method.js` に数式部品 `fx` `frac` `sqrt` `sum` `sym` を書く。
      **完了条件**: 分数・平方根・総和（上下の添字つき）・上下付きを1つずつ含む試作の式が
      明暗どちらでも崩れず、400px 幅で式ブロックだけが横スクロールする

- [x] T3. 第1章「数値予報の仕組みと限界」。
      **完了条件**: 支配方程式5本 + 誤差成長 + 合議の分散低減 の計7式が `.formula` で出る。
      式に出る記号がすべて `sym()` で定義されている。新規のグラフを描いていない

- [x] T4. 第2章「降水確率」。
      **完了条件**: 気象庁の定義（1mm以上・10%刻み）、`P_raw` の式、`P = σ(βᵀx)` の式、
      「量でない・時間の割合でない・面積の割合でない」の3つの否定、
      および「素の比率と較正後の確率は別物で、画面に出るのは較正後」の説明が本文にある

- [x] T5. 第3章「予報を採点する指標」。
      **完了条件**: MAE / RMSE / bias / 適中率 / 空振り率 / 見逃し率 / 捕捉率 / H_rand / ETS /
      BS / BSS / 被覆率 / SS の13式が `.formula` で描画され、2×2分割表が表で出る。
      「毎日降らないと言えば適中率は上がる」の罠が本文にある

- [x] T6. 第4章「このシステムの算出方法」。
      **完了条件**: データ源の表（7行）、説明変数2本（気温系 / 降水系）、Ridge の最小化問題と解、
      ロジスティック、ピンボール損失、区間の3段、前向き検証、天気コードの合議、平年差、
      ERA5 オフセット、移動平均が揃う。
      あわせて `.claude/specs/method-tab/traceability.md` を作り、
      「書いた式・定数・主張 → 実装位置（ファイル:行）」を全行埋める（C11）

- [x] T7. 第5章「この方法の限界」。
      **完了条件**: design §5 の8項目がすべて本文にある

- [x] T8. 実値の差し込み（C6 の3か所 + Brier/BSS + λ と学習日数）。
      **完了条件**: 4地点すべてで3か所が描画される。Brier/BSS は出る地点で描画される。
      `scores` と `coef` を `null` にしても例外が出ず本文が最後まで出る（C7）

- [x] T9. 章へ飛ぶボタン `.method-toc` を先頭パネルに置く。
      **完了条件**: 5つのボタンで各章の見出しへ移動する。`location.hash` が書き換わらない

- [x] T10. `public/assets/app.js` に `import` / `TABS` / `loadFor` の3行を足し、冒頭コメントを直す。
      **完了条件**: タブが5枚出る。`?tab=method` で直接開き、リロードで選択が残る

- [x] T11. `public/sw.js` の `SHELL_ASSETS` に `'./assets/tab-method.js'`、`CACHE_VERSION` を `v3` へ。
      **完了条件**: 理由コメントが1行入っている

- [x] T12. `node --test test/*.test.js`。
      **完了条件**: 全て通る。T0 で採点行を増やしたことで既存テストが壊れていない

- [x] T13. `node scripts/serve.js` で目視。
      **完了条件**: 5タブ往復 / `?tab=method` / 幅400pxで `body` に横スクロールが出ない /
      明暗自動の3状態 / `public/data/scores-*.json` と `coef-*.json` を退避した状態、の5つを確認

- [x] T14. 正典への書き戻し。`.claude/specs/weather-accuracy/design.md` のうち実装とずれている
      次の箇所を訂正する。
      - 149-150行 縮小推定（`shrinkToPooled`）… production パスから呼ばれていない
      - 154-156行 ロジスティックの説明変数と `maxIter`（記載 50 → 実際 25）
      - 161行 分位点回帰の `lr` と反復数（記載 0.01 / 2000 → 実際 0.25 / 400）
      - 166-167行 平年値（記載「実測から自作し±5日平滑化」→ 実際は気象庁公表値をそのまま）
      あわせて画面構成がタブ5枚になったことを書き足す。
      **完了条件**: 訂正後の記述が `traceability.md` と矛盾しない
