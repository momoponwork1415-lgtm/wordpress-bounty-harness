# 操作者の候補一覧を選定へ取り込む（#520 限定範囲）

## 承認との対応

正本は [2026-10-28 の所有者承認](https://github.com/momoponwork1415-lgtm/wordpress-bounty-harness/issues/520#issuecomment-6468469367)で、操作者が作る slug・版・根拠 digest の候補一覧の取込みに限る。
元の種生成と sweep skill は未実装であり、個別機構文・修正差分本文を探索 agent に渡す機能は含めない。

| 承認要素 | 対応 |
| --- | --- |
| 操作者の一覧を通常選定へ取り込む | 自動方針の任意欄 `operatorCandidates` に 3 欄だけの一覧を受け、既存の `select --config` と公開 `decide(policy)` で通常候補へ統合する |
| #533 の順序と同版 1 Trial を維持する | 追加候補も同じ適格性検査・インストール数と更新日の順位・台帳履歴検査を通り、指定版が stable と違うと理由付きで除外する |
| Programme Boundary と SPEC §2 を維持する | 対象範囲、作者・slug 除外、鮮度・install の下限を迂回せず、根拠本文の入力欄と読取経路を設けない |
| 種生成と sweep skill は未実装として残す | 変更は候補の形・機械的な取込み・選定レポートの参照に限り、prompt・skill・役の文章は変更しない |
| 判定器を復活させない | Finding / handoff / 人間の観測の経路と既存 event 型は変更しない |

方針の `operatorCandidates` は次の形で、通常の自動方針へ追加する。
これは合成例であり、実在の Finding や根拠本文を含まない。

```json
{
  "operatorCandidates": [
    {
      "slug": "synthetic-example",
      "version": "1.2.3",
      "evidenceDigest": "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
    }
  ]
}
```

候補一覧は policy digest の計算に含めるため、根拠 digest が変われば方針 digest も変わる。
参照の本文は開かず、形だけを検査し、既存の選定レポートの `inspections[].operatorCandidate` に残す。
探索へ渡す選定対象は従来の `TargetSelection` のままで、候補の根拠参照・本文は付けない。
同じ slug が通常一覧にもあれば観測を一度にまとめ、指定版が stable と違えばその回は除外するため、操作者は現在の版で一覧を作り直せる。
候補一覧内の重複 slug は不正な方針として拒否し、一覧取得が失敗・期限切れの場合は追加候補だけで先へ進まない。

## 公開境界での検証

`openWordPressSelection().decide()` を公開境界とし、WordPress.org 観測と Programme 応答だけを合成 fixture へ置き換え、台帳は既存の event schema を通した合成記録を読む。
最初の受入は `operatorCandidates` が未知欄として拒否される red を確認してから green にした。
次の受入は指定版 `1.2.2` が stable `1.2.3` に読み替わる red を確認してから、`operator-candidate-version-mismatch` で除外する green にした。

| 合成 fixture の条件 | 観測結果 |
| --- | --- |
| 通常一覧 1 件＋追加候補 4 件（通常一覧との重複 1 件） | 重複除去後 4 件から 2 件を install 順に選定し、同版 Trial 済み 1 件・下限未満 1 件を除外する |
| 上の Trial 済み対象の観測版と指定版を `1.2.4` にする | 3 件を選定し、上位 install の復帰対象の理由は `version-increased` になる |
| stable 不一致 1 件 | 選定 0 件、版不一致の理由と元の指定版を返す |
| 適格 1 件・除外 slug 1 件・除外著者 1 件・更新期限切れ 1 件・観測期限切れ 1 件・配布停止 1 件 | 適格な 1 件だけを選定し、残り 5 件にはそれぞれ既存の除外理由を返す |
| 上の 6 件で Programme が古い / asset 対象外 | それぞれ選定 0 件、全 6 件に Programme の理由を返す |
| 個別機構文 / 差分 / PoC / 再現手順の追加欄 | 4 種すべてで方針の parse を拒否する |
| 重複 slug / 不正な根拠参照 / 不正な版 / 不正な slug / 手動方針への混在 | 5 条件すべてで方針の parse を拒否する |
| 一覧取得不能で追加候補 1 件 | 選定 0 件、sourceStatus は `unavailable` のままになる |

選定対象の JSON に合成の根拠 digest が無いことと、根拠 digest の変更で policy digest が変わることも確認する。
ここでの数字は入力の取込み・除外・記録の検査であり、探索の当たり率や報酬率の改善を示さない。
本番候補・Private Finding・既存 state を読まず、有償 Trial は 0 件で、M1〜M6 の探索・提出結果は未計測である。
`pnpm check` は 1,325 件成功・2 件 skip、`pnpm build` は成功した。

## 消し方

方針から `operatorCandidates` を外せば、通常一覧からの選定に戻る。
実装を退役させる場合は selection の候補 schema・統合処理・inspection の参照と対応する受入を削除し、既存の選定レポートと台帳記録は残す。
