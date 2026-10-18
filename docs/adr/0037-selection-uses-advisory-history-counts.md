---
status: accepted
date: 2026-10-19
amends: 0030（公開履歴を選定で採点しない）, 0032（2026-10-16「選定の帯」の「score に件数を入れず gate に限る」、および `revisitPolicy: never`）
amended-by: 本文末尾の 2026-10-19 追記（公開統計による重みの確定、再訪規則、cascade）
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

`scoreWeights.history`、`scoreWeights.historyPayingClass`、`scoreWeights.recordRecency` を 0 にすれば mirror は開かれず、従来の順位に戻る。code を消すなら `src/profiles/wordpress/selection/advisory-history.ts`、`src/profiles/wordpress/wordfence-history/advisory-counts.ts`、`wordpress-selection.ts` の `historyScore` / `recordRecency` / `openAdvisoryHistory`、方針 file の `history*` 5 項目と `scoreWeights.recordRecency`、`tests/profiles/wordpress/wordfence-history-advisory-counts.test.ts` と `selection.test.ts` の ADR 0037 節を削除し、本 ADR を superseded にして ADR 0030 を戻す。

## 2026-10-19 追記: 公開統計による重みの確定

所有者の指示「選定については公開情報から統計を取ったほうがいい。それであなたに決めてもらう」に答えた報告 [docs/reviews/2026-10-19-selection-statistics.md](../reviews/2026-10-19-selection-statistics.md) を、委任を受けた AI session が読み、§5.1 の提案を全部採った。§5.4 の cascade の順（≥1M を先）だけは所有者が退け、所有者の順を使う（下の 4）。本 ADR の決定 1〜2 の式と既定の重み、および帰結に残していた `revisitPolicy` を次のとおり改める。採否の根拠は数字だけで、要素は足していない。

### 測った数字（報告から）

- 遡及予測。cutoff T1 ＝ 2026-04-14（窓 183 日）、T2 ＝ 2025-10-14（窓 365 日）。主要 outcome C ＝ paying class かつ CVSS `PR:N` / `PR:L` の公開記録が窓内に 1 件以上。
- 100k–1M 帯 396 件の C 率は 33.6% / 39.1%（全体 8.3% / 11.2%）。帯内で直近 365 日の paying class 記録 0 件 → 21.6%、1 件 → 46.4%、2 件以上 → **80.7% / 85.7%**。
- 提案 score（paying class ×1、最終記録の新しさ ×1、0.5 × log10(install)）の帯内 top-50 の C 精度は **82% / 86%**。現行（10 × log10(install) ＋ 5 × WordPress.org 更新鮮度）は **52% / 60%**。報酬 proxy 平均は 573 / 727 USD-proxy 対 295 / 366（約 1.9〜2.0 倍）。
- WordPress.org の `last_updated` 鮮度は lift 2.58 / 2.29 に見えるが、脆弱性公開に伴うパッチ版の公開が原因側にある **leak** なので採点に使わない。放置 plugin は `maximumUpdateAgeDays: 365` の適格条件で落とす（>365 日更新なしの C 率 0.3%）。
- 記録総数（`history`）は paying class 件数と重なり、帯内精度を上げない（80 対 82%）。paying class の上限を 2 にすると全体 top-50 が 80 → 56% に落ちる。
- 再訪: 帯内 plugin の outcome C 記録の同一 plugin 間隔は中央値 **42 日**（p25 14、p75 114）、≤90 日が 69.7%。所有者の有償 18 件のうち **5 件**は同じ plugin への版上昇後の再報告。
- ≥1M 帯（68 件）の C 率は 42.6% / 44.1%、平均報酬 499〜608 USD。期待値（C 率 × 平均報酬）は ≥1M ≈ 213、100k–1M ≈ 105、50k–100k ≈ 25（T1）。

### 決定の改訂

1. **score の形。** `history = scoreWeights.history × min(count, historyCountCap) / historyCountCap`（決定 1 の `0.1 × freshness` を外した。新しさは次項が持つ）。`historyPayingClass = scoreWeights.historyPayingClass × min(payingClassCount, historyPayingClassCap)`（決定 2 の `/ historyCountCap` を外し、1 件 1 点、上限 `historyPayingClassCap` 既定 3）。新設 `recordRecency = scoreWeights.recordRecency × max(0, 1 − 最終記録からの日数 / historyWindowDays)`（最終記録は窓内の最新の非 informational 記録、基準は mirror の asOf）。3 項のどれかが正なら mirror を開く。全部 0 なら従来どおり開かない。
2. **既定の重み（`selection.json`、id `wordpress-selection-2026-10-22`、50000 / 30000 の兄弟も同じ日付）。** `installations: 0.5`（× log10(1 + install)、200,000 で 2.65）、`recency: 0`、`history: 0`、`historyPayingClass: 1`、`recordRecency: 1`、`historyPayingClassCap: 3`、`historyWindowDays: 365`、`maximumHistoryAgeDays: 2`、`maximumTargets: 5`、`maximumUpdateAgeDays: 365`。帯（100k–1M）、paying class の一覧、`popularPages: 10`、タグは変えない。帯内の値域は 0–3 ＋ 0–1 ＋ 2.5–3.0 で、paying class 件数が順位を決め、新しさが同点を割り、install が最後に効く。
3. **再訪。** `revisitPolicy: never`（ADR 0032、OPERATIONS）は、本 ADR 帰結の「別の所有者決定に委ねる」を本追記で引き取り、`{ "kind": "version-increased", "minimumDaysSinceTrial": 90 }` に置き換える。WordPress.org の現行 stable 版が台帳に数えた同 slug の全 Trial の版より高く、かつ最後の Trial 開始から 90 日以上経っていれば戻す。未公開 Finding を持つ slug は戻さない（従来どおり）。旧世代の `legacy-started` / `legacy-ambiguous` は変えない。`campaign run` が自動方針に `never` を要求していた guard は消した。再訪は選定の結果であり、campaign 単位の承認ではない。
4. **下限の cascade。** 主帯 100k–1M の候補が `--minimum`（runner は 1）に満たないときだけ、方針の `cascade` 配列を順に試す: 50k → 30k → ≥1M かつ paying class 記録 ≥2（最後）。所有者が 2026-10-18 に示した順のままである。報告 §5.4 は期待値（C 率 × 平均報酬。≥1M ≈ 213 対 50k–100k ≈ 25）で ≥1M を先に置くことを提案し、レビューした session もいったんそれを採ったが、所有者が退けた。C 率は他の研究者が公開した記録の出現率であり、この Harness の Trial あたりの的中率ではない。所有者の有償 18 件はすべて install 10k–400k の plugin で ≥1M は 0 件、Harness の ≥1M での Trial も 0 件なので、帯ごとの収率（`cascadeStep` 別の scope 内 Finding / Trial）を測るまで所有者の順を使う。各段は主方針に段の値を重ねたもので（方針 digest は主方針の 1 つ）、`excludedAuthors` は ≥1M でも効く。選定レポートと `target-selected` に `cascadeStep` を残し、帯ごとの収率はそこから読む（OPERATIONS 第 1 節）。下限だけ違う兄弟 file `selection.50000.json` / `selection.30000.json` と runner の `missing-floor-policy` 停止は、読む code が無くなるので削除する。OPERATIONS 第 1 節「install 下限は runner が無人で変えない」は本項に置き換える。

### 採らなかったもの

- 記録者数（最強の単独特徴、lift 8.95 / 6.72）: paying class 件数とほぼ同じ plugin を指し（T1 で 4+ の 216 件中 194 件が paying ≥1）、匿名化しても記録者を数える code を置く理由が無い。
- 高額 class の二重計上、記録総数の加点: 帯内精度を上げない（§4.5）。
- 方針 tag、`requires_plugins`、plugin 年齢: lift 0.8〜1.1 で信号にならない（§4.4）。

### 再計測

2027-04 に cutoff 2026-10-14、窓 183 日で `scripts/analysis/selection-statistics.py` を回し、帯 top-50 精度が 70% を下回れば重みを見直す。本番台帳の受理率との関係は引き続き測る。
