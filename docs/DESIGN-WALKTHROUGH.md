# 設計の読み解き

図から読みたい場合は [ARCHITECTURE.md](ARCHITECTURE.md)、現行コードとの差は [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md)。規則は [SPEC](SPEC.md) と [ADR](adr/) が正本。

## 1つの対象が進む道

開始点は2つある。開発・検証では、人間が公開済み事例のプラグインと版を直接指定する。実運用では、Wordfence Intelligenceの低権限・高影響の公開履歴、WordPress.orgのinstall数・公開状態、プログラム対象範囲を使って機械選定する。最初の縦断スライスでは選定の完成を待たず、直接指定から始める。

Target Snapshotはplugin、WordPress本体、必要な依存sourceの版とdigestを固定する。WordPress coreは攻撃の文脈を読む資料だが、core自身の欠陥をpluginの報奨対象として主張しない。Elementorなどの別pluginは必要な依存が実際にある時だけ同梱し、版と設定を固定して提出先の対象範囲を確認する。

探索ではRootと最大3つのsubagentを1つのTrialとして動かす。短い目的promptは攻撃者位置、到達したい影響、出力形式だけを伝え、ファイルの読み順や手順はRootが決める。子が見つけたFindingとLeadは個別にPrivate Evidenceへ保存し、Rootがまとめた最終JSONの失敗で消えないようにする。同じ版を再探索する外側のループは持つが、回数や停止規則は最初の実測から決める。

Findingが出たら、探索会話を持たないVerifierが新しいgVisor Labで手順を整え反証を試す。`runtime-confirmed` を出すのはHarnessの判定器だけで、nonce付きcanaryと捕捉したHTTP記録が要る。Labや証拠の不足は `incomplete` として残す。修正版では同じ主張がconfirmedにならないことも確かめる。

次に公開中の最新版を固定し直して再検証する。Wordfenceのローカルmirrorを更新して重複候補を検索し、PatchstackとWPScanの公開記録も確認する。照合不能や古いfeedは「重複なし」と言わない。scopeは提出先ごとに評価し、Wordfenceを第一候補にする。

confirmedで最新版でも成立するものには、判定器が実際に捕捉した遠隔攻撃者視点のHTTP手順、応答、canary、必要な画像から短い英語レポートと入力用JSONを作る。Labの再構築情報と設定を添え、人間が自分の手で同じ手順を再現する。人間は影響と文案を査読し、正確な版と送信先への外部行動を承認してから、自分で提出する。Harnessは送信しない。

## なぜこの順番か

人間に難しいのは複数機能をつなぐ発見と、再現できる証拠の取得である。そこを先に完成させる。対象選定の採点、安い広域探索、複数方式の切替は、1本の報告まで通った後に発見率と費用を見て加える。コードの機能数より、実際に `Finding → confirmed → 人間が再現可能` へ至る率を重視する。
