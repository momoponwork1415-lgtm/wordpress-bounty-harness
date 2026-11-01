---
status: accepted
date: 2026-10-19
amends: 0030（公開履歴を選定で採点しない）, 0032（2026-10-16「選定の帯」の「score に件数を入れず gate に限る」、および `revisitPolicy: never`）
amended-by: 本文末尾の 2026-10-19 追記（公開統計による重みの確定、再訪規則、cascade）, PR #383（`maximumHistoryAgeDays` の一時値 14）
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

## 2026-10-19 注記: 実物との対応（文書整理、所有者の委任で AI）

- 方針 id: 帰結の `wordpress-selection-2026-10-21`、追記 2 の `wordpress-selection-2026-10-22` の後、PR #382 で `wordpress-selection-2026-10-23` に上がった。50000 / 30000 の兄弟 file は追記 4 で削除したので、「兄弟も同じ日付」は削除前の記述。
- 「採らなかった選択肢」の「100 万超の例外自体は本 ADR の対象外で #295 に残る」: 追記 4 の cascade 最後の段で実装し、#295 は close。
- 鮮度 gate: 決定 3 と追記 2 の既定は 2 日のまま。mirror 更新が API の rate limit で通らない間の一時値として、PR #383 が `selection.json` を 14 日にした（所有者決定 2026-10-19「いったん 14 日のものでいい」）。日次更新（cron 19:10 UTC）が 1 回通ったら 2 に戻す（#385）。
- 帰結の「mirror の日次更新（#231）が前提」: #231 は close 済みで、更新は host の cron が旧環境の `refresh_wordfence.py` を回している（`docs/agents/production-monitoring.md` 第 2 節）。

## 2026-10-26 追記: active install は 50,000 以上に限る（所有者決定、AI が記録）

- 所有者が 2026-10-26 に「本番の選定は active install 50,000 以上の plugin に限る」と決めた。追記 4 の cascade から 30k の段を外し、50k → ≥1M かつ paying class 記録 ≥2 の 2 段にした。≥1M の段は残す。主帯（100k–1M）、50k の段、段の順は変えない。
- 方針 id を `wordpress-selection-2026-10-26` に上げた。方針 digest が変わるので、旧 id に束縛済みの batch は再開できず、batch の境界で切り替える（帰結の方針 id の項と同じ）。
- 追記 4 と OPERATIONS 第 1 節の「50k → 30k → ≥1M」は、この追記で 50k → ≥1M に読み替える。追記 4 の本文は履歴として直さない。`cascadeStep` は 1 始まりのまま、≥1M の段は 3 から 2 になる。過去の `target-selected` の `cascadeStep: 3` は 30k の段を含む方針で選ばれたもので、読み続ける。
- 参照: #533。

## 2026-10-27 追記: freeze の後にも cascade を進める（#623）

2026-10-26 に両 runner が `sleeping reason=empty` で 24 時間止まった。主帯の適格候補が 1 件だけで、その版の archive が凍結で拒否され（`invalid-archive`）、対象 0 件になった。cascade の判定は凍結前の適格数で行っていたので、50k の帯は試されなかった。直し方は 2 つで、どちらも判断を含まない。

- `select` は、ある帯の凍結が終わって対象が `minimum` 未満なら、次の cascade の帯を順に凍結する。凍結に失敗した候補は再試行しない。報告の `cascadeStep` と `cascade` は、実際に対象を出した帯まで並べる。
- `target-skipped`（stage `freeze`）の理由が `invalid-archive` なら、同じ試行で他の対象が凍結できたかに関係なく、その版を `freeze-deferred` として除外する。archive の拒否は host の都合ではなく版の性質だからである。`deferred` の扱いは変えない。


## 2026-10-28 追記: 選定をインストール数順の列にする（#533）

[所有者の最終決定](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/533#issuecomment-6464992081)で、本文の採点と鮮度 gate、追記の 90 日待ち・未提出 Finding・legacy 除外、cascade を上書きする。ADR 0030 のタグ・High Threat による順位と過去 Finding の除外、ADR 0032 の上限帯も本追記で閉じる。母集団を全件回せるため、履歴の採点をやめ、報酬額に関係するインストール数で順序を付ける。

- 母集団は popular browse と各タグの一覧から、インストール数 10,000 以上、365 日以内更新、`excludedAuthors` / `excludedSlugs` 外の対象とする。
- 順序はインストール数の降順、同じ段では更新日の降順とし、同点だけ slug で固定する。
- 同版の Trial は 1 回とし、台帳に数えた同 slug の全 Trial より版が上がれば待たずに戻す。
- `enumerate` は区画分配型の Trial として扱い、差し戻し・再開・`trace`・子を別の Trial に数えない。
- SPEC 第 6 節の Trial に数えない run と provider 上限の再開、別ランナーの予約と同版の凍結失敗の扱いは変えない。
- `legacy-history` のコード・設定・exporter と選定用ミラーローダーを削除し、既存の Git 外の履歴ファイル・台帳・Private Evidence は消さない。
- 新方針は `cascade`、`maximumActiveInstallations`、`scoreWeights`、履歴の window・cap・class・最大 age、`revisitPolicy.minimumDaysSinceTrial` を拒否する。
- 固定の `candidateSource.popularPages` / `pagesPerTag` / `maxCandidates` も外し、下限を割るか API 終端まで列挙して、上流上限や取得失敗による打切りを記録する。
- 選定レポートと `target-selection.json` に `reason: initial | version-increased` を残し、既存イベントの digest 参照から読む。
- 旧 `target-selection.json` の採点・履歴・帯の欄と既存台帳イベントは読み続ける。
- ミラーは `wbh-screen` と `wbh-dedupe` に残し、探索プロンプト・契約・Programme Boundary は変更しない。

切替時は新しい選定設定と、`legacyHistory` を外した host 設定のコピーを使う。方針 digest が変わるため、既存の予約バッチは従来の破棄記録を経て新しく選ぶ。稼働中の設定やランナーの切替は運用側で行う。消し方はこの変更の revert であり、記録済み artifact とイベントは残す。

## 2026-11-01 追記: 下限 5,000、タグ無し、1 バッチ 10 件

所有者の指示（2026-11-01「大量のプラグインを短時間で探索する。選定を狭めているものは外す」）で、`selection.json` を id `wordpress-selection-2026-11-01` に改めた。

- `minimumActiveInstallations` を 10,000 から 5,000 に下げた。WordPress.org の人気順を 99 ページ読んだ実測（2026-11-01）では、10,000 以上が 2,160 本、5,000 以上が 3,222 本。Wordfence の 2026 年公開記録 9,690 件のうち、10,000 以上の帯にあるのは 39%、5,000〜10,000 の帯に 9% ある。人気順の 99 ページ限界（約 2,000 インストール）より下げるにはコード変更が要るので、まず 5,000 で回す。
- `candidateSource.tags` を空にした。人気順はインストール数の降順で全件を並べるので、下限以上の対象はタグ無しで全部拾える。8 タグが足した候補は 0 件だった。一覧が 9 本から 1 本に減るので、1 本の取得失敗で候補全体が空になる規則の当たる面も減る。
- `maximumTargets` を 5 から schema 上限の 10 にした。runner は batch が終わるまで次の選定をしないので、batch を大きくして選定の往復を減らす（OPERATIONS 第 2 節の枠の使用率の試算も 10 が最も高い）。
- 順序（インストール数の降順）、再訪（版上昇のみ）、更新の古さ（365 日）、作者の除外は変えない。帯ごとの「2026 年に記録が 1 件以上あった plugin の割合」は 100 万以上 64%、10 万〜100 万 60%、5 万〜10 万 52%、1 万〜5 万 38%、5 千〜1 万 27% で、インストール順は記録の出やすさの順でもあった。

## 2026-11-01 追記 2: 更新の古さを 180 日に縮める。順序は変えない

所有者の確認（2026-11-01「ok」）で、`selection.json` を id `wordpress-selection-2026-11-01-180d` に改め、`maximumUpdateAgeDays` を 365 から 180 にした。母集団は人気順一覧でインストール 5,000 以上の 3,222 本、記録は Wordfence mirror の 2026 年公開分 4,895 件（docs/reviews/2026-11-01-selection-policy-proposal.md）。

- 最終更新 181〜365 日の plugin は 233 本（母集団の 7%）で、2026 年に記録ありは 18%、記録の 1%（61 件）。365 日超は 535 本で 4%、25 件。180 日で切ると、Trial の 7% を記録の 1% にしか当たらない帯から外せる。
- 180 日超の帯は、その間にパッチ版が出ていないので、更新日と記録の間の leak（下記）の影響を受けにくい。切る側の数字としては使える。

**順序は変えない。** 提案では未探索の並びを「最終更新の新しい順」にする案を出した（30 日以内更新の 1,345 本に記録の 81%）。しかし本 ADR の 2026-10-22 節が書いたとおり、WordPress.org の `last_updated` の新しさは、脆弱性の公開に先立つパッチ版の公開が原因側にある leak で、「新しく更新された plugin に未発見の脆弱性が多い」ことの証拠にならない。今の mirror には過去時点の `last_updated` が無く、cutoff を切った clean な検証ができない。並びはインストール数の降順のまま置く。インストール帯ごとの記録ありの率（≥1M 64%、100k〜1M 60%、50k〜100k 52%、10k〜50k 38%、5k〜10k 27%）は leak の影響を受けない。

同じく提案に入れた WordPress.org 名義（gutenberg、classic-editor など 18 本）と WordPress Performance Team（10 本）の除外は、HackerOne の WordPress programme の対象範囲が確認できるまで入れない。確認できた時点で `excludedAuthors` に足す。

消し方: `maximumUpdateAgeDays` を 365 に戻し、id を改める。台帳の `target-selected` は方針 digest を持つので、どちらの方針で選ばれたかは読み分けられる。

## 2026-11-01 追記 3: 順序を stable 版の公開日の新しい順にする（所有者決定）

所有者は 2026-11-01 夜、選定の詳細仕様の確認で「本当にバージョンアップしたばかりのものを狙うのではだめか」と問い、AI の推奨（公開日順に切り替える）に「すべて推奨で」と答えた。追記 2 の「順序は変えない」をこの追記で上書きする。

- `selection.json` に `ordering: "version-published"` を足し、id を `wordpress-selection-2026-11-01-version-published` にする。順序は stable 版の公開日（WordPress.org の `last_updated`）の新しい順、同日はインストール数の降順、同点は slug。鍵を省くと従来の `installs`（インストール数の降順、同数は公開日の新しい順）で、過去の方針と開発用方針はそのまま読める。
- 母集団（インストール 5,000 以上、180 日以内更新、作者の除外）、1 batch 10 件、版上昇の再訪、同版 1 Trial は変えない。版上昇で戻った対象は公開日が新しいので、この順序では列の先頭に来る。
- 理由は重複である。Wordfence の却下 40 件（2026-10-31 の分類）のうち 29 件が「同じ plugin の同じ版を他の研究者が先に出した」だった。新版が出た直後に読めば、先に出せる確率が上がる。母集団を全件回す方式では、順序はいつ読むかを決めるだけで、集合は変わらない。
- 2026-10-22 節の leak（`last_updated` の新しさは脆弱性の公開に先立つパッチ版の公開が原因側にある）は、過去の記録で「新しい更新に脆弱性が多い」と測ることへの注意であり、本番で新版を先に読む順序を禁じるものではない。公開日順の方が記録の出やすい plugin に当たるとは主張しない。採否は ADR 0045 の分母（Codex 1 時間あたりの Lab 発火数、Wordfence の結果と重複率）で、再開後 2 週間の数字を install 順の時期（v18、v19）と比べて決める。対にはならない。
- Harness に足したのは比較関数の切替だけで、判断は方針 file（人間が所有）にある。

消し方: `selection.json` から `ordering` を外して id を戻す。schema の鍵と比較関数は、過去の方針 digest を読めるように残してよい。

## 2026-11-01 追記 4: インストール数の帯を先に、帯の中は公開日順（所有者決定）

所有者は追記 3 の直後、「インストール数 100 万以上のような多いものを優先しないか」と問い、AI の推奨（帯を先に、帯の中は公開日順）に「帯優先で切り替えて」と答えた。追記 3 の `version-published` はこの追記で `install-band-then-published` に置き換える。

- `selection.json` に `ordering: "install-band-then-published"` と `orderingBands: [1000000, 100000, 10000]` を置き、id を `wordpress-selection-2026-11-01-install-band` にする。順序は帯（100 万以上 → 10 万以上 → 1 万以上 → それ未満）の高い方を先に、帯の中では stable 版の公開日の新しい順、同日はインストール数の降順、同点は slug。
- 根拠は 2 つ。Wordfence の報酬額はインストール数の帯で決まる。帯ごとに記録を持つ plugin の割合は ≥1M 64%、100k〜1M 60%、50k〜100k 52%、10k〜50k 38%、5k〜10k 27% で単調。
- 公開日順を帯の中に残す理由は追記 3 のまま（却下 40 件中 29 件が重複）。100 万以上の plugin は数十本で版を頻繁に上げるので、この順序では新版が出るたびに列の先頭へ戻る。
- 履歴の件数は選定に戻さない（2026-10-31 の決定のまま）。2025 年以降に記録が最も多い plugin は 100 万未満の中型（user-registration、tutor、learnpress、forminator、give、latepoint など）なので、帯だけで絞らず、下の帯も順に回す。
- 母集団、1 batch 10 件、版上昇の再訪、同版 1 Trial は変えない。`version-published` と `installs` の値は残し、過去の方針 digest を読めるままにする。

消し方: `selection.json` の `ordering` を `version-published` に戻して `orderingBands` を外す。

## 2026-11-01 追記 5: deferred の凍結失敗は 7 日で再試行する（#771）

帯優先の最初の選定で、≥1M 帯の 6 件（wpforms-lite、wp-mail-smtp、all-in-one-seo-pack、worker、seo-by-rank-math、complianz-gdpr）が `freeze-deferred` のまま残った。#734 の修正前に `main-plugin-file-ambiguous` で deferred になった記録が台帳にあり、追記（#623）の規則はその版を版が上がるまで除外するので、Harness を直しても再試行されなかった。

- `target-skipped`（stage `freeze`、reason `deferred`）による除外は、skip の `occurredAt` から 7 日の間だけとする。過ぎたら候補に戻り、再び deferred になれば、また 7 日除外される。deferred は Harness 側の都合（ヘッダの読み方、source の取得）で起きることがあり、修正を待って自然に戻る出口が要る。
- `invalid-archive` は版の性質なので、従来どおり版が上がるまで除外する。
- 再試行の費用は freeze 1 回分で、#623 の「batch ごとに同じ候補を試す」には戻らない。期限は定数 `FREEZE_DEFERRAL_RETRY_DAYS` で、消せば追記（#623）の規則に戻る。

