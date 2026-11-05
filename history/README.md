# history — 見返すための保管庫

ここは、使わなくなった目的文・スキル・実験記録・過去 4 世代の知識を、あとで見返すために置いておく場所である。

- Harness のコードも test もここを読まない。`scripts/copy-assets.mjs` は `src/` だけを `dist/` に写すので、ここの `.md` は配布物にも入らない。
- AGENTS.md の「読む順」には入れない。作業のたびに読む必要はない。過去の問いや数字を確かめたいときだけ開く。
- 正本ではない。食い違えば [docs/SPEC.md](../docs/SPEC.md) と [docs/adr/](../docs/adr/) が勝つ。
- 中身は移した時点のまま書き換えない。ファイル内のリンクだけ、移動に合わせて相対パスを直した。

## 何がどこから来たか

所有者の 2026-11-05 の決定（探索方式を `wp2shell-bounty-v26-wide` に固定し、使わない旧文書は history に置き、それを読むコードは削除する）で移した。移す前の状態は、main の `7abbd0b` と tag `archive/pre-v26-cleanup`（`5fb7cbf`、PR #819〜#822 の前）に残る。

| ここ | 元の場所 | 移した日 | 理由 |
| --- | --- | --- | --- |
| `prompts/objectives/` | `src/profiles/wordpress/prompts/*.md`（v26-wide と trust-boundary-v2 以外の 39 本） | 2026-11-05 | 新しい Trial に渡さない目的文、旧 Verifier 指示（`verifier-v6`〜`v8`）、旧 trust 境界宣言 `trust-boundary-v1`。登録簿（`src/profiles/wordpress/prompts/index.ts`）から行を外した |
| `prompts/sections/` | `src/profiles/wordpress/prompts/sections/` | 2026-11-05 | v10〜v19-wide を断片から組むための段落。合成コードごと削除した |
| `skills/` | `src/profiles/wordpress/prompts/skills/`（tag `archive/pre-v26-cleanup` から復元） | 2026-11-05 | PR #819（`experimental/wbh-audit-v1/v2`）と #822（`wbh-recon-v1〜v3`、`wbh-tools-v1`、`wbh-setup-v1`、`wbh-lab-v1`、`wbh-falsify-v1/v2`）で消した探索スキル本文。`upstream-license.txt` も一緒に置く |
| `evaluation/` | `docs/evaluation/` | 2026-11-05 | 2026-10〜11 の計測・ベンチの記録 |
| `knowledge/` | `docs/knowledge/` | 2026-11-05 | 過去 4 世代の実験記録 `experiments.md` と取り込んだ原本 |
| `examples/campaign-wide-20.json` | `examples/campaign-wide-20.json` | 2026-11-05 | v22-wide を名指す設定例。v22-wide が登録簿から外れたので parse できない |

## 台帳との関係

台帳の `discovery-run-started` には、ここにある目的文の id と digest が残っている。台帳は追記専用なので書き換えない（SPEC 第 2 節 8）。ここの本文の sha256 は、その digest と一致する。ただし、v10〜v19-wide の digest は `prompts/sections/` の断片を空行でつないだ本文の digest で、同じ本文を写した `prompts/objectives/<id>.md` の digest とも一致する。

ここにある版で記録した Trial は、登録簿に版が無いので `campaign resume` が `prompt-version-differs` で断る。旧 Trial の実際の入力全文は、Git 外の Private Evidence にそのまま残る。
