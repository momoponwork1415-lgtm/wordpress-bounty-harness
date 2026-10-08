---
status: accepted
---
# 探索エージェントは隔離Lab内で対象を実行してよい

Discovery runは、gVisor内の使い捨てWordPress + MySQL Labに対してHTTP・DB読み取り・canary確認を行い、仮説を実行で確かめてよい。Lab外への到達、外向き通信、ホストでの対象実行、永続化は禁止。読み取り専用sourceだけで探索する旧方針は採らない。高い真陽性率を公開した設計（Mythos / Glasswing、Firefox、XBOW）はすべて探索エージェント自身が対象を動かしており、ソースのみで同等の精度が出た公開証拠はないため。

## Considered Options

- 読み取り専用sourceのみ: 安全だが精度の根拠がない。
- Lab内実行を許可: Labの供給費用が増えるが、公開事例と一致する。採用。
