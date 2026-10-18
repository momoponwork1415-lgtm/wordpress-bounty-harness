---
status: accepted
date: 2026-10-19
amends: 0030（公開履歴を選定で採点しない）, 0032（2026-10-16「選定の帯」の「score に件数を入れず gate に限る」）
---

# 対象選定は公開履歴の件数と公開日を採点に使う（#295）

## 背景

[ADR 0030](0030-public-history-is-neutral-in-target-selection.md) は「公開履歴の件数・内容は選定候補の列挙・除外・採点に使わない」と決め、根拠を「件数が未発見の経路や重複の確率を示すという実測がこのリポジトリに無い」こととした。[ADR 0032](0032-owner-decisions-on-constraints-2026-10-13.md) の 2026-10-16 節はこれを plugin 単位の規則として維持し、100 万インストール超の例外についてだけ「件数は gate に使い、score と探索には渡さない」とした。

所有者は 2026-10-19 に Claude の委任セッションへ口頭で「選定履歴を見て選ぶ必要がある」と決めた。所有者自身が 2026-10-18 に置いた「報奨が出るまで選定・探索の新しい仕組みを足さない」（[docs/reviews/2026-10-18-operating-policy-gap-report.md](../reviews/2026-10-18-operating-policy-gap-report.md)、DEVELOPMENT §2 の「選定方針の構造は凍結」）に対する、所有者本人による例外である。本 ADR はその 2 点（ADR 0030 の上書きと 2026-10-18 凍結の例外）を記録する。

## 測った根拠

ローカル Wordfence Intelligence mirror（2026-10-14 時点、42,211 記録）で、ADR 0030 が無いと言った実測を取った。

- 直近 365 日に公開された plugin 記録 10,616 件のうち 70.4% は、その plugin に既にそれより前の記録があるものだった。
- 続報記録の 57.3% は、同じ plugin の以前の記録と CWE を共有していた。
- 所有者自身の Wordfence 提出履歴（2026-03〜2026-09 の 21 報告、集計値のみ、金額は書かない）: 報告した 21 plugin の全部に、報告より前の公開記録が mirror にあった。21 件中 20 件は報告前 365 日以内に記録があり、18 件は報告前 365 日以内に報奨対象 class（Stored XSS、SQL Injection、権限昇格、認証回避、任意ファイル upload、RCE）の記録があった。母集団: 記録を 1 件以上持つ plugin は 16,397、2026-03-01 の前 1 年に記録を持つ plugin は 5,886。

公開履歴の有無は「報奨になった対象」を母集団よりはるかに強く選り分けており、ADR 0030 の前提は崩れた。

## 決定

1. **件数と公開日だけを採点する。** 候補 slug ごとに、mirror の `last_successful_at`（asOf）から `historyWindowDays`（既定 365）前までに公開された非 informational の plugin 記録の件数 `count` と、その中で最新の公開日 `latestPublished` を取る。score の `history` 成分は `scoreWeights.history × (min(count, historyCountCap) / historyCountCap + 0.1 × freshness)`、freshness は最新記録が asOf にあれば 1、window の端で 0。基準は mirror の asOf であり壁時計ではないので、同じ mirror からは同じ score が出る。既定の重みは 5（installations 10、recency 5 と並ぶ。所有者が方針 file で変える）。重み 0 または欠落は mirror を開かず、従来の順位を厳密に再現する。
2. **報奨対象 class の件数を別の重みで持つ。** 同じ window の記録のうち、`signals` の class 名（primitive または terminal kind）が `historyPayingClasses`（既定: stored-xss、sql-injection、privilege-escalation、authentication-bypass、arbitrary-file-upload、remote-code-execution）に入るものの件数 `payingClassCount` を取り、`scoreWeights.historyPayingClass × min(payingClassCount, historyCountCap) / historyCountCap` を加える。既定の重みは 0 なので、所有者が有効にするまで 1 の挙動は変わらない。
3. **鮮度の gate。** mirror の `last_successful_at` が `maximumHistoryAgeDays`（既定 2）より古い、state と DB が食い違う、state が読めない、または host に mirror が無いのに方針が history を重み付けしているとき、`select` は候補を 1 件も観測せずに理由付きで止まる。部分的な選定は返さない。Programme 写しの鮮度（35 日）と同じ止め方。更新の失敗 flag（`stale_fallback`、API の 429 などで立つ）だけでは止めず、data が age の内側なら開いて `lastRefreshFailed` を選定レポートに残す。age が規則で、flag は観測。
4. **記録するもの。** 選定レポートに mirror の `asOf`、`digest`（feed の `content_sha256`）、`recordCount`、`lastRefreshFailed`、window と cap と最大 age。`target-selection.json` に `advisoryHistory: { count, payingClassCount, latestPublished?, mirrorAsOf, mirrorDigest }`。台帳の `target-selected` event の形は変えない（artifact の digest 参照で届く）。
5. **使わないもの。** 記録の title、description、CVE id、CWE 名、個々の記録の signal 値、record JSON は選定 code が読まず、選定レポート・台帳・Private Evidence の選定記録にも書かない。mirror は探索に渡さない（不変条件 1、ADR 0012、ADR 0034 で catalog 生成を削除済み）。
6. **手動 `historySignals` / `historySource` の削除。** 旧方針の手書き件数は mirror の件数で置き換わるため schema から外す。使わない設定として残す中間状態は置かない（ADR 0034 と同じ方針）。それらを含む旧方針 file は parse で弾く。`history-stale` の候補単位の理由コードは一度も出たことがなく、gate が停止になったので union から外す。

## 採らなかった選択肢

- 件数を 100 万超の gate にだけ使う（ADR 0032 2026-10-16 節）: 所有者の 2026-10-19 決定は帯の中の順位にも履歴を使うことなので、score に入れる。100 万超の例外自体は本 ADR の対象外で #295 に残る。
- class × 権限（未認証 / Subscriber）で絞る: mirror の `signals` に権限の列が無く、record JSON の CVSS vector を読むことになる。記録内容を読まない線を越えるので、class 名の件数だけに留める。
- 探索へ履歴を渡す: ADR 0034 で削除した経路の復活になる。選定にだけ使う。
- `revisitPolicy` を変える: 下の帰結に書く。別の所有者決定にする。

## 帰結

- 本番の順位は変わる。方針 id を `wordpress-selection-2026-10-21`（50000 / 30000 の兄弟も同じ日付）に上げ、digest が変わるので束縛済み batch は再開できず、batch の境界で切り替える。
- mirror の日次更新（#231）が前提になる。更新が 2 日止まると選定が止まり、runner は `select` の例外を連続 error として数える。更新の実装は本 PR に含めない。
- `revisitPolicy: never`（ADR 0032 Q、OPERATIONS）は観測と食い違う。所有者の有償 18 件のうち 5 件は、同じ plugin の新版に対する再報告だった（TranslatePress ×3、Unlimited Elements ×2）。版が上がった対象を戻すかどうかは本 ADR では変えず、別の所有者決定に委ねる。
- ADR 0030 は本 ADR で上書きされ、SPEC §3・§8、OPERATIONS、`policy/selection.md` の該当行を改めた。履歴と受理率の関係は本番台帳から引き続き測り、重みは数字で変える。

## 消し方

`scoreWeights.history` と `scoreWeights.historyPayingClass` を 0 にすれば mirror は開かれず、従来の順位に戻る。code を消すなら `src/profiles/wordpress/selection/advisory-history.ts`、`src/profiles/wordpress/wordfence-history/advisory-counts.ts`、`wordpress-selection.ts` の `historyScore` / `openAdvisoryHistory`、方針 file の `history*` 4 項目、`tests/profiles/wordpress/wordfence-history-advisory-counts.test.ts` と `selection.test.ts` の ADR 0037 節を削除し、本 ADR を superseded にして ADR 0030 を戻す。
