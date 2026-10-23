# Wordfence 提出フォームの選択肢（2026-10-23）

所有者がブラウザ上のフォームから取得した DOM と Tom Select のデータを照合した。入力済みの値と hidden token は取得していない。全件の `value` と表示文言は [JSON](2026-10-23-wordfence-form-options.json) に保存した。JSON の `source_sha256` は所有者が渡した選択肢 export の SHA-256 である。これは採取日の写しであり、拡張機能は入力時のフォームと照合する。

| 項目 | 件数 | 取得元 |
| --- | ---: | --- |
| Vulnerability Type | 51（先頭の案内項目を含む） | `select#vulnerabilityType` |
| Authentication Level Required | 8 | `select#vulnerabilityAuthLevel` |
| Common Weakness (CWE) Type | 948 | `input#tomselect-1` の Tom Select `options`。remote loader なし |

CWE のドロップダウンが画面に描画していたのは先頭 50 件だったが、Tom Select は 948 件を保持していた。TranslatePress の暫定 JSON にある `CWE-640` は、表示文言 `CWE-640: Weak Password Recovery Mechanism for Forgotten Password`、フォーム値 `640` に対応する。`Account Takeover (Admin)` のフォーム値は `3`、`None/Unauthenticated` は `none`、PoC の `Other, or text instructions` は `text` だった。CWE の照合は番号 640 の完全一致とし、表示文言全体との文字列一致にはしない。
