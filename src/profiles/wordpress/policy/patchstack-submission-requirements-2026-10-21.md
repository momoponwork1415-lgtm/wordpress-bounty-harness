# Patchstack の Submission requirements（写し、2026-10-21）

所有者が 2026-10-21 に Patchstack の提出要件のページから貼った文の写しである。原文は英語のまま置く。URL は所有者から受け取っていないので、使う前に公開ページと照合する。報告書 skill（`wbh-report`、#439）が報告書の形をこの文に揃えるために読む。探索エージェントには渡さない。

Wordfence の受理規則の文は、所有者が別に持ってくる（#436）。届いたら同じ形式で `wordfence-acceptance-rules-<日付>.md` として隣に置く。

## 原文

Submission requirements

* Reports must be written in English.
* Reports must be tested against the latest available version of the component.
* Attach the correct component slug, link, and version — e.g. do not report a pro-version issue against the free version.
* PoCs must contain detailed, step-by-step reproduction from a remote attacker's perspective, including HTTP requests, screenshots, or videos. WP-CLI or other server-side-only steps are not accepted.
* Upload PoCs and other files as attachments — links to third-party sources that can expire are not accepted.
* Duplicates of earlier reports or already-published CVEs.
* Multiple findings of the same vulnerability type must be consolidated into a single report.
* Vendor or developer self-submissions — accepted for disclosure but not eligible for bounties.
* Incomplete, inaccurate, or unverifiable information, or invalid vulnerability claims.
* Unrealistic pre-requisites or exploitation scenarios.
* Closed, inaccessible, abandoned, or non-publicly-distributed components.
* For premium components, attach the original, unmodified archive so we can validate.

## 読み方

原文は「満たすこと」と「受け付けないもの」が 1 つの列に混ざっている。報告書 skill は次のように分けて読む。

- 満たすこと: 英語、最新版で試す、slug・リンク・版を正しく付ける、遠隔の攻撃者の視点で HTTP 要求・画面・動画を含む手順、添付で出す、同じ種別は 1 本に束ねる、premium は原本の archive を添える。
- 受け付けないもの: 重複と公開済み CVE、vendor 自身の提出（報酬なし）、不完全・不正確・検証できない情報、非現実的な前提、閉じた・配布されていない component。

Wordfence の規則文と食い違う点が出たら、提出先ごとに skill の節を分け、この写しは変えない。
