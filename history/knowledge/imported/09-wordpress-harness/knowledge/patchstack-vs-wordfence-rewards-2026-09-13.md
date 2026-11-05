<!-- provenance: /home/dev/wordpress-harness/docs/knowledge/patchstack-vs-wordfence-rewards-2026-09-13.md, mtime 2026-09-19, imported 2026-10-13, generation 09-wordpress-harness -->

# 調査資料: PatchstackとWordfenceの報奨比較

状態: 一次資料に基づく調査、2026-09-13
取得日: 2026-09-13

## 結論

収益の予測可能性を優先するなら、基本ルートは **Wordfence** がよい。Wordfenceは有効なFindingごとに直接ドル建てで払い、Patchstackの通常報告は月間AXPシェアに依存するため、同じ有効報告でも競合研究者の成績と自分の順位で入金額が変わる。

ただし、次は **Patchstack** を選ぶ。

- 対象がPatchstack Active VDPで、特にWordfenceでは対象外のCSRF等を扱うとき。
- デフォルト設定・追加操作なしで完全侵害でき、Patchstack Zerodayの全条件を満たすとき。
- 月内に高AXPのFindingを複数まとめ、TOP20+2圏内を狙うとき。

同一Findingの両方への提出はしない。Wordfenceは同社だけへの提出を報酬条件とし、Patchstackも公開前の第三者共有を禁じ、mVDPでは第三者への報告・販売を強く禁じている（[Wordfence Terms §1.1.4–5](https://www.wordfence.com/bug-bounty-program-terms/)、[Patchstack rules §§6.7, 15.4](https://patchstack.com/articles/bug-bounty-guidelines-rules/)）。

## 報酬モデル

| 観点 | Wordfence | Patchstack |
| --- | --- | --- |
| 通常報告 | Findingごとのドル建て報酬。最低報酬は$5。公表された単純な計算式はなく、脆弱性rank、install数、悪用可能性、影響、前提条件、ユーザー操作等を内部評価する（[Reward schedule](https://www.wordfence.com/threat-intel/bug-bounty-program/payouts)）。 | CVSSを起点にinstall・必要権限・種類・penaltyでAXPを算出し、最低$10,000の月間poolを月間AXP寄与率と棄却率で配分する（[rules §§10–14, 18](https://patchstack.com/articles/bug-bounty-guidelines-rules/)）。 |
| 高影響報告 | 通常と同じper-finding型。標準研究者は最大$31,200、1337 tierは最大$32,760と表示されるが、estimatorも保証額ではない（[program](https://www.wordfence.com/threat-intel/bug-bounty-program/)）。 | Zerodayだけはper-finding固定表。50K unauth=$1,400、100K=$2,600、500K=$4,900、1M=$7,200。ただし完全侵害、backdoor実行、デフォルト設定、前提・他ユーザー操作なし等をすべて満たす必要があり、ZerodayにはAXPが付かない（[rules §22](https://patchstack.com/articles/bug-bounty-guidelines-rules/)）。 |
| 月間bonus | 有効5件=$35、10件=$75、20件=$200、30件=$300、条件付き40/50/60件=$600/$1,000/$1,200。最高tierのみで非累積（[Reward schedule](https://www.wordfence.com/threat-intel/bug-bounty-program/payouts)）。 | 通常報告そのものが月間競争。Active VDP対象は現行leaderboard上で+15% AXPと表示される（[September 2026 leaderboard](https://patchstack.com/database/leaderboard/)）。 |
| 入金 | PayPalのみ。1日と15日にまとめて処理。公表ページで別のcash-out最低額は確認できず、最低bountyは$5（[program FAQ](https://www.wordfence.com/threat-intel/bug-bounty-program/)、[Reward schedule](https://www.wordfence.com/threat-intel/bug-bounty-program/payouts)）。 | PayPalは$50以上、銀行振込は$500以上。$50未満は最大6か月繰越。invoice必須で、最終結果発表後にinvoiceを出してから30日で処理（[rules §§18.5, 24–25](https://patchstack.com/articles/bug-bounty-guidelines-rules/)）。 |

### Patchstack AXP係数

- Install: 1K `x0.5`、5K `x0.75`、10K `x1`、25K `x2`、50K `x3`、100K `x4`、200K `x5`、400K `x6`、800K `x7`、1.6M `x8`、3.2M `x9`、5M `x10`。
- 権限: unauth `x2`、Subscriber/Customer `x1`。ContributorはmVDPのみ `x0.75`。
- 種類: RCE・任意upload/deletion・Admin昇格 `x3`、SQLi/deserialization `x2`、download・非Admin昇格 `x1.5`、POI/LFI `x1`、CSRF `x0.25`。
- `UI:R`はさらに`x0.5`。一方、CSRFが別種の脆弱性に至る場合は高い係数を使う、と§14.2にはある。

出典: [Patchstack rules §§12–14](https://patchstack.com/articles/bug-bounty-guidelines-rules/)。Active VDPの+15%はrules本文に見当たらず、現行leaderboard表示を根拠とする。

Wordfenceには対応する公開係数表がない。公開されているbonusは、active exploitation `+15%`、chain `+15%`、new technique `+10%`、十分な資料と容易なPoC `+10%`、1337 researcher `+5%`等である（[Reward schedule](https://www.wordfence.com/threat-intel/bug-bounty-program/payouts)）。

## 対象範囲と発見事項別の報告先

### 未認証SQLi

**Wordfenceを第一候補**にする。

Wordfenceではunauth/SubscriberのSQLiとstored XSSは500 installs以上で全研究者の対象で、Findingごとに直接報酬が出る（[program scope](https://www.wordfence.com/threat-intel/bug-bounty-program/)）。2026年の公式実績では、400K installs・unauth・CVSS 7.5のSQLiに$800、1M installsのunauth SQLiに$1,067が支払われている（[Ally case](https://www.wordfence.com/blog/2026/03/400000-wordpress-sites-affected-by-unauthenticated-sql-injection-vulnerability-in-ally-wordpress-plugin/)、[Avada case](https://www.wordfence.com/blog/2026/05/1000000-wordpress-sites-affected-by-arbitrary-file-read-and-sql-injection-vulnerabilities-in-avada-builder-wordpress-plugin/)）。実績額は別Findingの保証ではない。

PatchstackではSQLiは`x2`で高AXPになるが、通常のDB読取SQLiは「backdoorをuploadしてaccessできる完全侵害」というZeroday要件を通常満たさず、収益は月間順位依存になる。従ってProduct Filter by WBWのような50K級unauth SQLiは、重複・scope確認後、収益面ではWordfenceへ出す方が合理的である。

### 未認証RCE・任意PHPアップロード

**両方を提出前に見積もり、Findingごとに一方を選ぶ**。

- Patchstack Zerodayの全条件を満たすなら固定額が事前に分かる。
- 設定、短い有効期間、ユーザー操作などがありPatchstack Zerodayから外れるなら、Wordfenceのper-finding報酬が有利になりやすい。Wordfenceはこれらの前提をbounty評価要素にはするが、通常の安全な設定変更まで一律にZeroday同様の「前提なし」とは要求していない（[Reward schedule](https://www.wordfence.com/threat-intel/bug-bounty-program/payouts)）。
- Wordfenceの2026年公式実績には、50K installsのunauth PHP upload/RCEに$2,145がある（[Ninja Forms File Upload case](https://www.wordfence.com/blog/2026/04/50000-wordpress-sites-affected-by-arbitrary-file-upload-vulnerability-in-ninja-forms-file-upload-wordpress-plugin/)）。一方、100K unauth RCEには$4,290の実績があるが2025年提出であり、現行Findingへの保証には使えない（[ACF Extended case](https://www.wordfence.com/blog/2025/12/100000-wordpress-sites-affected-by-remote-code-execution-vulnerability-in-advanced-custom-fields-extended-wordpress-plugin/)）。

### CSRF・管理者操作が必要な発見事項

**この二択ではPatchstack**。ただし高収益カテゴリとはみなさない。

Wordfenceの現行scopeはCSRFを明示的にout of scopeとしている（[program scope](https://www.wordfence.com/threat-intel/bug-bounty-program/)）。PatchstackはCSRFがfile operation、権限昇格、working-PoC付きRCE、広い侵害につながる設定変更に至る場合だけ受け付けるが、multi-step CSRFは除外する（[Patchstack rules §4.7](https://patchstack.com/articles/bug-bounty-guidelines-rules/)）。CSRF基本係数`x0.25`と`UI:R x0.5`により、受理されても低AXPになりやすい。§14.2の「最終影響の高い係数」と実採点の一貫性は公開情報だけでは保証できない。

## 適格性と品質上の減点

| 項目 | Wordfence | Patchstack |
| --- | --- | --- |
| 最低install | High Threat（RCE、PHP upload/read/deletion、Admin昇格等）は25。SQLi/stored XSSは500。その他はStandard 50K、Resourceful 10K、1337 500（[scope](https://www.wordfence.com/threat-intel/bug-bounty-program/)）。 | 原則1K、最新版、最終更新3年以内。unauthまたはSubscriber/Customerのみ。mVDPには例外があるが、一般scope外のmVDP報告はAXP対象外の場合がある（[rules §3](https://patchstack.com/articles/bug-bounty-guidelines-rules/)）。 |
| 権限 | Admin/Editor等PR:HはCVEが出ても無報酬。Contributor/Author等も現行scope外（[Terms §1.2.7](https://www.wordfence.com/bug-bounty-program-terms/)、[scope](https://www.wordfence.com/threat-intel/bug-bounty-program/)）。 | Admin/Editor/Author等は不受理。ContributorはmVDPのみで、AXPが付かない場合がある（[rules §§3, 13](https://patchstack.com/articles/bug-bounty-guidelines-rules/)）。 |
| Duplicate | 最初の有効PoCだけが報酬対象。同一codebase、同一critical impact、近いpatch bypassは無報酬または減額（[Terms §1.2.9–14](https://www.wordfence.com/bug-bounty-program-terms/)）。 | 最初の有効報告だけ。後続はreject。公開済み不完全修正は原則newではなく、cross-program duplicate操作はpenalty対象になり得る（[rules §5, §9.2](https://patchstack.com/articles/bug-bounty-guidelines-rules/)）。 |
| 低品質報告 | 30日でAI hallucinationが2件超、または7日でfalse-positive/OOS/低品質が5件超など、段階的restriction・ban規定がある。pending上限もStandard 10件（[Terms §§1.2, 4](https://www.wordfence.com/bug-bounty-program-terms/)）。 | OOS・incomplete・false positiveの割合だけ月間報酬を減額。50%以上で1か月leaderboard除外/cooldown、67%以上で当月報酬とAXPがゼロ。不 tested・明白なrule違反・誤ったAI仮定は即1週間ban対象（[rules §6, §18.6](https://patchstack.com/articles/bug-bounty-guidelines-rules/)）。 |

Patchstack rulesはduplicateがrejection-rate分母・分子へ入るかを明記していない。後続duplicateは「rejected」とする一方、§18.6が減額対象として列挙するのはOOS、incomplete、false positiveだけなので、duplicateの当月penaltyは不明である。

## 現行ページ間の矛盾・曖昧さ

1. Patchstackの2026-09-01適用rulesは「月間AXP寄与率による$10,000最低pool」を定める。一方、現行leaderboardは今も「TOP20+2 monthly pool」と表示し、Active VDPの個別policyページには旧来の順位別$2,000/$1,400/...が残る（[rules §18](https://patchstack.com/articles/bug-bounty-guidelines-rules/)、[leaderboard](https://patchstack.com/database/leaderboard/)、[Active VDP example](https://patchstack.com/database/Wordpress/Plugin/media-library-assistant/security-policy)）。支払対象が全AXP保有者かTOP20+2のみかは公開ページだけでは解消できない。収益計画では保守的に「TOP20+2外は$0の可能性あり」と扱う。
2. WordfenceのReward schedule冒頭にはCSRFを例示する古い文言があるが、現行program scopeとbinding Termsの運用説明ではCSRFが明示的にout of scopeである（[Reward schedule](https://www.wordfence.com/threat-intel/bug-bounty-program/payouts)、[program scope](https://www.wordfence.com/threat-intel/bug-bounty-program/)、[Terms](https://www.wordfence.com/bug-bounty-program-terms/)）。提出判断にはscope/Termsを優先する。
3. Patchstackは§9.3で「他program報告済み」を申告してCVEなし掲載できるとする一方、§5.1はnew/uniqueを要求し、§15.4は公開前の第三者共有を禁じる。報酬 eligibility は明確でないため、二重提出の根拠にはしない。

## 実務ルーティング

1. 同じFindingを両方へ出さず、提出前にdestinationを固定する。
2. unauth SQLi / stored XSSはWordfenceを既定にする。
3. RCE / PHP upload / Admin昇格は、Patchstack Zeroday固定額とWordfence estimatorを提出直前に比較する。Patchstack Zeroday要件から一つでも外れるならWordfenceを優先する。
4. impactful CSRFはPatchstackだけを候補にするが、少額AXP目的で数を増やさない。
5. Patchstack Active VDPは+15% AXPだけでなく独占条件を確認する。一般scope外のVDP-only報告はAXPなしの可能性がある。
6. PatchstackでTOP20+2圏外なら、通常報告を増やすよりWordfenceのper-finding報酬へResearch資源を寄せる。
