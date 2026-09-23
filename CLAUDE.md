# CLAUDE.md

このファイルは、このリポジトリで Claude Code (claude.ai/code) が作業する際のガイダンスです。

## Project Overview

**動物健康管理アプリ**（リポジトリ名: AniMediRec）は、保護施設・動物病院・多頭飼育の現場向けに、
個体ごとの健康記録（排泄物・食事・元気・爪切り・投薬・体重など）を記録・共有するアプリです。

このリポジトリには2つのバージョンがあります。**現在アクティブに開発しているのは「クラウド版」**です。

| バージョン | 場所 | 状態 |
|---|---|---|
| プロトタイプ版 | `index.html` | 凍結。サーバー不要の単一HTMLファイル。デモ用途のみで今後更新しない |
| **クラウド版**（本体） | `public/` | 開発中。以下の記載は原則このバージョンが対象 |

- **Version**: 0.2.0（クラウド版）
- **Type**: Single-page web app（ビルドなし・バニラJS）
- **Tech Stack**: HTML + CSS + JavaScript（`type="module"`、ESモジュール）＋
  Firebase JS SDK v10（modular、`https://www.gstatic.com/firebasejs/...` からCDN読み込み。
  npm/バンドラは使わない）
- **Backend**: Firebase（Authentication / Firestore / Cloud Storage / Hosting）。
  Authentication・Firestoreは無料のSparkプランで運用。**Cloud Storageのみ、
  Google側の仕様変更によりBlazeプラン（従量課金・カード登録必須）へのアップグレードが
  必要**（利用量が無料枠内なら実際の請求は0円。予算アラート必須設定）。
  Cloud Functionsは使わない（詳細は「決着済み事項の索引」参照）
- **Data Storage**: Cloud Firestore（施設単位でスコープしたコレクション構成）＋
  Cloud Storage（写真、クライアント側で圧縮してからアップロード）

## Architecture

### High-Level Flow

```
ログイン(施設コード+メール+パスワード)
  → users/{uid} から facilityId・role を解決
  → facilities/{facilityId} 配下をFirestoreでリアルタイム購読(onSnapshot)
  → 一覧/詳細/タイムライン/体重グラフをレンダリング
  → 変更はFirestoreへ書き込み → onSnapshotが自動反映(他端末にも同期)
```

### Core Concepts

1. **施設単位のマルチテナンシー** — 全データは`facilities/{facilityId}/...`配下に置く。
   `facilityId`は**設立者(最初のadmin)のuid**そのものを使う設計。他人の施設IDを騙って
   自分をadminとして登録できないようにするための意図的な設計（`firestore.rules`参照）。
2. **権限モデル** — `admin`/`staff`/`viewer`/`disabled`の4段階。UI側は`.editor-only`/
   `.admin-only`クラスで出し分けるが、**実効的な境界はFirestore/Storageのセキュリティ
   ルール側**（UIはあくまで見た目の制御。console等からの直接呼び出しでも権限を超えた
   書き込みはルールで拒否される設計）。
3. **論理削除** — 個体・記録・体重はすべて`deletedAt`フィールドで論理削除する。
   物理削除はゴミ箱からのadmin操作のみ。
4. **recordedAtによる時系列の一元管理** — 記録の並び順は保存順に依存させず、
   `recordedAt`（`YYYY-MM-DDTHH:MM:00+09:00`のISO文字列）を常に基準にソートする
   （過去日を後から登録しても時系列が崩れない）。
5. **体重はグラム(整数)で内部統一** — 表示・入力の単位(`kg`/`g`)は個体ごとの
   `weightUnit`が担うが、保存値は常にグラム。単位混在・小数誤差を避けるための設計。
6. **無料枠を守るための「読み取り frugal」設計** — 各画面は「今見ている範囲」だけを
   購読し、画面を離れたら`stopListener()`で確実に解除する。一覧画面で全個体の記録を
   横断的に読みには行かない（一覧の検索・要観察バッジ・キーワード検索の対象範囲が
   意図的に狭いのはこのため。詳細は`docs/specs.md`）。

## Key Data Structures

```
facilityCodes/{code}                    { facilityId }
facilities/{facilityId}                 { name, code, createdAt }
users/{uid}                             { facilityId, name, email, role, createdAt }
facilities/{facilityId}/animals/{id}
  { code, name, category, type, breed, sex, birthAccuracy, birthDate, arrivedAt,
    area, build, personality, history, hospitalName, hospitalTel, hospitalMemo,
    weightUnit, latestWeightGrams, photoPath, photoURL, _warn,
    createdAt, createdBy, updatedAt, updatedBy, deletedAt }
  /logs/{logId}    { recordedAt, timezone, category, statusFlag, tags[], memo,
                      photoPath, photoURL, recordedBy, recordedByName,
                      createdAt, updatedAt, deletedAt }
  /weights/{id}    { date, grams, recordedBy, createdAt, deletedAt }
```

詳細・各フィールドの意味・設計理由は `docs/specs.md` を参照。
セキュリティルールが正であり、食い違ったら `firestore.rules`/`storage.rules` を正とする。

## Key Functions / Modules

すべて `public/app.js`（単一ファイル。画面は`public/index.html`）。

| 領域 | 主な関数 |
|---|---|
| 認証・施設・職員 | `registerFacility` `loginWithFacility` `loadFacility` `inviteStaff` `roleLabel` |
| 個体一覧・登録 | `subscribeAnimals` `renderAnimalList` `openAddAnimalScreen` `saveAnimalForm` `checkCodeDuplicate` `confirmDeleteAnimal` |
| タイムライン・記録 | `openAnimalDetail` `subscribeLogs` `renderTimeline` `renderSearchResultTimeline` `openLogModal` `renderModalFormContent` `saveLogRecord` `deleteLogRecord` `updateWarnFlag` |
| 体重 | `subscribeWeights` `addWeightRecord` `editWeightRecord` `deleteWeightRecord` `renderWeightChart` |
| ゴミ箱・職員管理 | `openTrashScreen` `renderTrash` `openStaffScreen` `renderStaffList` |
| エクスポート・印刷 | `exportAnimalListCSV` `exportCurrentAnimalCSV` `exportCurrentAnimalJSON` `exportFacilityBackupJSON` `printAnimalChart` |
| 共通ユーティリティ | `esc`（HTMLエスケープ。innerHTML埋め込み時は必ず通す）`compressImage` `uploadPhoto` `formatWeight`/`toGrams` `sortWeightsAsc`（体重を日付→同日は作成順でソート）`toCSV`/`csvCell` `showToast` `customConfirm`/`customPrompt`（confirm/promptの代替。ルール9） |

画面のonclick属性から呼ぶ関数は、ファイル末尾の`Object.assign(window, {...})`に
**必ず追加**すること（漏れるとブラウザ上で `xxx is not defined` になる）。

## 📚 詳細ドキュメントの地図（★まずここを見る）

**CLAUDE.md は毎リクエストに丸ごと読み込まれる**ため、参照頻度の低い詳細は `docs/` へ分離する。
**このファイルに残すのは「毎回効かせたいルール・知見」だけ**。機能の詳細仕様は下記から読むこと。

| ファイル | 中身 | いつ読むか |
|---|---|---|
| `docs/specs.md` | **実装済み機能の現行仕様**（全機能・判断理由つき） | **その機能に手を入れる前に必ず**。該当セクションを検索して読む |
| `docs/backlog.md` | 未実装・既知の負債・候補の一覧 | 次に何を作るか決める時／新しい案を出す前（重複提案の防止） |
| `docs/roadmap.md` | フェーズ計画と進捗 | 大きな方針を決める時 |
| `docs/SPEC-v2.md` | 当初の改善8項目の仕様検討（提案時点の記録。歴史的資料） | 「なぜこの設計になったか」の背景を知りたい時 |
| `docs/SETUP-FIREBASE.md` | Firebaseプロジェクトのセットアップ手順（運用ドキュメント） | Firebase環境の構築・デプロイ作業をする時 |
| `docs/MIGRATION-GUIDE.md` | 新しいGitHubアカウント・Firebaseプロジェクトへの引っ越し手順（学生向け・完全ゼロから） | 別アカウントへの移行作業をする時／upsert対象外（一度きりの手順書） |

**★探し方**：`grep -n "キーワード" docs/*.md` で当たりを付け、その節だけ読む（docs全体を読み込まない）。

### ★ドキュメントの更新ルール（ルール3の適用先）
- **マージのたびに、その機能のセクションを「現時点の最終仕様」に上書きする（upsert）。版を積まない。**
- 書く先は **`docs/specs.md`**（機能の仕様）／**`docs/backlog.md`**（候補の増減・選定結果）／
  **`docs/roadmap.md`**（ロードマップの進捗）。
- **CLAUDE.md に書き足してよいのは次の3つだけ**：①MANDATORY working rules の変更
  ②「よくある落とし穴」に足す再発防止の知見 ③下記「決着済み事項の索引」への1行追加。
  **これ以外を CLAUDE.md に足さないこと**（放置すると再び肥大化し、毎ターンのコストが上がる）。
- 変更の経緯・履歴は git log とコード内の版数コメント（下記ルール3参照）が担う。
  ドキュメントには履歴ではなく「今どうなっているか」と「なぜそう決めたか（判断理由）」だけを書く。

## 📇 決着済み事項の索引（★ここにあるものを再提案しないこと）

詳細は `docs/` の該当セクション。**「もう一度検討しましょうか」と持ち出さない。**

### 実装しないと決めたもの
- **Cloud Functions の利用**＝サーバーサイド処理を極力持たず、クライアント側処理＋
  Firestore/Storageのセキュリティルールのみで完結させる方針のため不採用
  （2026-09-11 ユーザー選定）。
- **簡易パスコード方式のログイン（施設コード＋暗証番号をJS内で照合するだけの案）**＝
  ソースを見れば突破できセキュリティ上不十分なため不採用。Firebase Authenticationによる
  本格的な認証を採用した。

### 決着済みの方針（変更しない）
- **①④⑤（施設ログイン・クラウド同期・永続保存）はFirebase（無料枠）で本格導入する**
  （2026-09-11 ユーザー選定。方針(a)）。
- **facilityId ＝ 設立者(最初のadmin)のuidをそのまま使う**：他施設IDを騙ってadminに
  なる攻撃を構造的に防ぐため。
- **体重は内部的にグラム(整数)で統一**し、表示・入力の単位(kg/g)は個体ごとの設定で切替。
- **記録の並び順は`recordedAt`（ISO8601）を唯一の基準にする**（保存順や現在時刻に依存しない）。
- **一覧・検索・要観察バッジは「施設全体を毎回読み直す」実装にしない**（無料枠の
  読み取り回数を守るため）。個体内検索は「開いている個体の記録」のみを対象にする
  （施設全体の記録横断検索ではない。旧プロトタイプからの意図的な仕様変更）。
- **ルール9違反（`confirm()`/`prompt()`使用）は解消済み**（2026-09-12）。
  当初は「該当関数に触るタイミングで個別に置き換える」方針だったが、ユーザーから
  一括対応の指示があり、`public/app.js`の全6箇所（個体削除・記録削除・体重の
  編集/削除・完全削除・全データバックアップの確認）を`customConfirm()`/
  `customPrompt()`（自前ダイアログ、`#dialogOverlay`）に置き換えた。
  今後ネイティブダイアログを新たに使わないこと。
- **Cloud StorageはBlazeプラン（カード登録）で運用する**（2026-09-12 ユーザー選定 A案）。
  Google側の仕様変更により、新規プロジェクトはCloud Storageを使う場合Sparkプランのままでは
  有効化できずBlazeへのアップグレードが必須になったため。Authentication・Firestoreは
  引き続きSparkプランの無料枠内。**カード登録＝即課金ではなく、利用量が無料枠内なら
  請求は0円。** 安全のため予算アラート（少額しきい値）の設定を必須とする
  （`docs/SETUP-FIREBASE.md`手順5）。「Sparkプランのみ・カード登録不要」という
  当初の前提は、Storageに関してはもう成立しない（他サービスは変更なし）。
- **クラウド版の主要フローは実機のFirebase環境で動作確認済み**（2026-09-12）。
  施設登録・ログイン・個体登録（写真アップロード含む）・記録追加・検索・ゴミ箱
  （削除→復元）・職員追加（追加中にadminがログアウトされない）・職員でのログイン、
  いずれも正常動作を確認。**未確認のまま残っている機能**: CSV/JSON出力、印刷用カルテ、
  Firebase Hostingへの公開、記録・体重の編集/削除、職員の権限変更/無効化、
  オフライン時の同期。これらに触る際は改めて実機確認を挟むこと。
- **現在のソース状態を0.2.0として記録する**（2026-09-14 ユーザー選定）。0.1.0以降の主な内容：
  認証競合状態・権限表示・体重同日ソートの不具合修正、ネイティブダイアログの自前実装への
  全置換（ルール9対応）、PWAアイコン/manifest追加、アプリ表示名を「動物健康管理アプリ」に
  統一、学生向け資料（つくりかた／お引っ越しガイド）の整備。**1.0.0はFirebase Hostingへの
  本番公開の実施と、上記「未確認のまま残っている機能」の実機確認が済んだ時点**に予定する
  （本番公開自体がまだ一度も行われていないため）。

### 保留中（条件が変われば再検討・こちらから持ち出さない）
- なし（現時点。個別の未実装項目は `docs/backlog.md` を参照）

## Development Workflow

### MANDATORY working rules (user standing instructions)
These rules apply to **every** change. They override convenience.

1. **Prefer patterns already proven in this app.**
   When adding a feature or fixing something, FIRST reach for an approach
   that already works elsewhere in the codebase (existing UI components,
   existing parse/render/save flows, existing formatters). Only if the
   proven pattern genuinely cannot work, try a new approach — and say so
   explicitly.
   - Rationale: reusing what already works avoids reintroducing bugs that
     were already fixed once elsewhere in the codebase.

2. **Verify consistency and check for oversights BEFORE opening a PR.**
   Before committing/PRing, review BOTH code and behavior:
   - No leftover references to removed elements/IDs/classes/functions.
   - CSS/selectors (or equivalent) match the actual names in use.
   - All call sites of a changed function still pass/handle the new shape.
   - Edge cases: empty values, long text, resize, cached/offline state.
   - Re-read the diff end-to-end and confirm nothing else depends on the
     old behavior.
   - **このアプリでの実践方法**: `node --check public/app.js` で構文チェック、
     `getElementById`参照とHTMLの`id`、`onclick`で呼ぶ関数名と
     `Object.assign(window, {...})`の突き合わせを行う（このセッションで実際に
     この方法でバグを検出した。下記「よくある落とし穴」参照）。

3. **Always bump a version identifier** on every change and add a
   `/* ★vX.Y.Z: ... */`-style comment describing what changed and why.
   After merging to the main branch, reset the working branch to it to
   avoid conflicts on the next change.
   - **【例外】未リリース版（＝まだ本流にマージしていないバージョン）への追加修正は、
     バージョン据え置きでよい。** マージ前レビューでの手直しや実機フィードバック前の
     微修正がこれに当たる。**一度本流にマージしたら、次の変更は必ずバージョンを上げること**
     （利用者に配信済みのため）。
   - If the project has a **cache-busting mechanism** (service worker, CDN cache
     key, build hash, etc.), keep its version identifier in sync with the app
     version on every change — a mismatch means users keep seeing the old build.
     **このアプリでは現状キャッシュバスティング機構は未導入**（Firebase Hostingの
     デフォルト挙動に依存）。導入したらここに追記する。
   - If the project has a **user-facing help/usage doc**, update it alongside
     the feature it documents (same upsert policy — rewrite in place, don't
     accumulate change history there).
   - **【必須】`Main`へマージするたびに、その機能のセクションを「現時点の最終仕様」に
     上書き更新する（upsert）。** セクションが無ければ新規作成、あれば**書き換える**。
     変更履歴を積み増さない（履歴は git log と版数コメントが担う）。
     - **理由**：1つの機能は複数回のマージに分かれるのが常態。マージ単位で追記していくと、
       後から「どれが最終仕様でどれが差し替え済みか」を畳み直す作業が発生し、それが重くて
       記録が止まる。上書きなら仕様が右往左往しても常に最新形だけが残るため、後で整形する
       作業がゼロになる。セッション終了時にまとめて記録しない（＝溜めない）。
     - バージョン表記は範囲で持つ（例：`（vX.Y.115〜121実装済み）`）。
     - 記録の要否＝ルール6の基準（重要な決定・仕様・ルール変更）＋ルール14（再発しうる知見）。
       軽微な文言修正・タイポ等は記録不要。

4. **「記録して」「記憶して」と指示された場合は CLAUDE.md に追記する。**
   ユーザーがプロンプトでこれらのキーワードを使った場合、その内容を
   このファイルの適切なセクションに記録すること。

5. **モデル性能について通知する／実装前に必ずモデル適性を判断する。**
   タスクの内容に対して現在のモデルでは性能が不足している場合、
   または低モデルに変更しても問題ない場合は、実行前にユーザーに通知し、
   モデル変更の判断を仰いでから実行すること。
   - **【必須】新機能の初期実装・修正のいずれも、着手前に「このタスクに適したモデル
     （高性能/標準/軽量）」を判断し、現在のモデルと異なるなら実行前にユーザーへ提案すること。**
   - **特にダウングレード（軽微な文言修正・機械的な追従修正など）の見極めが重要。**
     高性能モデルを不要に使い続けないよう、下げても支障がないと判断できる場合は
     積極的に提案する。
   - アップグレードが必要な場合（大規模な新機能・広範な統合・回帰リスクが高い作業）も
     同様に、着手前に上位モデルを提案する。
   - 判断の目安：中〜高難度の新機能・多数の呼び出し経路を跨ぐ統合・複雑なロジック＝
     高性能モデル推奨。軽微なCSS/文言/1〜数箇所の機械的修正＝標準〜軽量モデルで可。
     **このアプリでの目安**：Firestoreスキーマ変更・セキュリティルール変更・複数画面を
     跨ぐ機能追加＝高性能モデル。文言・CSS微調整・タグ定義の追加程度＝標準〜軽量モデルで可。
   - **【重要・提案のタイミング】提案と実装を同じターンで行わないこと。**
     提案した直後に実装を続けると、ユーザーがその表示を見た時点では既に高性能モデルで
     実装が終わっており、モデルを切り替えても手遅れで意味がない。実装が始まる前に
     必ず停止し、合意を得てから着手する。具体的には次の2通りで運用する。
     - **① 仕様検討がある作業（調査→報告→合意→実装）**：合意を求める報告にモデル推奨を
       併記する。往復は増えない。
     - **② 合意ポイントが無い作業（調査不要で即実装できる軽微な依頼）**：モデルを尋ねて
       強制的に停止する（回答があるまで実装しない）。
     - ユーザーがプロンプトで「軽微」「重い」等の判断を明示している場合は、それを尊重して
       確認を省いてよい。
     - **【確認が必要な条件】確認するのは「推奨モデル ≠ 現在のモデル」の時だけ**でよい。
       一致している場合は何も言わずそのまま実行する。
     - **【例外】どのモデルでも結果に差が出ない些末な作業は確認不要。**
   - **モデルの提案は「2軸」で報告する**：①作業内容の観点（この作業は軽いモデルでも可能か）
     ②キャッシュの観点（いま切り替えるとどうなるか）。プロンプトキャッシュはモデルごとに
     別管理のため、切り替えるとセッション全体を一度キャッシュ無しで読み直すコストがかかる。
     **セッション開始直後は切り替えコストがゼロ、中盤以降は高コスト**という非対称性がある。
     実務上：①モデルはセッション開始時に決める ②セッション中の切り替えは、軽い作業が
     まとまってあると分かっている時だけ（AIからは提案せず指示を待つ）③軽い作業を
     まとめて片付けたい日は、新しいセッションを軽いモデルで開始するのがいちばん効く。

6. **重要な決定や仕様は CLAUDE.md に記録する。**
   セッションをまたいでも引き継がれるよう、重要な設計判断・仕様・ルール変更は
   このファイルの適切なセクションに記録すること。記録するタイミングと方法はルール3の
   「マージのたびに該当セクションを上書き更新（upsert）」に従う。

7. **問題点を発見した場合、同様の問題が他にないか必ず確認する。**
   バグ修正・漏れの修正を行う際は、同じパターンの問題が他の箇所にも存在しないか
   コード全体を確認してから修正・コミットすること。
   例：保存パスのフィールド更新漏れ → 別の保存経路すべてを横断的に確認する。
   **このアプリでの実例**：`renderModalFormContent`が日時入力欄を再生成してしまう
   バグを直した際、同種の「動的innerHTML再生成が既入力値を消す」パターンが他の
   モーダル・フォームにもないか確認する、という形で適用する。

8. **セッション開始時に git のコミット作者を設定する。**
   リモート実行環境はセッションごとにコンテナがリセットされ、git 設定が
   消えることがあるため、最初のコミット前に必ず確認・設定すること。
   ```
   git config user.email "noreply@anthropic.com" && git config user.name "Claude"
   ```
   （このリポジトリではコミット作者名は "Claude"、メールは "noreply@anthropic.com" を使う。
   Co-Authored-ByやClaude-Sessionの付記はセッションごとの指示に従う。）

9. **ダイアログ・メッセージボックスは自前実装を使う（Webアプリの場合）。**
   `alert()` / `confirm()` / `prompt()` などブラウザ標準ダイアログは見た目・挙動を
   制御できないため使用禁止とし、代わりにカスタム実装（確認モーダル・入力モーダル・
   トースト通知等）を用意して統一する。
   - **対応済み**（2026-09-12）: `customConfirm()`/`customPrompt()`（`#dialogOverlay`）
     を実装し、全箇所を置き換え済み。新しい確認・入力ダイアログが必要になったら
     これらを使う（ネイティブダイアログへ逆戻りしない）。

10. **機能実装中、他の未着手候補と同時対応できそうな場合は都度提案する。**
    ある機能を実装している最中に、バックログの他の候補と実装基盤（共通ロジック・UI部品等）を
    共有できて効率よく同時対応できそうな場合は、実装を進める前にその都度ユーザーに知らせ、
    対応するかどうかの判断を仰ぐこと。

11. **プロンプトに「確認してください。」「仕様検討」と書かれている場合は、
    すぐに修正・実行を行わず、まず調査だけを行う。**
    調査結果（現状の仕様・処理内容）をユーザーに報告し、不明点があれば併せて質問する。
    その上でユーザーと仕様検討を行い、方針が決まってから初めて修正・実行に着手すること。
    （＝「確認してください」「仕様検討」はコードを変更してよいという指示ではない。
    調査→報告・質問→合意形成→実装、の順序を必ず踏むこと。）
    - **「検討します」「悩んでいます」「アドバイスください」等、ユーザーが明確な決定を
      示していない項目は必ず「未決定（保留）」として扱い、Claude の推奨・意見で勝手に
      結論づけて実装に進めてはならない。** 決定は必ずユーザーの明示的な合意
      （「これで進めて」「OK」「◯案で確定」等）をもって行う。推奨・意見を述べるのは可だが、
      それを合意とみなさない。
    - **複数トピックを一度に扱う場合、確定済みの項目だけを実装し、未決定の項目は保留として
      明示的に残す。** 未決定項目について「たぶんこうだろう」と先回りして進めない。

12. **マージ前に必ず全体を確認する。**
    PRを作成・マージする前に、変更内容の全体を通しで確認し、以下を必ずチェックすること。
    - **冗長**: 不要な重複コード・不要な処理・過剰な実装がないか。
    - **修正誤り**: 意図した箇所が正しく直っているか、別の箇所を壊していないか。
    - **考慮漏れ**: エッジケース・他の呼び出し経路・既存機能への影響。
    確認の結果、**問題（不明点・懸念）があればユーザーに通知する**（不明点は勝手に判断せず
    「仕様検討」として調査・報告・質問する）。**問題がなければマージする。**

13. **（Webアプリの場合）操作用ラベルは選択不可にする。**
    ボタンのラベル文字が長押し等でテキスト選択されたり、iOSのコールアウトが出たりしない
    ようにする。`<button>`以外の要素をボタンとして使う場合は個別に
    `user-select:none`（＋`-webkit-touch-callout:none`）を付けること。
    **このアプリでの対象**: `.category-btn` `.pet-card` `.action-btn` `.pill-btn`
    `.tab-btn`系（`<div>`をボタン代わりに使っている箇所）。現状は未対応 —
    対応時は`docs/backlog.md`に追記して着手する。

14. **問題を解決したら、その解決方法を開発ルール／知見として CLAUDE.md に記載する。**
    バグ・不具合・課題を解決したら、**原因と対処のパターン、再発防止策**を CLAUDE.md に残すこと。
    特に**同種の問題が再発しうるもの**（プラットフォーム制約・CSS詳細度・キャッシュ・タイミング・
    保存経路の網羅漏れ等）は、単なる変更履歴（バージョンコメント）にとどめず、下記
    「よくある落とし穴・対処パターン（知見）」セクションに**再利用できる形**で追記し、次回以降に活かす。
    （ルール2/7/12 と連動：見つけた問題は横展開で調べ、直したらパターンを記録する。）

15. **処理・画面遷移の仕様が統一されていない箇所を見つけたら、勝手に判断せずユーザーに報告し、
    仕様検討する。**
    ある機能を追加・修正する際に、類似の他機能と挙動（画面遷移・保存経路・UI パターン等）が
    統一されていない箇所に気づいた場合は、その場で揃えてしまわず、**まずユーザーに報告し**
    仕様検討を行うこと（ルール11と同じ「調査→報告・質問→合意形成→実装」の流れに乗せる）。

16. **「おすすめ」を提示する前に多角的に考慮する。**
    仕様の選択肢を提示して推奨を述べる際は、先に以下を確認してから推奨を1つに絞ること。
    - **データ・設定の出どころ**：その機能が使う値がどのUIで見えているか。出どころが見える
      場所に操作を置くのが原則。
    - **既存の類似機能との一貫性**：同系統の機能と導線・挙動が揃うか。
    - **画面遷移・戻り先**：開いた画面から自然に戻れるか（ルール15と連動）。
    - **実装コストと回帰リスク**：既存パターン流用可否（ルール1と連動）。
    - **このアプリ特有の観点（無料枠）**：その機能はFirestoreの読み取り・書き込み回数を
      増やさないか。増やす場合は「どのタイミングで」「どの範囲を」読むかを明示し、
      無料枠の運用ルール（`docs/SPEC-v2.md`「無料枠を守るための設計ルール」）に反しないか
      確認する。
    考慮の結果は推奨理由として明示し、ユーザーが判断できる形で提示する。選択肢は闇雲に並べず、
    筋の良い1案に寄せて提示して往復を減らす。

17. **ユーザー向けヘルプ/使い方ドキュメントは、機能を変更するたびの更新に加えて、定期的に実装全体と
    突き合わせて記載漏れ・古い記述を一括で洗い出すこと。**
    個別の変更時の追随だけでは、細かい仕様変更（既定値・操作手順の細部）が都度の更新から
    漏れやすい。定期的に「全体を洗い直す」運用を適用する。
    - **頻度の目安**：一定量のマージごと、またはユーザーから指示があった時。時間で区切らず
      「変更の蓄積量」で判断する。
    - **手順**：①前回の定期監査以降に記録された変更履歴を遡り、ヘルプ更新の有無を洗い出す
      ②ヘルプの各セクションを実際の実装と読み比べ、既定値・操作手順の食い違いを探す
      （該当する定数値をヘルプ側の説明文と突き合わせるのが確実）③見つかった差分をヘルプ側へ
      反映する（版を積まず上書き）。
    - **このアプリでは`docs/SETUP-FIREBASE.md`が実質的なユーザー向けドキュメント**
      （学生本人が行う設定作業の手順書）。手順や既定値（画像圧縮のサイズ・品質、
      無料枠の消費ルール等）を変更したら必ず合わせて更新する。

18. **新しい機能を追加して問題なく動作したら、（プロジェクトの運用に合わせて）マイナーバージョンを
    上げる。上げるタイミングは必ずユーザーに確認すること。**
    パッチ版数は「変更のたびに1ずつ上げる」運用を継続しつつ、**それとは別に「新機能が問題なく
    動作したと確認できたタイミング」ではマイナー（中央の桁）を上げる**、という2段階の運用を
    採用する場合の指針。
    - **「新機能」の目安**：既存機能の軽微な修正・実機フィードバックの微調整・ドキュメント整備
      だけの変更は対象外。仕様検討を経て承認し、実装した新しい操作・画面・設定項目が対象。
    - **「問題なく動作した」の確認手段**：自動検証に加え、可能な場合は実機/実環境での確認を待つ。
      **マイナーを上げてよいかは必ずユーザーに尋ねてから実行する**（AI側の判断だけで上げない）。
    - **このアプリでの注意**: クラウド版の主要フローは2026-09-12に実機で動作確認済み
      （「決着済み事項の索引」参照）。ただし機能を追加・変更した際は、その機能について
      **改めてユーザーが実機のFirebase環境で試した結果を待つ必要がある**
      （自動検証＝構文チェック・ID整合性チェックだけでは確認手段として不十分）。

19. **セッションが長くなりトークン消費が増えてきたら、新しいセッションへの切り替えをユーザーに
    案内する。**
    - **確認のタイミング**：毎ターンは確認しない（無駄なツール呼び出しになる）。1つの機能・修正が
      完了してマージした区切りなど、きりの良いタイミングで確認する。
    - **目安**：使用率が約70%を超えたら「そろそろ新しいセッションへの移行を検討してください」と
      一言添える（作業は止めない・提案のみ）。約85%を超えたら明確に推奨する。
    - **案内する内容**：①現在の使用率の目安 ②新しいセッションでもCLAUDE.md・docsを読めば
      文脈が引き継げること ③作業ブランチは共通なので、新しいセッションでも取得すればそのまま
      続きから始められること。

### No build/lint/test cycle

ビルドプロセスは無い。`public/index.html`を`type="module"`で`app.js`を直接読み込む
構成で、npm/バンドラ/トランスパイラは使わない。ローカル確認は
`cd public && python3 -m http.server 8000` のような簡易サーバーで行う（`file://`直開きは
ESモジュールのCORS制約で動かない）。lintも導入していない。

### Testing approach

自動テストは無い。手動確認が基本。変更時は最低限、以下を実行してから確認・コミットする。

```bash
node --check public/app.js   # 構文チェック
node -e "
const fs=require('fs');
const html=fs.readFileSync('public/index.html','utf8');
const js=fs.readFileSync('public/app.js','utf8');
const ids=new Set([...html.matchAll(/id=\"([^\"]+)\"/g)].map(m=>m[1]));
const refs=[...js.matchAll(/getElementById\(\"([^\"]+)\"\)/g)].map(m=>m[1]);
console.log('missing ids:', [...new Set(refs)].filter(id=>!ids.has(id)));
const calls=[...html.matchAll(/on(?:click|change|input)=\"([a-zA-Z0-9_]+)\(/g)].map(m=>m[1]);
const win=js.match(/Object\.assign\(window,\s*\{([^}]+)\}\);/s)[1].split(',').map(s=>s.trim()).filter(Boolean);
console.log('missing from window export:', [...new Set(calls)].filter(f=>!win.includes(f)));
"
```

Firebase側の実際の動作は、2026-09-12にユーザーの実機Firebase環境で主要フローの
動作確認が取れている（詳細は「決着済み事項の索引」参照）。**それ以外の未確認機能
（CSV/JSON出力、印刷、Hosting公開、記録・体重の編集/削除、権限変更等）は、
実機で確認が取れるまで「未検証」として扱う**（ルール18とも連動）。

### Code Style

- バニラJS、2スペースインデント、コメントは日本語。
- `innerHTML`に動的な値を埋め込む時は**必ず`esc()`を通す**（HTMLエスケープ漏れは
  過去に実際に発生した不具合。下記「よくある落とし穴」参照）。
- `onclick`属性から呼ぶ関数は、ファイル末尾の`Object.assign(window, {...})`に必ず追加する。
- 変更履歴コメントは `/* ★vX.Y.Z: 説明 */` の形式で、変更した理由（何が問題だったか）を含めて書く。
- Firestoreのタイムスタンプ系フィールドは`serverTimestamp()`を使う（クライアント時刻に依存しない）。

## よくある落とし穴・対処パターン（知見）

- **「日付だけ」のフィールドで並び替えると、同じ日に複数回記録した時の順序が
  不定になる**: 体重記録(`weights`)は`date`（`YYYY-MM-DD`、時刻を持たない）だけを
  ソート基準にしていたため、同じ日に複数回記録すると`localeCompare`が同値を返し、
  Firestoreから返ってきたたまたまの順（≒作成順とは限らない）のまま表示される
  不具合を実機で踏んだ。記録(`logs`)側は`recordedAt`（日時までのISO文字列）を
  唯一の基準にする設計が既にあり、それと矛盾する作りになっていた。対策：
  `date`が同じ場合は`createdAt`（`serverTimestamp()`）をタイブレークに使う
  （`sortWeightsAsc()`）。画面・入力欄は変えず内部の並び替えだけを直す最小修正
  （2026-09-12 ユーザー選定）。より厳密に直すなら`logs`同様に体重にも記録時刻を
  持たせる案があるが、体重は1日1〜2回程度が通常のため見送り、必要になれば
  改めて仕様検討する。
- **動的に`innerHTML`で再生成する要素に、ユーザー入力中の値を持たせてはいけない**:
  `renderModalFormContent()`が状態判定(〇/△/✕)切り替えのたびに`#modalFormContent`の
  innerHTMLを再構築する設計だったため、日時入力欄をその中に置いていると再描画で
  入力済みの値が消えてしまう不具合を実際に踏んだ。対策：再描画されるブロックの外に、
  持続させたい入力欄は静的に配置する。
- **`getElementById()`は、その要素がまだDOMに存在しないタイミングで呼ぶとnullを返す
  だけで例外にならず、直後の`.value=...`で初めて`TypeError`になる**:
  `openLogModal()`で、`renderModalFormContent()`が生成する`#modalDate`/`#modalTime`に
  関数呼び出し順を間違えて先にアクセスしてしまう不具合を実際に踏んだ。対策：
  動的生成される要素へのアクセスは、生成関数の呼び出し**後**に置く。
- **HTMLエスケープを忘れると、ダブルクォートを含むメモ1つでその行のボタンが
  丸ごと機能しなくなる**: `onclick="...('${memo}')"`のような文字列組み立てで
  `memo`に`"`が入ると属性が途中で切れ、それ以降の属性・イベントハンドラが壊れる。
  対策：`innerHTML`へ差し込む前に必ず`esc()`を通す（値だけでなく、`data-*`属性に
  差し込む値も同様に注意）。
- **`el.style.display = ""` は、CSSクラスで`display: none`が指定されている要素を
  表示状態には戻せない**: `.editor-only, .admin-only { display: none; }`という
  クラスで隠しておき、ログイン時に`el.style.display = (role条件) ? "" : "none"`で
  出し分けようとしたところ、adminでログインしても「個体を登録する」ボタン等が
  一切表示されない不具合を実機で踏んだ。`style.display=""`は「インライン指定を
  外す」だけで、外した結果はCSSのカスケードに戻るため、`.editor-only`クラスの
  `display:none`がそのまま効いてしまう。加えて、タイムライン・体重履歴・ゴミ箱の
  編集/削除ボタンのように**画面遷移のたびにinnerHTMLで動的に生成される要素**は、
  ログイン時に一度だけ実行される`querySelectorAll(".editor-only")`のループの
  対象にそもそも含まれず、常に非表示のままになる、というより根の深い問題もあった。
  対策：①CSS側の`display:none`指定はやめる ②静的な要素は`el.hidden = 真偽値`
  （`hidden`属性。ブラウザ標準の`[hidden]{display:none}`が効くため、
  要素本来の`display`値に関わらず確実に隠せる）で出し分ける ③動的に生成する要素は
  `canEdit()`/`isAdminRole()`のようなヘルパー関数を用意し、**描画する文字列を
  組み立てる時点で権限に応じてボタンのHTML自体を含めるかどうかを判定する**
  （生成後にDOM側で後から隠そうとしない）。
- **Firestoreのセキュリティルールで「フィールド単位の権限」を作る時は`diff().affectedKeys()`
  を使う**: 「個体の削除(`deletedAt`変更)だけはadmin限定、他の編集はstaffも可」を
  実現するのに、`update`ルールを`isAdmin() || (isEditor() && !diff(...).affectedKeys().hasAny(['deletedAt']))`
  の形で書いた。UI側の見た目の制限（ボタンを隠すだけ）と、ルール側の実効的な制限を
  両方揃えないと、「隠しているだけで実際は誰でも実行できる」状態になる。
- **Firebase Authでユーザーを作成すると、作成した側のセッションが新規ユーザーに
  切り替わる**: 管理者が職員を追加する機能で、そのまま`createUserWithEmailAndPassword`
  すると管理者自身がログアウトされる。対策：セカンダリの`initializeApp()`インスタンス
  （別名を付けて2つ目のFirebaseAppを作る）でユーザー作成だけを行い、完了したら
  `deleteApp()`で片付ける。
- **`createUserWithEmailAndPassword`が成功した瞬間に`onAuthStateChanged`が発火し、
  まだ後続のFirestore書き込み(`setDoc`)が終わっていないタイミングで割り込む**:
  施設の新規登録画面で実際に踏んだ不具合。`onAuthStateChanged`が「`users/{uid}`が
  まだ無い」と判断して`signOut()`してしまい、登録処理内で並行して実行中だった
  残りの`setDoc`が認証切れで宙に浮き、ボタンが「登録中...」のまま永久に固まった
  （エラーも出ない）。ログイン処理でも同様に、施設コードの検証（`loginWithFacility`
  内）が終わる前に`onAuthStateChanged`が先に`screenHome`へ遷移してしまう
  （検証失敗時に一瞬だけ見えてすぐ戻される）という軽微な副作用があった。
  対策：`authFlowInProgress`のようなフラグを用意し、`registerFacility`/
  `loginWithFacility`の実行中は`onAuthStateChanged`のメイン処理を止める。
  画面遷移などその処理が本来担っていたロジックは`afterSignedIn(fbUser)`という
  関数に切り出し、`registerFacility`/`loginWithFacility`が完了した直後に
  呼び出し元から明示的に呼ぶ。**`onAuthStateChanged`のコールバックとその契機となった
  自分自身の処理（サインアップ・サインイン関数）は非同期に競合しうる**、という
  一般的な教訓として憶えておく。
- **`facilityId`を自由入力にすると、他人の施設IDを名乗って自分をadminとして
  登録できてしまう**: `users/{uid}`作成ルールで`role=='admin'`の自己登録を無条件に許すと、
  誰でも既存の`facilityId`を指定してadminになりすませる。対策：新規施設の`facilityId`を
  **設立者のuidそのもの**にする設計にし、ルールで`facilityId == request.auth.uid`を
  必須化する（他人のuidを名乗ることはできないため、構造的に防げる）。
- **Firestoreの無料枠は「読み取り回数」が最初に尽きる**: 一覧画面で全個体の記録を
  横断的に読みに行く実装（旧プロトタイプの検索機能がこれに該当していた）は、
  個体数・記録数が増えると読み取り回数を静かに消費し続ける。対策：各画面は
  「今見ている範囲」だけを`onSnapshot`で購読し、画面を離れたら`stopListener()`で
  確実に解除する。施設全体を読む操作（全データバックアップ等）は、自動実行せず
  ユーザーが明示的に押すオンデマンド操作として切り離す。
- **Firebaseの「Sparkプラン(無料・カード登録不要)のみで完結」は、Cloud Storageに関しては
  もう成立しない**: Googleの仕様変更により、新規FirebaseプロジェクトはCloud Storageを
  有効化する際にBlazeプラン（従量課金・カード登録必須）へのアップグレードを要求される
  （2026-09時点で確認）。「無料枠のみ・カード登録不要」を設計の前提にする時は、
  実際にコンソールで各サービスを有効化する画面を確認するまで確定事項として
  ドキュメント化しない（Authentication・Firestoreは引き続きSparkのままで使えており、
  Storageだけが対象という非対称な変更だった）。対策：Blazeへのアップグレード自体は
  「即課金」ではない（利用量が無料枠内なら請求0円）ので、予算アラートを低いしきい値で
  設定することとセットで提案する。
- **Cloud Storageのバケット作成時、「すべてのロケーション」でFirestoreと同じ
  asia-northeast1を選ぶと、GCSの「Always Free」無料枠の対象外になる**:
  Always Free対象は米国の一部リージョンのみで、東京リージョンは対象外。
  対策：Storageのバケット作成画面で**「料金不要のロケーション」（US-EAST1固定）を
  選ぶ**。Storage と Firestore はリージョンが違っても機能的な問題はない
  （多少のレイテンシ増のみ）。「他サービスとリージョンを揃える」という一般論より
  「無料枠を守る」ことを優先する（本アプリの決着済み方針）。
- **`docs/SETUP-FIREBASE.md`のコマンドに`# コメント`を行末に付けると、Windowsの
  コマンドプロンプト(cmd.exe)ではエラーになる**: `npm install -g firebase-tools  # 初回のみ`
  のような書き方はbash（Mac/Linux）では`#`以降がコメットとして無視されるが、
  **cmd.exeは`#`を認識せずコマンドの一部として渡してしまい**、
  `Invalid tag name "#"`のようなエラーになる。学生の開発環境はWindowsであることを
  踏まえ、対策：セットアップ手順書のコマンドは①行末コメントを付けない
  ②コマンドの説明はコードブロックの外（前後の地の文）に書く ③OSで挙動が違う
  コマンド（`cp`/`copy`、`python3`/`python`）は両方を明記する。

- **`public/`配下に新しいファイルを追加しても、ローカルで`git pull`してから
  デプロイしないと公開サイトに反映されない**: `public/guide/`配下に説明ページを
  2つ追加してGitHubにpushした後、担当者側で`firebase deploy --only hosting`を
  実行したにもかかわらず、該当URL（`/guide/migration.html`）にアクセスすると
  アプリ本体（`index.html`）の認証読み込み中画面が表示される不具合を実機で踏んだ。
  原因は`firebase.json`の設定ではなく、**担当者のパソコンがGitHub Desktopを
  使っておらず、`git pull`で最新の変更を取り込む前に`firebase deploy`を実行して
  いたため、ローカルの`public/`フォルダにそのファイルがそもそも存在しなかった**こと。
  ファイルが存在しないURLへのアクセスはFirebase HostingのSPA用キャッチオール
  rewrite（`"source": "**" → "/index.html"`）に吸収されるため、見た目上は
  「ルーティングが壊れている」ように見えるが、実際は「ファイルが無いだけ」という
  地味な原因だった。対策：`public/`配下にファイルを追加・変更した後は、
  ①`git pull`（またはGitHub Desktopの場合はFetch/Pull origin）を実行→
  ②ローカルのフォルダに実際にファイルが存在することを確認→③`firebase deploy`、
  の順序を必ず徹底するよう案内する。「デプロイしたのに反映されない」報告を
  受けたら、まずrewrite設定を疑う前に、ローカルの取り込み漏れを疑うこと。

- **タイムゾーンはJST固定**。`recordedAt`は常に`+09:00`を明示的に付与して保存する
  （ブラウザのローカルタイムゾーンに依存しない）。
- **Firebase接続設定 (`public/firebase-config.js`) の値（APIキー等）は公開して問題ない
  値**（Firebase公式が「秘密情報ではない」と明記）。実効的なアクセス制御は
  `firestore.rules`/`storage.rules`が担う。**このファイルに実際の秘密情報
  （サービスアカウントキー等）を置いてはならない**（そもそも本アプリでは
  クライアントSDKのみを使い、サービスアカウントキーは使わない設計）。
- **Cloud Functionsは使わない**（クライアント側処理＋セキュリティルールで完結させる
  方針のため。「決着済み事項の索引」参照）。サーバーサイド処理が必要に見える要件が
  出てきたら、まずクライアント側＋セキュリティルールで実現できないかを検討し、
  それでも不可能な場合はユーザーに確認してから進める。
- **プロジェクトはBlazeプラン（カード登録済み）で運用している**（Cloud Storageが
  Sparkプランで有効化できないため。「決着済み事項の索引」参照）。Cloud Functions等
  従量課金が発生しうる機能を新たに使う提案をする時は、無料枠に収まる設計か、
  予算アラートの設定状況を必ず確認する。「カード登録不要」という当初の前提は
  Storageに関してはもう成立しないので、ドキュメントや会話で再度前提として使わない。
- **写真は必ずクライアント側で圧縮してからアップロードする**（`compressImage()`。
  長辺1280px・JPEG品質0.7）。この処理を経由しないアップロード経路を新設しないこと
  （Storage無料枠5GBを守るための必須ルール）。
- **クラウド版の主要フローは2026-09-12にユーザーの実機Firebase環境で動作確認済み**
  （施設登録・ログイン・個体登録+写真アップロード・記録追加・検索・ゴミ箱の削除/復元・
  職員追加+ログイン。詳細は「決着済み事項の索引」参照）。CSV/JSON出力・印刷・Hosting
  公開・記録や体重の編集/削除・権限変更はまだ未確認。

## Common Tasks

### 記録カテゴリ・タグを追加する
`public/app.js`の`categoryTagMap`に判定(`〇`/`warn`)ごとのタグ配列を追加し、
`public/index.html`の`.action-grid`に対応するボタン（`onclick="openLogModal(null, 'カテゴリ名')"`）
を追加する。

### 個体のフィールドを追加する
`public/index.html`の`#screenAdd`に入力欄を追加 → `public/app.js`の
`openAddAnimalScreen()`（編集時の値の反映）と`saveAnimalForm()`（保存するデータへの追加）
の**両方**を更新する（片方だけ直すと「保存されない」「編集時に空欄になる」不具合になる。
ルール7の横展開確認の対象）。`docs/specs.md`のデータモデルも合わせて更新する。

### Firestoreの新しいコレクション・フィールドを追加する
1. `docs/specs.md`のデータモデルを更新
2. `firestore.rules`（必要なら`storage.rules`も）に権限ルールを追加し、
   「誰が読めて誰が書けるか」をコメントで明記する
3. `app.js`側の購読・書き込み処理を実装する際、**無料枠の読み取り回数を増やさないか**
   （ルール16の「無料枠」観点）を確認する
4. `docs/SETUP-FIREBASE.md`にインデックス作成等の追加手順が必要なら追記する

### Firebase環境で動作確認する
`docs/SETUP-FIREBASE.md`の手順を参照。ユーザー本人がFirebaseプロジェクトを用意する
必要がある（このセッションからは代理作成できない）。
