# 動画カタログ拡充作業メモ(初回100本構築)

design.md §9.5の「初回100本構築」作業の途中経過・引き継ぎメモです。次のセッションで作業を再開する場合はこのファイルを参照してください。作業が完了し`data/videos.json`が安定したら、このファイルは削除して構いません。

## 現在の状態(2026-08-15時点)

- `data/videos.json`は**102件**(既存18件 + 新規承認84件)。`node scripts/validate.mjs`でエラーゼロを確認済み
- **まだcommit/pushしていません**。作業ツリーには以下が未コミットです:
  - `data/videos.json`(102件に更新)
  - `scripts/build-initial-catalog.mjs`(新規。初回カタログ構築用スクリプト)
  - `scripts/catalog-progress.json`(新規。video ID単位の進捗記録。**gitで追跡する方針**で合意済み)
  - `.gitignore`(`scripts/catalog-candidates.json`を追加。こちらは下書きなので追跡対象外)
  - `scripts/catalog-candidates.json`はローカルにのみ存在(gitignore対象、226件の生候補データ)

## 使ったツールと役割分担

- `scripts/fetch-new.mjs`: 新着検知専用(RSS直近15本)。**今回の作業では使っていません。役割は変更していません**
- `scripts/build-initial-catalog.mjs`: 過去動画をuploadsプレイリストAPIでさかのぼって取得する専用ツール(新規作成)。`node scripts/build-initial-catalog.mjs --max-pages=N`で実行(1ページ=最大50件、既定5)。`--max-pages=0`で動画取得なしにチャンネルの母集団規模だけ確認可能

## チャンネルごとの走査状況

| チャンネル | 総動画数(統計) | 走査状況 |
|---|---|---|
| b-flow | 945本 | **未走査分あり(約738本)**。`scripts/catalog-progress.json`の`channels.b-flow.next_page_token`から続きを取得可能 |
| b-flow-studio | 295本(統計) | **全件走査完了**(`fully_scanned: true`)。ただし実際にuploadsプレイリストから取得できたのは約48件のみ。大半はメンバー限定配信等で公開uploadsプレイリストに含まれていないと推測される。**このチャンネルからのさらなる追加取得は見込めない** |

## video ID単位の進捗管理(`scripts/catalog-progress.json`)

`processed`オブジェクトに、これまで触れた**全226件**のIDが記録されています。**重複取得・重複分類を防ぐための正本はこのファイル(+ `data/videos.json`の実IDリスト)であり、`next_page_token`は再開位置の目安として補助的に使うのみ**という設計です(pageTokenだけを進捗管理の根拠にしない、という方針合意済み)。

| status | 件数 | 内容 |
|---|---|---|
| `accepted` | 84 | `data/videos.json`に反映済み |
| `rejected` | 53 | 60分超・講師インタビュー・告知/トーク動画・Shorts・チャンネル紹介・非公開/時間未確定。`reason`フィールドに理由を記録 |
| `candidate`(未決定) | 94 | うち5件は要確認・保留(下記)、89件は未レビュー |

## 保留中の5件(今回は不採用。将来判断する場合は`catalog-candidates.json`から再取得可能)

| video ID | 保留理由 |
|---|---|
| `4l5mTWAvX4I` | intensity判断が困難(背中革命、ストレッチか軽い筋トレか不明) |
| `qpYQnsuqe3o` | intensity判断が困難 |
| `pH17nf9Ey3I` | intensity判断が困難(脚やせ、運動量が不明) |
| `A5Cskg0RQzU` | intensity判断が困難(ピラティス、強度表記が曖昧) |
| `UfRZ8WbG2nM` | meditationタイプ自体を今回は対象外とする方針のため保留(瞑想モードは将来の独立モード候補) |

## 今後カタログをさらに増やす場合の手順

1. `node scripts/build-initial-catalog.mjs --max-pages=N` を実行(b-flowの続きから自動再開)
2. 新規候補が`scripts/catalog-candidates.json`に追記される(重複は自動スキップ)
3. 60分超・講師インタビュー・告知トーク・Shorts等の除外基準を適用(目視レビューが必要。機械的に検出できないパターンがあるため、タイトル一覧の目視確認を推奨)
4. 20〜30件程度のバッチで`intensity`/`type`/`tags`の分類案を提示し、確認を得る
5. 確定分を`data/videos.json`に追記し、`scripts/catalog-progress.json`の該当IDを`accepted`に更新
6. `node scripts/validate.mjs`で検証

## 今回のカタログの属性分布(102件、`data/videos.json`確定値)

| 属性 | 分布 |
|---|---|
| intensity | 1: 66 / 2: 19 / 3: 17 |
| type | warmup: 17 / main: 78 / cooldown: 7 / meditation: 0(方針により対象外) |
| channel | b-flow: 76 / b-flow-studio: 26 |
| 動画時間 | 4分〜55分、中央値14分 |

タグ分布や個別の判断理由は、このセッションの会話ログ(バッチ1〜4の分類案提示メッセージ)に詳細があります。

## 未解決の検討事項

- **intensity 3段階(1/2/3)を5段階に拡張するかどうか**: HOPE/7 Days Diet等の高強度コンテンツは同じ「3」の中でもかなり幅があるため、100件到達後の検討事項としてユーザーから明示的に指摘あり。`docs/DESIGN.md`の§14未決定事項への追記が未了(このメモ作成時点でまだ反映していません)

## 次にやるべきこと(このメモを読んだ次のセッションへ)

1. まずユーザーに現状を確認(このメモの内容でよいか)
2. `git status` / `git diff`で変更内容を再確認
3. commit/pushの実施可否をユーザーに確認
4. 上記「未解決の検討事項」をdocs/DESIGN.md §14に反映するかどうかもあわせて確認
