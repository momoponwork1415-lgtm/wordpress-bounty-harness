# TranslatePressで本番探索へ進むための最小ベンチマーク

この文書は [SPEC 第10節](SPEC.md) の実行計画。目的はRoot＋3、独立検証、判定器、台帳が**実際の公開済みWordPressプラグイン**で一続きに動くと確認し、最新版の本番探索へ早く移ること。既知事例の再発見は未知脆弱性の発見率や報奨見込みを示さない。

```mermaid
flowchart LR
  PRE[Daybreak / runsc / broker の実機preflight] --> T1[TranslatePress 3.2.6<br/>Stored XSS: 1 Trial]
  T1 --> E{Findingを新Labがconfirmedし<br/>修正版で同経路が不成立?}
  E -->|はい| PILOT[最新版3対象の本番探索パイロット]
  E -->|いいえ| DIAG[読取・停止・provider・判定器を診断]
  DIAG --> T2[TranslatePress 3.3.1<br/>アカウント乗っ取り: 1 Trial]
  T2 --> E2{同じゲートを通過?}
  E2 -->|いいえ| FIX[故障箇所を修正し必要分だけ再試行]
  E2 -->|はい| PILOT
  PILOT -->|実Finding| SUBMIT[最新版の独立確認・重複照合・証拠<br/>人間Lab再現・査読・承認を経て提出]
  PILOT --> REVIEW[3対象後に費用と歩留まりを評価]
```

## 1. 初回の範囲

| ケース | 探索版 | 評価側の影響分類 | 負の対照 | 役割 |
| --- | --- | --- | --- | --- |
| TP-SX | 3.2.6 | Stored XSS | 対応する修正版を実行前にpinする | 本番探索開始ゲートの候補 |
| TP-ATO | 3.3.1 | アカウント乗っ取り | 3.3.2を取得・digest固定して同じ経路を再実行 | 本番探索開始ゲートの候補 |
| TP-RX | 3.2.5 | Reflected XSS | 必要時だけ | 対象外分類の診断用。ゲートには数えない |

TP-SXの修正版はWordfence履歴の修正情報と公開archiveの版を実行前に照合してpinする。同一版に複数のXSS経路があり得る。負の対照は「発見した**その経路**が修正版で成立しない」であり、修正版の全XSSが無いという主張ではない。source、WordPress core、必要な依存、Lab設定、prompt、model、判定器の版とdigestを記録する。

初回はTP-SXを**Root＋3協調Trialで1回**試し、ゲートが通ればTP-ATOは回さず本番へ進む。通らなければ失敗した境界を診断してからTP-ATOを1回試す。計画した初回は最大2 Trial、各Trialのwall上限は90分とする。追加の公開事例・prompt A/B・pass@kは増やさない。制限時間前の正常終了もそのまま記録する。provider上限やLab失敗は探索0件と数えず、理由を残して再開する。

## 2. 入力と採点

- 探索runには固定した脆弱版source、trust境界、Programme Boundary、Labだけを渡す。対象のadvisory本文、PoC、payload、原因箇所、修正差分、修正版sourceは渡さない。評価側の表も探索コンテナへmountしない。Wordfence履歴を使うときは対象事例の公開前で切り、初回は混入を避けるため履歴なしで走らせる。
- 一次は `Finding` のsource traceと攻撃者位置を確認する。`Lead` は次の問いとともに保存するが、ゲート成功にはしない。二次は探索会話を渡さない新しいLabで、Harness判定器がnonce canaryを回収して `runtime-confirmed` にする。
- 同じrecipeを修正版の新しいSnapshotで実行し、同じ経路が `runtime-confirmed` にならないことを確認する。setup不能・証拠欠落なら `incomplete` とし、負の対照成功と数えない。
- 別の真の脆弱性が見つかった場合はFindingとして独立検証する。対象事例の再発見とは区別するが、同じ安全・証拠ゲートを通れば実行能力の証拠にはできる。
- Rootと子それぞれのsource読取、command数、wall、usage、停止理由、Finding / Leadの個別保存を台帳から確認する。最終JSONの整形失敗で子の成果が消えた場合は未達。

手入力のAnswer Keyや11件の公開事例の登録は要求しない。現行の `eval score --keys` は比較研究に必要になったときだけ使う任意機能。#73の単独Trialの0件は診断材料であり、今回のRoot＋3の成績には合算しない。

## 3. 本番探索の開始条件

次の全てを満たしたら、残りのTranslatePressケースや多数回の再発見を待たず、公開中最新版の**3対象パイロット**へ進む。

1. どちらか1ケースで、sourceに根拠があるFindingを新しいgVisor LabのHarness判定器が `runtime-confirmed` とした。
2. 同一の攻撃経路がpinした修正版では `runtime-confirmed` にならず、結果の理由・証拠が残る。
3. Rootと子の成果、Snapshot digest、wall、usage、provider / schema / Lab失敗が欠落なく記録される。隔離とbrokerの実機試験も通る。
4. 最小の自動選定方針で現行最新版、install数1万以上、低権限・高影響の履歴、対象範囲、データ鮮度を確認できる。選定理由を台帳に残し、人間の対象ごとの承認は置かない。

3対象は各1協調Trialから始める。具体的LeadやFindingに次のsource上の問いがある場合だけ、同じSnapshotで追加Trialを検討する。pilotで成果0件でも、その対象の探索結果は正常に記録し、報告を作らない。3対象後に対象数、使用量・wall、source読取、Lead、Finding、`runtime-confirmed` / `incomplete`、既知重複、人間の再現時間、提出転帰を見て、次の費用を探索・検証・選定のどこに使うか決める。3対象という数は効果の統計推定ではなく、運用上の初回観測単位。

## 4. 本番探索と外部提出を分ける

本番パイロットでは**現行最新版を実際に探索**する。#95の英語JSON完全自動生成、#96の複数feed照合、#98の1コマンド運用が完成するまで探索開始を延期しない。既存のdraft登録口を使い、実際のFindingが出た時点で必要な文案・人間Labの作業を優先して完成させる。

外部提出は別ゲート。提出時点の最新版Snapshotでの独立確認、Wordfence / Patchstack / WPScan等の重複候補とscopeの照合、攻撃者視点のHTTP証拠、英語文案、人間主導のLab再現と査読、文案版・送信先に結び付く承認を揃える。Harness自身は送信しない。これらが欠ける候補は保持し、未確認のまま送らない。

## 5. 停止と次の判断

計画した最大2 TrialでFindingが0でも、脆弱性が無いという結論にしない。sourceをほぼ読まず数分で終了したか、provider・schema・Labで失敗したか、十分読んで候補が無かったかを分ける。まず失敗した境界を直して同じ条件を再実行し、promptや対象数を同時に変えない。Leadがあれば欠けた一辺を次回の問いにできる。

ゲート達成後はTranslatePressの追加採点を止めて本番へ進む。広域スクリーニング、pass@k、別prompt、別モデル、候補選定の詳細な予測モデルは、3対象の費用・歩留まりから具体的なボトルネックが分かった後に比較する。

## 6. 2026-10-10の実測

TP-SX 3.2.6ではsource候補は出たが、判定器に合う証明を得られず `incomplete` だったためゲートに数えなかった。次のTP-ATO 3.3.1の1協調Trialでは3件のFindingを保存し、Rootと子のアカウント乗っ取り候補2件をそれぞれ新しいgVisor Labのnonce判定器が `runtime-confirmed` とした。残る1件は `incomplete` として保持した。修正版3.3.2の別Snapshotで確認済み経路を再実行した負の対照は、証拠付きで `contradicted` となった。隔離・brokerの実機preflight、Snapshot・usage・停止記録も揃い、本番探索開始ゲートを満たした。

この実測は公開済み事例での実行能力を示す。未知脆弱性の発見率は3対象pilotで別に観測する。HTTP本文、recipe、Lab認証情報と未公開の候補はGit外のPrivate Evidenceに置く。
