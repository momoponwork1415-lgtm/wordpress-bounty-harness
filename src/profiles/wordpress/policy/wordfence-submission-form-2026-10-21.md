# Wordfence の提出フォームの項目（写し、2026-10-21）

所有者が 2026-10-21 に Wordfence の提出フォームから console の JavaScript で取った項目の写しである。残したのは項目名、必須印（*）、選択肢と説明文だけで、フォームに入っていた値は写していない。報告書 skill（`wbh-report`、#439）が節をこの項目に対応付けるために読む。送信は所有者が自身の拡張機能で行う。

2026-10-23 に所有者が提示したフォーム画面でも、`Video Demonstration` に必須印がないことを再確認した。

## 項目

### Software

- Type of Software * — 選択: WordPress Core / WordPress Plugin / WordPress Theme
- Software Name *
- Software Slug *
- Affected Version(s) * — 比較子（`<=` など）と版。説明: "If you're unsure of what to enter here, please use <= and provide the latest version of the software in which the vulnerability was confirmed to be present."
- Would you like Wordfence to handle the responsible disclosure of this vulnerability on your behalf? * — 説明: "Please note you will not be eligible for a bounty or CVE through our Bug Bounty Program if you select 'No'."

### Vulnerability Details

- Description of Vulnerability * — 説明: "Describe the vulnerability you have discovered, concisely and accurately."
- Vulnerability Type * — 選択（一覧はフォーム側）。説明: "Select the vulnerability type that best matches your report."
- Impact Statement * — 説明: "Provide a one sentence statement of impact, up to 200 characters. Example: Unauthenticated users can upload image files."
- Common Weakness (CWE) Type * — 選択（名前か CWE 番号で検索）。説明: "Select the most appropriate CWE for this vulnerability. You can search by name or by CWE number if needed."
- Authentication Level Required * — 選択（役割）
- References to Affected Code — 説明: "Provide URLs to affected code on public repositories."
- References — 説明: "Provide any supporting URLs where applicable."
- Contributing Researchers — 検索か新規入力。説明: "Add any researchers (other than yourself) that contributed to this discovery."

### Proof of Concept

- What is your Proof of Concept? * — 選択（例: "Other, or text instructions"）。説明: "Provide a working concept, showing how the vulnerability can be exploited. This can be a simple walkthrough or a completely automated script. Markdown syntax is supported, use the View as Markdown control to preview your submission."
- Video Demonstration — 任意（必須印なし）、ファイル 1 つ。説明: "Attach a video demonstrating the exploit. The file will be uploaded securely when you submit this report, and will be deleted from our systems once triaged. Maximum file size: 250 MiB."
- Environment * — 説明: "Please provide all environment, setting, and configuration details used to replicate this vulnerability (i.e. versions of PHP, WordPress, and MySQL; special plugin settings, etc.)"
- Certification * — "Please certify that you have tested this Proof of Concept step-by-step, and that it works in the configuration/environment you have specified above?"
- AI use * — "Did you use AI to generate this report or find this vulnerability? Please note: we do not discourage using AI, however, we would like to know when it is being used."
- What AI tool(s) did you use to generate this report or discover this vulnerability? * — テキスト欄。2026-10-23 に所有者が提示したフォーム画面で、AI 利用の選択とは別の必須欄として確認した。同日の DOM では `form#submit-vulnerability textarea#pocAiToolsUsed` が見えるが、対応する `label` 要素はない。

### Other Details

- Have you requested a CVE from another CNA for this vulnerability? *
- Have you reported this to another vendor, other than the software vendor? *
- 同意 * — "I have read and agree to the Wordfence Bug Bounty Program Submission Release, Wordfence Bug Bounty Program Terms and Conditions, Wordfence Terms of Service, and acknowledge the Wordfence Privacy Policy and Notice at Collection."

## 報告書との対応（skill が守ること）

- Impact Statement は 200 字以内の 1 文。
- Proof of Concept は Markdown で、手順の本文をここに置く。動画は任意の別項目で 250 MiB まで。
- Environment には PHP / WordPress / MySQL の版と、有効にした設定を書く。
- AI 利用の Yes/No、CVE と他 vendor への報告の有無、同意は人間が答える。skill は下書きにその欄を空で用意する。AI tool(s) 欄は `OpenAI Codex and Claude Code` を初期テンプレートとし、人間が最終査読で実際の利用状況に合わせて修正する。

Vulnerability Type、Authentication Level Required、Common Weakness (CWE) Type の全選択肢は、[2026-10-23 の取得記録](../../../../docs/reviews/2026-10-23-wordfence-form-options.md)と[選択肢 JSON](../../../../docs/reviews/2026-10-23-wordfence-form-options.json)に置く。提出時には live form の選択肢と照合する。
