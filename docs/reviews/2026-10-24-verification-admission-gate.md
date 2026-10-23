# 管理者設定の文言で検証を止めていた経路（2026-10-24）

## 問い

「明示除外以外は検証へ」という段 1 の方針に対し、Harness の入口と handoff に別の停止条件が残っていないか。

## 観測

`wbh-screen` v4 は任意機能の有効化を名前だけで除外しない。一方、候補受理と Verifier は `configurationPrecondition` にある管理者の設定操作を `admin-configuration` と分類すると、対象内 impact でも `finding-parked` にするか、transport を動かす前に `incomplete(precondition)` で終えていた。分類は文の形を見るもので、実際の設定が危険か、Wordfence のいう管理者の誤設定かを観測していない。

本番の同理由の入口 park は 3 件。うち 1 件は製品名と否定表現に反応した誤分類で、2 件は明示的なチェックボックス操作を含む。後者も操作だけで不適切な設定とは判断できない。Wordfence の[公式規則](https://www.wordfence.com/bug-bounty-program-terms/)は管理者の誤設定と、低権限者への明示的な権限付与に依存する場合を対象外としている。通常機能を有効化する行為は一律除外と書かれていない。

## 変更と確認

分類値は保持し、入口と Verifier の `admin-configuration` による park と事前中止を外した。前提が Lab で作れなければ、具体的な理由を持つ `incomplete(precondition)` としてレビュー列に残す。旧入口 park は元の Finding artifact、Snapshot、identity、Programme Boundary を照合して、記録済み Finding と復帰 event を追記できる。Programme Boundary 外の park と検証中の park はこの操作の対象外とする。

合成 Finding の候補受理・Verifier・旧 park 復帰テストを更新し、`pnpm check` で 1175 件成功、2 件 skip。実台帳を読み取り専用で復帰検査した結果も 3 件とも `ready`（`admin-configuration` 2、`unknown` 1）だった。判定器、nonce canary、Snapshot digest、`incomplete` の条件は変更していない。

本番 runner は旧版で稼働中であり、新 event を読むまで共有台帳に復帰を適用しない。3 件は現時点でまだ検証列に戻っていない。また、固定された通常シナリオを持たない handoff は scope の通常設定判定が `ambiguous` になり得る。これは検証結果そのものとは別の、報告工程へ進むための証拠の不足として扱う。

所有者は同日、2026-10-17 に一律 park とした 5 impact 分類については、今回も既存の Programme Boundary を維持すると回答した。この変更では 5 分類と元から対象外の 5 分類を動かさない。
