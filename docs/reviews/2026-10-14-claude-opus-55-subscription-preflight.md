# Claude Opus 5.5 購読認証と並列 Trial の事前確認（2026-10-14）

## 問い

所有者の Claude 購読を Agent SDK の協調 Trial に利用し、実 OAuth token を探索 sandbox に渡さずに Opus 5.5 の対象 Trial を走らせられるか。今回の負荷試験では Opus 2対象と Codex 2対象の合計4対象を上限候補とする。

## 一次資料との照合

- [Claude Help Center](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan) は 2026-10-07 更新で、Agent SDK と `claude -p` を引き続き購読上限で利用できると明記する。
- [Claude Code 認証資料](https://code.claude.com/docs/en/iam) は `claude setup-token` でブラウザ承認を経て1年の購読 token を発行し、`CLAUDE_CODE_OAUTH_TOKEN` を SDK と script で使えると説明する。`ANTHROPIC_AUTH_TOKEN` は gateway 用 Bearer credential で、保存済み購読 login より優先される。
- [gateway 資料](https://code.claude.com/docs/en/llm-gateway) は `ANTHROPIC_BASE_URL` だけなら保存済み購読 login が有効だが、gateway credential を置くとその login は送られず、購読上限も使われないと説明する。購読 OAuth を upstream に送る gateway は `anthropic-beta` の OAuth capability を維持する必要がある。[互換性資料](https://code.claude.com/docs/en/llm-gateway-protocol) は `/v1/messages?beta=true`、`anthropic-version` と `anthropic-beta` の転送、利用上限と retry header の転送を示す。
- [model 設定資料](https://code.claude.com/docs/en/model-config) は Opus 5.5 に Claude Code 2.1.280 以降を要求する。旧 image の 2.1.278 は要求 model を認識しなかった。
- [法務資料](https://code.claude.com/docs/en/legal-and-compliance) は、第三者の開発者が自社アプリに claude.ai login を提供したり、利用者の購読資格を代理で経由させたり、資格情報を収集・保存・中継したりすることを制限する。今回の経路は所有者本人のローカル Harness と本人の token に限定する。第三者向け認証機能として提供する判断は含めない。

## 実装と非秘密の試験

- broker は `anthropic-subscription-token` を host 所有・0600 の Git 外ファイルから読む。実 token は gVisor broker sidecar の secret mount にだけ置き、探索 sandbox は Trial 限定 Bearer grant を `ANTHROPIC_AUTH_TOKEN` として受け取る。broker は固定 `api.anthropic.com`、Opus 5.5、期限、要求数、request/response byte 上限を維持する。`oauth-2025-04-20` capability が無い購読要求は送信しない。
- Claude Code 2.1.296 と Agent SDK 0.3.296 の新 image を build し、`runsc` で `claude --version` が 2.1.296 を返すことを確認した。image digest は `sha256:bc75a5852e2507501adadace5aeb80030eed8dff98d6a061c37644b348f17f92`。
- 実 token・対象 source を使わない gVisor 内の内部 network probe で、Claude Code 2.1.296 が Trial 限定の偽 Bearer token を付けて `POST /v1/messages?beta=true` を送り、model `claude-opus-5-5` と `oauth-2025-04-20` を含む `anthropic-beta` を送ることを観測した。偽 upstream は 401 を返したため、実 provider の model 権限・購読計上・rate limit は未測定。
- `pnpm check` は89ファイル・678テストに合格した。mock は grant の照合、OAuth capability、host token の upstream 差し替え、応答の secret redaction、runsc 側の grant のみの受け渡しを検査する。

## 実 Trial 前に残る条件

1. 所有者が公式 `claude setup-token` で発行した token を本人所有・0600 の Git 外ファイルに保存し、値ではなく絶対パスだけを伝える。既存の短命な Claude login credential を sandbox にコピーしない。
2. 独立した Git 外 state と ledger を使い、現 Codex と過去の開発 Trial に含まれない fresh slug を固定する。Codex 側の別 campaign 検知 guard の調整と選定結果を確認する。
3. Opus の最初の対象を1件で実行し、provider の応答、要求数、usage、wall、CPU・RAM、Lab、broker の失敗理由を観測する。成功・失敗にかかわらず `incomplete` を陰性に数えない。
4. その実測を踏まえ `resources.maxConcurrentTargets: 2` に上げる。`maxConcurrentRuns` は対象間の並列レバーではなく、`memoryBudgetMiB` も全 campaign の予約ではない。Opus 2＋Codex 2の同時負荷は外側で監視する。

現在の実対象 Trial は0件。3 Trial の開発ゲートと実効最大並列の判定は未達で、PR は Draft のままにする。
