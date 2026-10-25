---
status: accepted
superseded-by: 0040
---
# runtime-confirmed はHarness所有の決定論的判定器だけが出す

`runtime-confirmed` は、Labが仕込んだnonce canaryの回収、headless browserでの実行観測、ロール別正常操作との差分など、Harnessが所有する決定論的判定器だけが出す。エージェントやrecipeスクリプトの自己申告、LLMの合議は確認にしない。LLMの合議が存在しない脆弱性を全員一致で支持した事例（Refute-or-Promote）と、XBOWが非AIの検証器だけを「偽陽性ゼロ」と呼ぶことによる。判定器を定義できない種別は `incomplete(no-judge)` として人間へ回す。

## 2026-10-25 注記（#525、所有者決定 2026-10-25）

この決定は [ADR 0040](0040-human-lab-observation-replaces-judges.md) で置き換えた。判定器は削除し、新しい検証は `runtime-confirmed` も `incomplete(no-judge)` も出さない。確定は、人間が Lab の dialog、観測記録、捕捉を読んで行う。既存の `runtime-confirmed` は、判定器があった時期の記録として読み続ける。
