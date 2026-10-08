---
status: accepted
---
# runtime-confirmed はHarness所有の決定論的判定器だけが出す

`runtime-confirmed` は、Labが仕込んだnonce canaryの回収、headless browserでの実行観測、ロール別正常操作との差分など、Harnessが所有する決定論的判定器だけが出す。エージェントやrecipeスクリプトの自己申告、LLMの合議は確認にしない。LLMの合議が存在しない脆弱性を全員一致で支持した事例（Refute-or-Promote）と、XBOWが非AIの検証器だけを「偽陽性ゼロ」と呼ぶことによる。判定器を定義できない種別は `incomplete(no-judge)` として人間へ回す。
