# 設計の読み解き

図から読みたい場合は [ARCHITECTURE.md](ARCHITECTURE.md)、現行コードとの差は [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md)。規則は [SPEC](SPEC.md) と [ADR](adr/) が正本。

## 1つの対象が進む道

開始点は2つある。開発・検証では、人間がTranslatePressの公開済み版を直接指定する。3.2.6を1協調Trialで調べ、ゲートが通らなければ診断後に3.3.1を試す。どちらか1件で独立確認と同一経路の修正版対照が通ったら本番探索に移る。実運用では、Wordfence Intelligenceの低権限・高影響の公開履歴、WordPress.orgのinstall数・公開状態、プログラム対象範囲を使って機械選定する。最初は最新版3対象のパイロットで費用と歩留まりを測る。

Target Snapshotはplugin、WordPress本体、必要な依存sourceの版とdigestを固定する。WordPress coreは攻撃の文脈を読む資料だが、core自身の欠陥をpluginの報奨対象として主張しない。Elementorなどの別pluginは必要な依存が実際にある時だけ同梱し、版と設定を固定して提出先の対象範囲を確認する。

探索ではRootと最大3つのsubagentを1つのTrialとして動かす。比較用の `wp2shell-bounty-v2` は異なる仮説を複数waveで試し、反証してから経路をつなぐよう求める。対象ごとの具体的な問いはRootが決める。優先Findingがないときは30分以上を指示するが、Harnessによる下限の強制は今後の実測課題である。子が見つけたFindingとLeadは個別にPrivate Evidenceへ保存し、Rootがまとめた最終JSONの失敗で消えないようにする。同じ版を再探索する外側のループは持つが、回数や停止規則は最初の実測から決める。

Findingが出たら、探索会話を持たないVerifierが新しいgVisor Labで手順を整え反証を試す。`runtime-confirmed` を出すのはHarnessの判定器だけで、nonce付きcanaryと捕捉したHTTP記録が要る。Labや証拠の不足は `incomplete` として残す。修正版では同じ主張がconfirmedにならないことも確かめる。

次に公開中の最新版を固定し直して再検証する。Wordfenceのローカルmirrorを更新して重複候補を検索し、PatchstackとWPScanの公開記録も確認する。照合不能や古いfeedは「重複なし」と言わない。scopeは提出先ごとに評価し、Wordfenceを第一候補にする。

confirmedで最新版でも成立するものには、判定器が実際に捕捉した遠隔攻撃者視点のHTTP手順、応答、canary、必要な画像から短い英語レポートと入力用JSONを作る。Labの再構築情報と設定を添え、人間が自分の手で同じ手順を再現する。人間は影響と文案を査読し、正確な版と送信先への外部行動を承認してから、自分で提出する。Harnessは送信しない。

## なぜこの順番か

人間に難しいのは複数機能をつなぐ発見と、再現できる証拠の取得である。そこを先に実証し、レポート生成の完全自動化を待たずに最新版の本番探索を始める。安い広域探索や複数方式の切替は、3対象の費用と歩留まりを見てから加える。コードの機能数より、実際に `Finding → confirmed → 人間が再現可能` へ至る率を重視する。
