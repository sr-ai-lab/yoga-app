# 動画リスト更新手順

動画データは **GitHub Actions が毎週月曜 9:00(日本時間)に自動更新**します。
通常、人がやることは「保留(要確認)の動画を見て、採用/除外を決める」だけです。

## データの仕組み

```
YouTube Data API ─→ data/catalog.json   収集した全動画の台帳(自動処理だけが書き換える)
                    data/overrides.json  人の修正(人だけが編集。自動処理は書き換えない)
                          │
                          ▼ 台帳 + 人の修正から生成
                    data/videos.json     アプリが読む推薦対象(★直接編集しない)
                    docs/HELD.md         保留(要確認)の一覧と理由(自動生成)
```

| 区別 | 場所 |
|---|---|
| 自動取得した情報 | `catalog.json` の `title / duration_sec / published_at / signals` |
| 自動分類 | `catalog.json` の `classify.auto`(強度・種別・タグ+根拠 `evidence`) |
| 人の修正 | `overrides.json` |
| 除外 | `catalog.json` の `judge`(理由コード付き)、または `overrides.json` の `exclude: true` |
| 保留 | `docs/HELD.md` に一覧(アプリの推薦には使われない) |

分類ルールは `data/classification-rules.json`(タイトルと再生時間だけを根拠にした決定論的ルール。AIは使わない)。

## 分類の考え方(ルール v2)

次の4つは**別々の軸**です。動画の長さだけでは、強度も種別も決めません。

| 軸 | 値 | 決め方 |
|---|---|---|
| 強度 | 1(低)/ 2(中)/ 3(高) | 内容を示す語(トレーニング=3、フロー・ピラティス=2、ストレッチ・ほぐす・寝たまま・リラックス=1 など)。手がかりが無い・矛盾する場合は**保留** |
| コース内の役割(種別) | warmup / main / cooldown | 高強度は短くても main。cooldown は「運動後・仕事後・疲れをとる・寝る前・安眠」など、warmup は「ウォームアップ・目覚め・朝」+低〜中強度+短時間の組み合わせのみ。それ以外は main |
| 運動目的(tags) | 肩・首・腰・骨盤・全身・筋力・疲労回復・リラックス ほか | `vocabulary.json` の語のみ |
| 時間帯 | 朝 / 夜 / 寝る前 / (なし=どちらでも) | tags の「朝」「夜」「寝る前」。強度・種別の根拠にはしない |

運動以外の動画は、「募集」「舞台裏」「お知らせ」「告知」「ご報告」が含まれれば(「ヨガ」等の語があっても)除外。
「対談」「ワークショップ」「使い方」などは運動語もあれば保留にして人が確認します。「撮影」「紹介」だけでは除外しません。

## 定期更新が行うこと(毎週)

1. 2つの公式チャンネル(B-Flow / B-Flow Studio)の新着を YouTube Data API で取得(動画IDで重複排除)
2. **台帳に残る全動画のメタデータを再取得**(公開状態・タイトル・再生時間)
3. 除外: ライブ配信・ライブアーカイブ / YouTube Shorts / 再生時間なし / 60分超 / 非公開・削除 / 運動以外
4. 判断が不確かなものは **保留**(推薦しない)。確信を持って分類できたものだけを `videos.json` に追加
5. 変更があれば自動でコミットし、同じ実行の中で GitHub Pages へ公開
6. 新着0件でも正常終了

### 削除・非公開の扱い(一時的なAPIエラーによる誤削除の防止)
- 動画が見つからない/非公開になっても、**1回目は推薦対象のまま**(台帳に `missing_runs: 1` を記録)。同じ実行内でも1回再確認します
- **連続して(約1週間後の次回実行でも)確認できたら除外**(`unavailable_since` を記録)
- 確定後に再び見つかれば、自動的に元に戻ります
- 確定から30日たつとタイトル等を消去し、IDと状態だけを残します
- 一度に多数(5%超)が「利用不可」になった場合は、API障害とみなしてそのチャンネルの更新を止めます

### 更新に失敗したとき
- ワークフローが**失敗(赤)**になり、GitHub から通知が届きます。ログの「Sync videos from YouTube」にチャンネル別の原因が出ます
- 失敗したチャンネルのデータは一切変更しません。もう一方のチャンネルが成功していれば、そちらは保存されます
- 最終更新から14日を超えると「Check data freshness」ステップも失敗します
- **Shorts一覧(YouTube非公式の仕様)が以前は取得できていたのに取得できなくなった**場合は、そのチャンネルの更新を止めて警告します。確認のうえ、本当にShortsが無くなったなら `scripts/config.json` の該当チャンネルに `"ignore_shorts_playlist": true` を追加してください

## YouTube API規約への対応(保存データの更新・削除)

APIキーだけで取得した公開データは、規約上「Non-Authorized Data」です。規約(YouTube API Services Developer Policies III.E.4)では、保存は限定的な量にとどめ、**保存から30日を超えたら削除または再取得**が必要です。

| 項目 | 対応 |
|---|---|
| 再取得 | 毎週、台帳の全動画を再取得。実行間隔は7日で、1回失敗しても14日以内に次の実行がある |
| 最終更新の管理 | `catalog.json` のチャンネルごとに `last_verified`(日付)と `last_verified_at`(UTC日時) |
| 鮮度の監視 | 14日超でワークフロー失敗。`validate.mjs` も警告を表示 |
| 保存する項目 | 動画ID・タイトル・公開日・再生時間・状態フラグのみ。**説明文・再生数などの統計値は保存しない** |
| 削除/非公開 | 確定後30日でタイトル等を消去(IDと状態のみ残す) |
| 動画ファイル | ダウンロード・キャッシュなし。サムネイルは YouTube の画像URLを参照するだけ |
| 利用するAPI | `channels.list` / `playlistItems.list` / `videos.list`(いずれも1ユニット/回。毎週およそ25〜30ユニット) |

保存件数(約850件のタイトル・再生時間)が規約の「限定的な量」に当たるかの最終判断は、規約原文でご確認ください。

## 人が行う作業

### 保留の動画を採用する/除外する
1. `docs/HELD.md` を開く(GitHub上で見られます)。動画ごとの保留理由と、自動分類の案が載っています
2. 動画を実際に開いて内容を確認
3. `data/overrides.json` に動画IDで追記
   - 採用(分類を自分で決める): `"動画ID": { "intensity": 2, "type": "main", "tags": ["腰", "リラックス"] }`
   - 採用(自動分類の案のまま): `"動画ID": { "approve": true }`
   - 推薦しない: `"動画ID": { "exclude": true }`
   - tags は `data/vocabulary.json` の語のみ(1〜5個)
4. `node scripts/catalog-sync.mjs --rebuild` で `videos.json` と `HELD.md` を再生成
5. `node scripts/validate.mjs` がエラーゼロであることを確認して commit

### 自動分類を直したい
`overrides.json` に上と同じ形式で書けば、以降の自動更新・再分類で上書きされません。
ライブ配信・Shorts・削除/非公開など技術的に使えない動画は、`overrides.json` で復活させることはできません。

### 分類ルールを直したい
1. `data/classification-rules.json` を編集し、`version` を上げる
2. `node scripts/catalog-sync.mjs --reclassify --diff-out=docs/RECLASSIFY_DIFF.md` … 変化する動画の**変更前後の一覧**を書き出す(何も書き換えない)
3. 内容を確認して `node scripts/catalog-sync.mjs --reclassify --apply`(人の修正は上書きされない。推薦対象が大きく減る場合は `--allow-removals` が必要)

## コマンド一覧

| コマンド | 用途 | APIキー |
|---|---|---|
| `node scripts/catalog-sync.mjs --incremental` | 定期更新(Actionsが毎週自動実行) | 必要 |
| `node scripts/catalog-sync.mjs --backfill` | 過去動画の全件取得(何度でも実行可。重複しない) | 必要 |
| `node scripts/catalog-sync.mjs --reclassify [--apply] [--diff-out=パス]` | ルール変更後の再分類 | 不要 |
| `node scripts/catalog-sync.mjs --rebuild` | 台帳+人の修正から videos.json を再生成 | 不要 |
| `node scripts/catalog-sync.mjs --report` | チャンネル別・理由別の集計 | 不要 |
| `node scripts/catalog-sync.mjs --list-held` | 保留の一覧 | 不要 |
| `node scripts/catalog-sync.mjs --check-freshness [--max-days=14]` | 保存データの鮮度確認 | 不要 |
| `node scripts/validate.mjs` | 検証(構造+台帳との一致+鮮度警告)。pushの前に必ず実行 | 不要 |
| `node --test scripts/test/*.test.mjs` | 自動テスト | 不要 |
| `node scripts/build-site.mjs` | 公開用ファイルを `_site/` に集める(確認用) | 不要 |

共通オプション: `--dry-run`(何も書き込まない) / `--no-build`(台帳だけ更新) / `--allow-removals`(推薦対象の急減を許可)

終了コード: `0`=成功(新着0件も成功) / `1`=失敗(データ未変更) / `2`=一部チャンネルのみ失敗(成功分は保存)

## チャンネルを追加するとき
`scripts/config.json` の `channels` に `{ "name", "channel_id", "handle" }` を追加し、
`node scripts/catalog-sync.mjs --backfill` を実行します(コードの変更は不要)。
`name` は `videos.json` の `channel` 欄に入ります。

## GitHub Pages の公開方式(GitHub Actions)

公開元は **「GitHub Actions」** です。`.github/workflows/deploy-pages.yml` が、アプリの実行に必要なファイルだけ(`index.html` / `app.js` / `style.css` / `manifest.json` / `icons/` / `data/videos.json` / `data/modes.json` / `data/vocabulary.json` / `robots.txt`)を公開します。台帳・ルール・スクリプト・ドキュメントは公開されません。

- 人が main に push したとき → 自動で公開
- 定期更新がデータを変更したとき → 同じ実行の中で公開(`GITHUB_TOKEN` によるコミットでは Pages の自動公開が動かないため、デプロイ用ワークフローを直接呼び出す方式。追加のトークンは不要)
- Actions タブから手動でも公開できます(Deploy to GitHub Pages → Run workflow)

## 初期設定(最初に一度だけ)

### 1. YouTube Data API キー(取得・登録済みの場合は不要)
1. https://console.cloud.google.com/ でプロジェクトを作成し、**YouTube Data API v3** を有効にする
2. 「認証情報」→「APIキーを作成」。キーの「API の制限」を YouTube Data API v3 のみにする(アプリケーションの制限は「なし」)
3. GitHub: Settings → Secrets and variables → Actions → New repository secret → Name: `YOUTUBE_API_KEY`
4. キーはコード・ログ・公開JSONに出ません(Secrets からワークフローの環境変数に渡すだけ)

### 2. GitHub Pages の公開元を「GitHub Actions」に変更(1回だけ・この順番で)
1. リポジトリの **Settings → Pages** を開く
2. **Build and deployment → Source** を **「GitHub Actions」** に変更(保存操作は不要。選ぶだけで反映されます)
3. それから、このブランチを main に push する(順序が逆でも壊れませんが、最初のデプロイが失敗して赤くなります)
4. **Actions タブ**で「Deploy to GitHub Pages」が緑になり、サイトが表示されることを確認
5. (推奨)**Settings → Environments → github-pages** で、Deployment branches が main のみであることを確認

### 3. 初回の動作確認
1. Actions タブ → 「Video data update」→ Run workflow
2. まず **dry_run = true** で実行し、緑になること・Summary の表を確認
3. 次に dry_run = false で実行。変更があればコミットされ、そのあと自動でデプロイされることを確認

## ローカルで実行する場合
`.env` に `YOUTUBE_API_KEY=...` を書いておけば `node scripts/catalog-sync.mjs --incremental` が使えます(`.env` は `.gitignore` 済み)。

## 注意点
- **GitHub は 60日間リポジトリに活動がないと、スケジュール実行を自動停止**します。毎週のデータ更新で通常は活動が続きますが、止まっていたら Actions タブで再有効化してください(14日を超えると鮮度チェックが失敗して気づけます)
- GitHub のスケジュール実行は、混雑時に数十分遅れたり、まれにスキップされたりします。毎週実行にしているのは、1回スキップされても14日以内に収めるためです
- Shorts の判定は YouTube が公式に提供する印がないため、(1) Shorts専用の一覧に載っているか (2) `#shorts` タグ+短尺 で判定し、60秒以下で断定できないものは保留にします
- 年に1回程度は `node scripts/validate.mjs --check-live` で視聴不可動画がないか確認してください
