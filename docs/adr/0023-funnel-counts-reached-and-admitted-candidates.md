---
status: accepted
---

# funnel に最終 JSON 到達と受理の列を加え、token あたりの confirmed で費用を示す

## 決定

評価の funnel を `raw` から始めず、探索 run の出力境界から数える。

- 列は「最終 JSON 到達（Root と子の候補数）→ 受理 → 保留 → verifier 通過 → confirmed / contradicted / incomplete → reviewed → in-scope → submitted → outcome」。campaign 別、arm（prompt の目的文の版）別、impact 分類別に出す。
- 保留 event（ADR 0018）は Finding なら impact 分類、Lead なら primitive と missingEdge を持ち、本文は持たない。funnel はこの分類で集計する。
- `ledger funnel` または副コマンドが、campaign の非 cache 入力 1M token あたりと agent wall 1 時間あたりの `runtime-confirmed` 数を出す。USD が台帳に無い間は token と wall だけを示し、0 USD とは扱わない。
- Finding ごとの検証 attempt 数（ADR 0022）も同じ表で読める。

## 理由

現在の funnel は `raw` から始まるため、出力境界で失われた候補が見えない。2026-10-10 の 3.2.6 比較では優先分類の候補が 4 Trial の Root 最終 JSON に現れたのに正式記録は 1 件で、台帳だけを見ると「同条件で発見がばらついた」ように読めた。長い prompt は短い prompt の非 cache 入力の約 4.8 倍、出力の約 10 倍を使ったが、それに見合う確認が増えたかを示す列が無い。ADR 0017 は候補数だけを成功指標にしないと決めており、費用と確認を結ぶ列が要る。

## 採らなかった選択肢

- 候補の本文を台帳に入れて集計する: 不変条件 8 に反する。分類と digest だけで足りる。
- USD 換算を待つ: 固定料金の購読では run 単位の USD が無い。token と wall で先に比較する。

## 既存決定との関係

- SPEC 第10節の funnel 定義を更新する。前向き評価と提出転帰の指標は変えない。
- ADR 0007 の usage 記録をそのまま分母に使う。

## 帰結

- 受入条件: 3.2.6 の既存 campaign（tp326-*）を再集計した表を Issue に貼る。過去 event は変更せず、`candidate-rejected` は保留と同じ列に数える。
- #100 の「3 対象後の評価表」はこの funnel を使う。
