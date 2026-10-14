# #229 硬い総利用枠の実装可能性（決定待ち）

2026-10-14。`d75fcc5` を基準に、総利用枠を 1 Trial の途中でも超えない保証が現行契約で作れるか調べた。これは調査記録であり、SPEC・ADR・#229 の仕様決定ではない。

## 結論

現行の ledger の usage を Trial 開始前に合計するだけでは、硬い token 上限は保証できない。usage は実行後に得る provider 報告で、欠損も許される。並列 Trial の未精算分も含む原子的な予約がない。broker の上限は request 件数と request / response の byte 数であり、provider が消費した input・output・reasoning token の上限ではない。従って、現行コードへ `totalTokenCap` を足して「超過前に止まる」と表示することはしない。

所有者の既定希望は、停止要求または provider quota 到達までの継続運転である。任意の硬い総利用枠を設けるとしても、既定で必須の停止値にはしない。SPEC §14 の「金額や日付で区切る上限を持たず、購読の使用量を観測する」は金額・日付上限の方針であり、token 件数上限の採否と単位は明示していない。#229 の「設定された硬い総利用枠」との整合、上限の単位・対象・変更手順は未決とする。

## 根拠

| 項目 | 現行の契約・観測 | 硬い上限に足りないもの |
| --- | --- | --- |
| campaign 設定 | `src/cli/wordpress.ts` の `commonCampaignFields` は wall とメモリ・同時数を持つ（156–187 行）。総 token / 費用上限はない。 | 上限単位・適用範囲・未設定時の扱いの仕様。 |
| broker grant | `src/discovery/codex-native-agent-runtime.ts` 1231–1248 行は協調 Trial に最大 1,600 request、request 8 MiB、response 8 MiB を設定する。`src/discovery/provider-credential-egress-broker.ts` 47–67 行の grant もこの 3 種を検査する。 | 単一 request が消費してよい token の provider 保証付き上界。 |
| broker 転送 | `src/discovery/provider-credential-proxy.ts` 306–369 行は JSON の `model`、request 数と byte、期限を検査して転送する。応答は byte 制限付きで stream し、provider の usage を予算として予約・精算しない。 | request 前の予約と、response / error を含む信頼できる usage 計数。byte 数から reasoning token の上界は導けない。 |
| receipt / ledger | `src/discovery/codex-native-agent-runtime.ts` 624–669 行は CLI transcript / rollout の token 値を事後抽出し、欠損時は `unavailable`。`src/ledger/index.ts` 190–198 行も欠損を許し、`usage()` は欠損件数を別計上する（944–1009 行）。`src/discovery/campaign.ts` 617–635 行の `costUsd` は `unavailable`。 | 実行中の確定値、欠損時の精算規則、provider / account をまたぐ集計境界。 |
| 並列 | `src/cli/wordpress.ts` 163–173 行は同時 target / run を設定できる。host resource claim は slot を占有するが token 予算は予約しない。 | 複数 campaign・session・provider grant に共通の原子的な残枠台帳。 |

broker が response byte 上限を超えた場合でも、provider は既にその応答を生成して課金・quota 計上し得る。切断後の受信 byte 数を消費 token の証明に使わない。CLI の最終 receipt は探索 Root・子・Verifier の全 provider 呼び出しを、硬い総枠のリアルタイム精算値として保証する契約ではない。

## 実装前に決めること

1. **単位と範囲。** Harness 内の provider 合計 input + output token、provider ごとの token、または課金額のどれを上限にするか。cached input と reasoning output をどう数えるか。購読の外部利用や他アプリの消費まで含める保証は、Harness 単独では作れない。API 料金額を選ぶなら provider の価格・請求契約も別途必要。
2. **設定の位置。** 任意設定とし、未設定なら現在どおり operator stop / provider quota まで続ける。設定後に枠へ到達した時の状態、増枠を認めるなら誰がどの版を承認して journal の digest pin を更新するかを決める。
3. **上界の根拠。** provider が全出力（非表示の reasoning を含む）の上限を受理・強制する parameter と、全入力種別について送信前に計算できる上界を確認する。モデル・endpoint・provider ごとに根拠を固定する。証明できない request は硬い cap モードで開始しない。

## 硬い token 上限を採用する場合の必要契約

1. host 共通の予算所有者を置き、`budgetId`、provider key、認証 account の匿名化した識別子、上限、確定使用量、未精算予約量、revision を保持する。同じ account / 枠を使う全 campaign・session・Verifier が同じ所有者を参照する。parent の設定 digest と account identity を照合し、account 変更を自動継続しない。
2. broker が各 provider request を転送する**前**に、認証 account と request に結び付く最悪消費 token を原子的に予約する。`確定使用量 + 既予約量 + 新予約上界 <= 上限` を満たさなければ転送せず、provider quota と区別した `budget-limit` を返す。並列 broker は同じ transaction / CAS に入る。grant の request 数・byte 数・wall 制限は別の安全策として残す。
3. broker は provider が保証する token 上界の parameter を request に強制し、テキスト・画像・tool 入力なども含めた input 上界を検証する。上界の根拠がない provider / request には hard cap の保証を付けない。response の usage が信頼できて reservation 内なら差分を戻す。usage 欠損、途中切断、timeout、broker crash、provider 側の結果不明では予約を戻さず、照合できるまで追加 request を止める。
4. grant receipt と ledger には、raw credential や payload を入れず、`budgetId`、provider、account 識別子の digest、予約・精算の参照、typed な停止理由のみを残す。Private Evidence へ具体的な診断を置く。provider の `rate-limit` / `quota`、broker の既存 request cap、operator stop、hard budget 到達は別々に分類する。
5. Trial 途中の budget 到達は `incomplete` として既存の Finding / Lead と証拠を保持し、開始済み Trial を再投入しない。parent は自動で新規 Trial を起動しない。残額がゼロでも Finding の検証に provider を使うなら、検証の request も同じ予約対象にする。上限変更・再開は明示的な版付き操作が定義されるまで保留する。

## 必須の検証

- 同時 2 campaign / 複数 Root・子・Verifier が同じ枠を要求しても、予約合計が上限を越えず、越える request は upstream に到達しない。
- provider usage の欠損、response stream 切断、broker crash、ledger append 失敗、account 変更で予約を解放せず保留する。process 再起動後も同じ結果になる。
- provider quota、broker request cap、budget cap、cyber policy が別の停止理由になり、どれも候補 0 件の正常完了にならない。
- budget 到達後、進行中 Trial の成果と child の証拠を保存し、新しい Trial は開始しない。同じ slug の独立 Trial が自動で増えない。
- モデル・endpoint ごとに、強制した入出力上界が provider の実消費 token を包含することを実運転で測る。保証が確立できない経路は fail closed にする。

この契約と仕様判断が揃うまでは #229 の硬い総利用枠は**未実装**と記録する。事後の usage 合計に達したら次 batch を止める「軟らかい目安」は別機能としては可能だが、同じ名前や保証で提供しない。
