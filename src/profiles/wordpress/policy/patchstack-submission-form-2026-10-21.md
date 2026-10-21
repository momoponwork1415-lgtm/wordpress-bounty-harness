# Patchstack の報告フォームの項目（写し、2026-10-21）

所有者が 2026-10-21 に Patchstack の報告フォームから取った項目の写しである。残したのは項目名、選択の有無、説明文と上限だけで、値は写していない。報告書 skill（`wbh-report`、#439）が節をこの項目に対応付けるために読む。送信は所有者が自身の拡張機能で行う。

## 項目

### Submitter info

- Submitter name or alias
- Contact e-mail
- Website（任意）

### Submission info

- Component type — 選択（例: WordPress plugin）
- Affected component
- Component slug
- Component link
- Prefix — 選択（例: ≤ Less than or equal）
- Affected version(s)

### Vulnerability info

- Pre-requisite — 選択。説明: "The lowest possible user role needed to recreate the vulnerability. Reports for roles outside the Bug Bounty Program scope will not be accepted."
- OWASP 2021: Vulnerability class — 選択
- OWASP 2021: Vulnerability type — 選択
- Vulnerability description — Markdown、10,000 字まで
- How to reproduce — 説明: "Place the complete proof of concept and all steps to reproduce in this 'How to reproduce' textarea. Information provided only in attachments is not accepted." Markdown、50,000 字まで

### Additional

- Additional information（任意）— Markdown、50,000 字まで
- Upload or drop files（任意）— "You can attach up to 5 ZIP (.zip) files, with a combined size of up to 100 MB. Put supporting source code, component files, screenshots or videos inside the ZIP files."
- 同意 — "I have read the [Submission guidelines](https://patchstack.com/academy/general/submitting-a-report/) and accept the [Terms of services](https://patchstack.com/terms-and-conditions/) & [Privacy policy](https://patchstack.com/privacy-policy/)."

## 報告書との対応（skill が守ること）

- 再現手順の全文は How to reproduce に置く。添付だけに書いた情報は受け付けられない。
- 添付は ZIP 5 つまで、合計 100 MB まで。画面と録画は ZIP に入れる。
- Pre-requisite は Finding の攻撃者位置そのままにし、低く書かない。
