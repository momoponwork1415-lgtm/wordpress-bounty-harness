# Cloudflare 派生監査の目的文 v25-wide

マージ前の独立レビューで見つかった二つの指示の食い違いを直す。v24-wide は本文と digest を保存して archived とした。新規の比較 Trial は v25-wide と、変更のない `wbh-audit-v2`、生成契約 v6 を組み合わせる。スキルと契約の全文・日本語訳は [gate v2 の記録](2026-11-04-cloudflare-audit-gate-v2.md) にある。この文書は探索 agent への入力ではない。

## 目的文の英語全文

```text
Current task statement:

Audit the pinned WordPress plugin source in /workspace/main for vulnerabilities reachable from an unauthenticated visitor, Subscriber or Customer on a normally used WordPress site. The supplied trust boundary defines attacker positions and the Programme Boundary defines in-scope effects. A vulnerability is not assumed. Report a Finding candidate only when the supplied source supports its entry, relevant control, path and in-scope effect. Report a Lead when the source supports a concrete path with one unresolved edge to an in-scope effect; state that edge and every unresolved condition.

Read the installed wbh-audit skill (pinned as wbh-audit-v2 in the campaign) before planning work or starting agents. It owns the audit workflow, the research records, independent gap and candidate checks, Lab questions, and the final report. Use its relevant WordPress companion instructions when a source-visible boundary calls for them. The Harness-generated sections own the run limits, available Lab commands, prior inputs, and Finding and Lead output contract; follow those sections for their exact values and formats.

Use only the fixed source and permitted prior research supplied in this workspace. Do not consult the internet, published vulnerability descriptions, changelogs or Git history to identify a patched vulnerability. Check the supplied WordPress core, PHP and dependency source for any control or behavior on which a claim depends. A required source or Lab fact that is absent remains an explicit gap.

Stop when the Trial wall is reached. Before the final report, complete the wbh-audit closing checks or record the exact unfinished work and reason. A bounded audit may report zero candidates.
```

## 日本語訳

```text
現在のタスク文:

/workspace/main にある版を固定した WordPress プラグインのソースを監査し、通常利用の WordPress サイトで未認証の訪問者、Subscriber、Customer から到達できる脆弱性を探す。渡された trust 境界宣言が攻撃者の立場を、Programme Boundary が対象範囲内の影響を定める。脆弱性があるとは仮定しない。Finding 候補を報告するのは、渡されたソースが入口、関係する防御、経路、対象範囲内の影響を裏付けるときに限る。対象範囲内の影響までの経路に未解決の辺が一つだけ残る場合は Lead を報告し、その辺と未解決の条件をすべて明記する。

作業の計画や子 agent の起動より先に、インストール済みの wbh-audit スキル（campaign で固定した ID は wbh-audit-v2）を読む。このスキルが監査の流れ、研究記録、独立した漏れ点検と候補の確認、Lab の問い、最終報告を受け持つ。ソースで見える境界に関係するときは、WordPress 用の補助指示を使う。Harness が生成する節が実際の実行上限、利用できる Lab コマンド、過去入力、Finding と Lead の出力契約を定める。正確な値と形式は、その節に従う。

この workspace に渡された固定ソースと、許可された過去の研究だけを使う。修正済みの脆弱性を見つけるためにインターネット、公開脆弱性の説明、変更履歴、Git 履歴を見ない。主張に必要な防御や挙動は、渡された WordPress 本体、PHP、依存ソースで確かめる。必要なソースや Lab の事実が無ければ、解決していない点として明記する。

Trial の制限時間に達したら止める。最終報告の前に wbh-audit の終了時の点検を完了するか、未完の作業と理由を正確に記録する。時間を区切った監査で候補 0 件を報告してもよい。
```

## 差分と出典

| v24 からの変更 | 根拠 |
| --- | --- |
| Finding の完成経路と、一辺未解決の Lead を分けて指示 | `wbh-audit-v2/validation-and-reporting.md` Phase 3・4 と既存の Lead 契約 |
| インストール済みスキルの名前を `wbh-audit` とし、固定 ID を別に記す | `wbh-audit-v2/SKILL.md` の front matter と `src/discovery/skill-definition.ts` の配置規則 |

目的文以外の agent 向け文、`wbh-audit-v2` の digest、生成契約 v6 の digest は変えない。v25-wide の SHA-256 は `sha256:cacc8ff2ca04a61446fef3ac42ec6b89502d6b5ea5edbae796f5ad772d5ba3cd`。
