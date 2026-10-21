---
status: accepted
date: 2026-10-21
amends: 0031（段 1 で落とした Finding は Lab に回さないが、理由付きで一覧に残す）, 0035（skill による検証の前後に段を置く）
---

# 検証から提出までを 6 段に分け、所有者が手動で再現してから提出する（#441）

## 背景

本番の台帳（2026-10-21 時点）では、v8 の scope 内 Finding 51 件のうち runner の自動検証だけを受けたものが 39 件で、自動検証 40 回の `runtime-confirmed` は 0 件だった。handoff の skill 検証は 22 回で 3 件が判定器の結論に届いた（[設計課題の報告](../reviews/2026-10-20-design-issues-from-production-results.md) 3.1 節）。探索側は Finding を出しており、詰まっているのは検証と triage である（[公開ハーネスの共通点 5](../reviews/2026-10-21-public-harness-alignment.md) 2.5 節）。

所有者は 2026-10-21 に次を決めた。

- 探索方式の改善は、検証から提出までの流れが通ってから行う。探索は脆弱性を見つけている。残る問題はトークン使用量だけで、それはモデルの変更で扱う（#418 の実験で子を Sonnet にした。[記録](../evaluation/2026-10-21-child-model-experiment.md)）。
- 検証は段に分け、各段を skill で行う。結果の判定は所有者も手で確かめるので、自動検証が失敗し続けるよりは緩くてよい。ただし手順は明確でなければならない。
- 報告書は Patchstack の Submission requirements に揃える。過去の提出は所有者の提出フォルダ（Git 外）を参照する。
- 所有者が手動で再現し、中身を理解してから、フォーム入力の拡張機能で提出する。
- 提出先は報酬が出る先に限る。Wordfence が既存 VDP のため受け付けない対象は Patchstack か vendor に出す。
- 選定に Patchstack VDP の対象を含めてよい。

## 決定

受理した scope 内 Finding は、次の 6 段を順に通る。段ごとの skill と Issue は親 Issue #441 にある。

| 段 | 内容 | 受け持ち |
| --- | --- | --- |
| 1 | Wordfence の受理規則の文（所有者が持ってくる写し）に照らし、確実に受理されない前提の Finding を検証前に落とす。落とすのは、競合状態を要するもの、非現実的な前提を要するものなど、規則文が明示する種類に限る。受理が怪しい程度のものは落とさない | skill（#436） |
| 2 | 同じ Snapshot 内で同じ経路の Finding を群にし、群の代表から検証する。判定と提出の単位は Finding のまま | Harness の集合判定 + review の表示（#424） |
| 3 | Harness が立てた Lab で、種別ごとに明確な手順で再現する。被害者側の表示は Lab 観測器が行う。判定器が `incomplete` を返しても、観測（HTTP 記録、画面、動画）は review に届ける | skill `wbh-verify` v5（#437）、判定器は変えない |
| 4 | 同じ plugin の同じ版で公開済みの脆弱性が無いかを照合する。無ければ提出候補にする | skill `wbh-dedupe`（#442） |
| 5 | 提出先を Wordfence → Patchstack → vendor の順で決める。報酬が出ない先には提出しない | skill（#438） |
| 6 | Patchstack / Wordfence の要件に揃えた英語の報告書を書き、HTTP 記録・画面・動画を添える。過去の提出を参照する | skill `wbh-report`（#439） |

その後、所有者が手動で再現して中身を理解し、自身の拡張機能で提出する。Harness は送信しない（不変条件 7）。

「緩くてよい」の読み方を固定する。

- 判定器の `runtime-confirmed` の条件（nonce 付き canary の回収、不変条件 3）は変えない。
- 緩くするのは結果による選別である。判定器が `incomplete` の Finding も、観測を付けてレビュー列に残す。落とすのは段 1 の規則文による篩と、段 4 の公開済み照合だけである。
- 段 1 で落とした Finding は Lab に回さないが、`finding-parked` と同じ要領で理由付きの一覧に残す。ADR 0031 の「全件がレビュー列に出る」は、この一覧を含めて満たす。

選定については、コードを変えない。選定の programme 判定は「Wordfence programme が plugin という資産種別を受け付けるか」というプログラム単位の確認で、対象ごとの VDP の有無では落としていない（`src/profiles/wordpress/selection/wordpress-selection.ts` の `programmeAcceptsAsset`）。対象ごとの除外は `excludedAuthors` の 7 社だけである。Patchstack にしか出せない対象は候補に入り、振り分けは段 5 で行う。

## 理由

- 自動検証は precondition で止まり続け、skill の handoff だけが判定器の結論に届いた。検証の中身を skill に置く ADR 0035 の方向と一致する。
- 段を分けると、各段の落とした件数と所要分を別々に測れる。詰まる段が分かる。
- 所有者が手動で再現する前提を置くと、検証の自動化を完全にする必要が無くなる。Harness は観測を漏れなく渡すことに集中できる。
- 報酬が出ない提出をしないのは、所有者の目的（LESSONS、月額の目標）に直接従う。

## 採らなかった選択肢

- 判定器の条件を緩める（agent の自己申告や観測器の表示結果を `runtime-confirmed` にする）。不変条件 3 に反する。「緩くてよい」は結果による選別の話として読んだ。
- 段 1 を Harness のコードにする（前提の文から種類を選ぶ正規表現）。判断を含むので skill に置く（AGENTS.md「Harness と AI の責務」）。
- 段 3 の前に探索方式を直す。所有者が後回しにすると決めた。
- 選定に Patchstack VDP 用の採点や gate を足す。現状で落としていないので不要である。

## 帰結

- Step 2「レビュー側と検証側の作り込み」を、Step 1 の判定（#238、2026-10-27）を待たずに始める。DEVELOPMENT.md 第 2 節に追記した。
- Patchstack の Submission requirements の写しを `src/profiles/wordpress/policy/patchstack-submission-requirements-2026-10-21.md` に置いた。Wordfence の受理規則の写しは所有者から届いたら隣に置く。
- 過去の提出フォルダは Git 外に置いたまま参照する。Git、Issue、PR、会話に写さない（不変条件 8）。
- 2026-10-21 の merge（#419、#434、#413）は所有者が門を免除した 1 回限りの扱いで、以後は `docs/agents/pr-review-merge.md` の門に戻る。
- 段ごとの結果（落とした理由、群、判定器の結論、照合の 3 値、提出先、文案の digest）は review export か台帳に残し、本文は Private Evidence に置く。

## 消し方

- 段 1 と段 5 の skill を消し、全件を Lab に回して Wordfence だけに出す形へ戻す。
- 段 2 は #424 の消し方（群の識別子を読まない）に従う。
- 本 ADR を `superseded` にし、ADR 0031 と 0035 の該当行を元に戻す。
