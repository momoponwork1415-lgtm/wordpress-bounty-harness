---
status: superseded by 0017 for default prompt selection
---
# 探索promptの管理指示変種を版付きのA/B軸にする

## 決定

既定は短い目的prompt `short-objective-v2` とする。本文には目的、trust境界、影響の分類と報奨順、FindingとLeadの出力形式だけを書く。探索の手順、checklist、役割分担、段階は書かない。管理指示だけを足す変種はprofileの版付きpromptとして保存し、`ablation.axes` の `prompt` 軸でopt-in割当できる。本文の変更では新しい版を作り、旧版を残し、digest pinを更新する。管理指示変種を既定にする前に本番A/Bで測る。

## 理由と観測

固定手順は探索が立てる仮説を狭め得る一方、探索の管理指示には効果があるかもしれない。版とdigestを固定してTrial ordinalからarmを割り当てれば、探索へ評価対象の答えを渡さずに比較できる。#73のTranslatePress 3.2.5開発セットではprompt両armとも公開2事例のsource候補が各cell 0/3で、優劣は判定不能だった。事前登録した「両方0なら安い方」の規則により短い目的promptを既定に残す。`v2` はLead報告を出力形式に加えた版であり、管理指示の採用を意味しない。

## 採らなかった選択肢

- promptを永久に1本へ固定する: 管理指示の効果を測れない。
- wp2shell由来の固定手順やchecklistを既定にする: 手順が探索の選択を狭め、費用と新規性への影響を測れない。
- 開発セットの0件を管理指示の無効性の証拠とする: 各cell 3件ではその結論は出ない。

## 帰結

prompt本文はWordPress profileに置き、汎用discoveryは版とdigest、armだけを扱う。公開履歴はADR 0012の時点規則に従い、PoC・payload・再現手順はどのarmにも渡さない。
