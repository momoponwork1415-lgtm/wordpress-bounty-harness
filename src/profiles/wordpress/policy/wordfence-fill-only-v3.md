# Wordfence Fill-Only JSON v3

Wordfence 向けの報告 skill `wbh-report` と、所有者の Fill-Only 拡張機能の入力契約である。フォームの項目名と必須印の出典は [提出フォームの写し](wordfence-submission-form-2026-10-21.md)。2026-10-23 に所有者が提示した画面で、AI 利用の Yes/No と「What AI tool(s) did you use to generate this report or discover this vulnerability?」が別の必須項目であることを確認した。所有者は、この欄のツール名を JSON から入力する方針を選んだ。旧 `wordfence-fill-only/2` は過去の報告の照合用に残し、新規の入力には使わない。

## JSON の構造

- `schema_version` は厳密に `wordfence-fill-only/3`。
- `generated_at` は生成日時。`target` は `software_name`、`software_slug`、`version` の非空文字列を持つ。
- `fields` は下表の 16 件を番号と順序どおりに持つ。各要素は `field_number`、`key`、`kind`、`required`、`value` を持つ。余分な key と重複を受け付けない。`choice` / `text` / `long-text` の値は文字列、`multi-text` の値は文字列の配列にする。必須項目の値は空にしない。
- `poc.markdown` は `proof_of_concept` の値と一致する。`human_verification.status` は暫定版で `pending`、人間の手動再現と最終査読後の版で `confirmed` とする。`rejected` は入力しない。`human_only.never_automate` は人間が扱う欄・操作の一覧で、AI tool(s) の名前を含めない。
- `source` と `report_style` は内部の出典と版名に使える。拡張機能はフォーム入力値として扱わない。

| 番号 | key | kind | required |
| --- | --- | --- | --- |
| 1 | `software_type` | `choice` | true |
| 2 | `software_name` | `text` | true |
| 3 | `software_slug` | `text` | true |
| 4 | `version_operator` | `choice` | true |
| 5 | `affected_version_to` | `text` | true |
| 6 | `description` | `long-text` | true |
| 7 | `vulnerability_type` | `choice` | true |
| 8 | `impact_statement` | `text` | true |
| 9 | `cwe` | `choice` | true |
| 10 | `authentication` | `choice` | true |
| 11 | `affected_code_references` | `multi-text` | false |
| 12 | `product_references` | `multi-text` | false |
| 13 | `proof_of_concept_type` | `choice` | true |
| 14 | `proof_of_concept` | `long-text` | true |
| 15 | `environment` | `long-text` | true |
| 16 | `ai_tools` | `long-text` | true |

`ai_tools` の初期テンプレートは `OpenAI Codex and Claude Code` とする。人間が最終査読で実際に使ったツールに合わせて修正する。AI 利用の Yes/No は人間が選ぶ。Certification、開示の委任、CVE・他 vendor への報告、研究者 identity、規約同意、CAPTCHA、Submit も人間が扱う。

Affected Version(s) は `version_operator` の `<=` と `affected_version_to` の確認版だけを入力する。`affected_version_from` は v3 の `fields` に含めない。

`cwe` の JSON 値は `CWE-<番号>` とする。実フォームは Tom Select の `value` に番号だけを持ち、表示文言には説明も付ける。拡張機能は `CWE-640` と `value: "640"` のように番号を完全一致させ、表示文言の接頭辞も同じ番号であることを確認する。番号の重複や不一致は停止する。

## 拡張機能の動作

- 選ぶファイルは `-r<revision>.wordfence-fill.json`。`submission-package.json` は入力しない。
- JSON の版、16 項目の key・番号・型・必須値をフォーム操作前に検査する。`pending` は確認表示のみで、入力を許さない。`confirmed` の JSON に対し、同じファイルとタブでプレビューが成功した後だけ入力する。
- Wordfence の主フォーム内で、各入力欄を一意に特定する。2026-10-23 の実フォームでは `ai_tools` はラベル要素を持たない `textarea#pocAiToolsUsed` である。見つからない、複数ある、非表示の場合は停止する。選択肢は正確に一致するものだけを選び、入力後は値を読み戻す。
- 拡張機能は Submit せず、上記の人間専用項目を変更しない。拡張機能の確認結果は、提出前の人間の手動再現・査読・承認を代行しない。

報告 Markdown には同じ版の JSON の sha256 を記し、`submission-package/v1` manifest は Markdown と JSON の path・byte 数・sha256 を持つ。人間が最終版を作るときは両方を再計算し、暫定版を上書きしない。
