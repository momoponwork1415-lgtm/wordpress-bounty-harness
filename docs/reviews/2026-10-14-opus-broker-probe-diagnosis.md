# Opus broker の接続確認要求と Trial 判定（2026-10-14）

## 問い

Opus 5.5 の協調 Trial で、推論は正常に転送されたのに `broker-grant-unauthorized` が1件生じ、Trial 全体が `incomplete(policy)` になった原因は何か。

## 観測と出典

- 既存 Trial は推論143要求が成功し、無認証要求1件で未完了になった。既存の台帳 event は変更しない。
- 対象 source を渡さない短い gVisor smoke でも、推論5要求の成功と無認証要求1件を再現した。broker の一時診断で、その1件は認証情報を持たない `HEAD /api/hello` であり、推論 endpoint ではないと確認した。一時診断の生の経路記録は修正に含めない。
- [Anthropic の gateway 互換性資料](https://code.claude.com/docs/en/llm-gateway-protocol) は、Claude Code が Anthropic Messages 形式の gateway にこの接続確認を送り、gateway は拒否しても通常の動作を妨げないと説明する。

## 修正と測定

- Anthropic Messages broker は、正確に `HEAD /api/hello` の場合だけ、upstream に転送せず404で拒否し、`rejectedConnectivityProbes` に計上する。他の無認証要求は従来どおり401で拒否し、`unauthorizedRequests` に計上する。
- `unauthorizedRequests` の内訳として、認証情報の欠落・不一致と Messages 経路・その他の経路の件数を Private Evidence の broker receipt に残す。旧 receipt の読み取りのため、新しい項目は省略可能とする。認証情報、HTTP本文、対象名は通常ログや台帳に加えない。
- 修正後の同じ無害な smoke は、推論成功5件、`unauthorizedRequests: 0`、`rejectedConnectivityProbes: 1`、upstream 4xx・5xx 0件、gVisor 終了コード0だった。broker・sandbox は後片付け済み。

## 残る確認

未実行の新規対象に対する初回協調 Trial で、`unauthorizedRequests: 0`、Root・子 outcome、Finding・Lead、wall・usage を確認する。実対象の成功と最大2対象並列の可否は、この smoke だけでは判断しない。
