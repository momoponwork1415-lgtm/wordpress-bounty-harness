<!-- provenance: /home/dev/harness/game-bugbounty/docs/methodology.md, mtime 2026-07-23, imported 2026-10-13, generation 07-bug-bountgy -->

# Satoki-derived Hytale research loop

このハーネスでいう `Satoki-derived` は、Satoki Tsuji 氏の公開資料から抽出した運用原則と、
公開 Bugzilla 上の調査行動から推論した探索パターンを指す。本人の名前付き公式方法論や
非公開実装の再現を意味しない。なお、確認した一次情報での日本語氏名表記は
「辻 知希」である。

## 採用する原則

1. **確率を試行数で扱う**  
   単発回答の自己確信を上げるのではなく、fresh な独立 Attempt を複数走らせる。
2. **探索バイアスを異質化する**  
   surface/variant、guard semantics、runtime/oracle を別 lens にし、Codex、Claude Opus、
   Claude Sonnet を round-robin で使う。
3. **自由度と被害半径を分離する**  
   AI は `rg`、Semgrep、archive helper、ローカル Hytale Lab を使える。一方、host filesystem、
   Docker socket、公開提出権限は渡さない。
4. **失敗を次の入力へ変える**  
   後続 round に渡すのは raw conversation ではなく、Candidate graph、conflict、圧縮した
   negative knowledge だけにする。provider や Lab の失敗は技術的反証にしない。
5. **既知 bug を探索座標にする**  
   既知修正を答えとして再提出せず、asset、guard、actor binding、parser、sibling path、
   observable signal に分解して別の組合せを探す。
6. **現実の differential oracle で閉じる**  
   AI の判定や多数決ではなく、同条件の test/control で生じる永続状態・権限・情報・実行の
   差を使う。単なる crash や負荷は Hytale bounty Candidate から外す。
7. **探索と証拠を分離する**  
   Exploration は hypothesis を作るだけである。有望なものだけを固定 Oracle と Negative
   Control を持つ非実行 Trial draft へ freeze し、Candidate 固有 runner は人間が登録する。

最初の実装は安全な checkpoint と yield 計測を優先して Attempt を逐次実行する。独立性は
workspace と文脈の分離で担保し、並列数は実ターゲットでメモリ使用量と研究 yield を観測して
から増やす。

## 一次情報

- [本人 Qiita: AI エージェントと SECCON CTF](https://qiita.com/satoki/items/955302bf2615813bae5a)
- [Mozilla Bug 1883693: known bug から別 oracle を探索](https://bugzilla.mozilla.org/show_bug.cgi?id=1883693)
- [Mozilla Bug 2022394: sibling path と sender binding の差](https://bugzilla.mozilla.org/show_bug.cgi?id=2022394)
- [Mozilla Bug 2022260: self-consistency と actor authorization の分離](https://bugzilla.mozilla.org/show_bug.cgi?id=2022260)
- [SECCON 2023 実行委員会の氏名表記](https://www.seccon.jp/2023/seccon/executivecommittee.html)

