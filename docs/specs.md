# 実装済み機能の現行仕様（動物健康管理アプリ クラウド版）

対象: `public/`（Firebase無料枠版）。`index.html`（サーバー不要のプロトタイプ）は凍結扱いで、
このファイルの対象外（プロトタイプの仕様は当時のまま・更新しない）。

このファイルは **upsert 専用**（CLAUDE.md ルール3）。マージのたびに該当セクションを
「今の最終仕様」に書き換える。変更履歴は git log と版数コメントに任せる。

---

## 認証・施設・権限（①）

- ログイン: 施設コード＋メールアドレス＋パスワード（`loginWithFacility()`）。
  施設コードは `facilityCodes/{code} -> facilityId` の解決に使い、
  ログインしたuserの`facilityId`と一致しない場合はエラーにしてサインアウトする
  （＝メール/パスワードが合っていても施設コードが違えばログインできない）。
- 新規施設登録: `registerFacility()`。作成した施設の `facilityId` は
  **設立者(最初のadmin)のuidと同一** にする設計（他施設IDを騙って自分をadminとして
  登録するのを防ぐため。詳細は `firestore.rules` のコメント参照）。
- 権限は3種: `admin`(管理者) / `staff`(職員) / `viewer`(閲覧のみ)。無効化は`disabled`。
  - UI側: `.editor-only`(admin+staff表示) / `.admin-only`(admin表示) クラスで出し分け
    （`onAuthStateChanged`内で毎ログイン時に付け替え）。
  - 実効的な権限境界は **Firestore/Storageのセキュリティルール側**（UIはあくまで見た目の制御）。
    個体の削除(`deletedAt`変更)・物理削除はadmin限定、それ以外の編集はadmin/staff可、
    閲覧は全ロール可。
- 職員追加: `inviteStaff()`。管理者自身のログインセッションを保ったまま新規アカウントを作るため、
  **セカンダリのFirebaseAppインスタンス**で`createUserWithEmailAndPassword`する
  （通常のAuth SDKはユーザー作成と同時にそのユーザーへセッションが切り替わってしまうため）。
- 職員の権限変更・無効化: `screenStaff`の`<select data-role-select>`から。管理者のみ。

## 個体管理（②）

- 個体は施設配下の `facilities/{facilityId}/animals/{animalId}` に1件ずつ保存。
- **個体管理番号 (`code`)**: 任意入力。保存前に`checkCodeDuplicate()`で施設内の重複を確認し、
  重複していれば保存を止める（論理削除済みの個体の番号は再利用可）。
- カテゴリ（犬・猫／哺乳類／爬虫類・両生類／げっ歯類／鳥類／その他）ごとに一覧を分けて表示。
  犬・猫カテゴリのみ「犬/猫」のサブタイプ選択がある。
- 個体一覧の「⚠️要観察」バッジは、**その個体の詳細画面を開いたときに直近7日以内の△✕記録の
  有無を計算し、`animals`ドキュメントの`_warn`フィールドに書き込んで**表示している
  （一覧を出すたびに全個体の記録を読みに行くと無料枠の読み取り回数を消費するため。
  そのため、記録を追加してから一度も詳細を開いていない個体では、バッジが最新化されない
  制約がある＝既知の制約。docs/backlog.md参照）。

## 記録（タイムライン）

- 記録は `animals/{id}/logs/{logId}` サブコレクション。カテゴリ: 排泄物／食事・嘔吐／
  元気・様子／爪切り／投薬・通院／自由備考。状態判定は 〇（良好）／△（やや気になる）／
  ✕（悪い・異常）の3段階。判定に応じてタグの選択肢が切り替わる（`categoryTagMap`）。
- **記録日時 (`recordedAt`)**: `YYYY-MM-DDTHH:MM:00+09:00` のISO文字列に日付・時刻を
  必ず一元化して保存する。一覧・検索・グラフはすべてこの文字列を並べ替えの基準にする
  （＝過去日を後から登録しても時系列が崩れない。旧プロトタイプの不具合の修正）。
  記録日・時刻はモーダル内で毎回手入力できる（既定値: 新規=選択中の日付＋現在時刻、
  編集=既存の値）。
- タイムライン画面には「日付ピッカー」と「朝/昼/夜」の時間帯タブがあり、
  その日その時間帯の記録だけを表示する。
- **個体内検索** (`setDetailSearch`): 開いている個体の記録（カテゴリ・タグ・備考）を
  キーワードで検索する。この検索は**既にFirestoreから読み込んでキャッシュしている
  その個体のログのみ**を対象にする（施設全体の記録を横断検索する機能ではない。
  無料枠の読み取り回数を守るための仕様。旧プロトタイプからの意図的な仕様変更）。
- 写真は撮影・選択時にクライアント側で圧縮（長辺1280px・JPEG品質0.7）してから
  Cloud Storageへアップロードする（`compressImage()` → `uploadPhoto()`）。

## 体重（⑦）

- 体重は `animals/{id}/weights/{weightId}` に日付ごとに記録。**内部は常にグラムの整数**で
  保持し、個体ごとの`weightUnit`(`kg`|`g`)は表示・入力の単位切替にのみ使う
  （`toGrams()`/`formatWeight()`/`gramsToInputValue()`）。カテゴリからの単位初期値の提案は
  `suggestWeightUnit()`（犬・猫→kg、それ以外→g）。
- `animals`ドキュメントの`latestWeightGrams`は一覧表示用の最新値キャッシュ。
  体重を追加・編集すると都度更新する。
- 折れ線グラフは`weights`サブコレクションを日付昇順に並べてCanvasで描画（`renderWeightChart()`）。
  並び順は`date`（日付のみ）→同じ日付なら`createdAt`（作成時刻）の順でソートする
  （`sortWeightsAsc()`）。体重は時刻を持たないため、同日に複数回記録した場合の
  順序保証は「作成順」であり、実際に測定した時刻の前後関係ではない点に注意
  （必要になれば記録時刻を持たせる仕様に拡張する。docs/backlog.md参照は不要、
  CLAUDE.mdの落とし穴参照）。

## 削除・ゴミ箱（⑤）

- 個体・記録・体重はすべて論理削除（`deletedAt`に`serverTimestamp()`をセット）。
  一覧・タイムライン等のクエリは`where('deletedAt','==',null)`で除外する。
- ゴミ箱画面（`openTrashScreen()`）は個体のみ対象（記録・体重の個別ゴミ箱UIは未実装。
  docs/backlog.md参照）。「復元」はeditor(admin/staff)可、「完全削除」はadmin限定。
- 個体の`deletedAt`変更（削除・復元）は`firestore.rules`側でもadmin限定に強制している
  （`diff().affectedKeys()`でdeletedAtフィールドの変更だけを判別）。
- 削除・完全削除・全データバックアップ等の確認は、ブラウザ標準の`confirm()`/
  `prompt()`ではなく**自前ダイアログ**（`customConfirm()`/`customPrompt()`、
  `#dialogOverlay`）を使う（CLAUDE.mdルール9）。個体削除は個体名を入力させる
  `customPrompt()`、それ以外は`customConfirm()`。

## エクスポート（⑧）

- 個体一覧CSV（`exportAnimalListCSV`）: 一覧画面から。既に読み込んでいる個体一覧のみ対象。
- 個体別の記録CSV（`exportCurrentAnimalCSV`）・JSONバックアップ（`exportCurrentAnimalJSON`）:
  詳細画面から。開いている個体の記録・体重のみ対象。
- 施設全体JSONバックアップ（`exportFacilityBackupJSON`）: 職員管理画面（admin向け）。
  **実行時に施設内の全個体・全記録・全体重を読み込む**ため、無料枠の読み取り回数を
  明確に消費するオンデマンド操作として位置づける（自動実行・定期実行はしない）。
- CSVはUTF-8 BOM付き・CRLF・値のクォート処理済み（`toCSV()`/`csvCell()`。Excelでの文字化け対策）。
- 印刷用カルテ（`printAnimalChart()`）: 個体の基本情報＋直近30件の記録を`#printArea`に
  組み立てて`window.print()`を呼ぶ。`@media print`で他要素を隠す。PDF専用ライブラリは未使用。

## データモデル（Firestore）

```
facilityCodes/{code}                    { facilityId }
facilities/{facilityId}                 { name, code, createdAt }
users/{uid}                             { facilityId, name, email, role, createdAt }
facilities/{facilityId}/animals/{id}
  { code, name, category, type, breed, sex, birthAccuracy, birthDate, arrivedAt,
    area, build, personality, history, hospitalName, hospitalTel, hospitalMemo,
    weightUnit, latestWeightGrams, photoPath, photoURL, _warn,
    createdAt, createdBy, updatedAt, updatedBy, deletedAt }
  /logs/{logId}
    { recordedAt, timezone, category, statusFlag, tags[], memo, photoPath, photoURL,
      recordedBy, recordedByName, createdAt, updatedAt, deletedAt }
  /weights/{weightId}
    { date, grams, recordedBy, createdAt, deletedAt }
```

セキュリティルールは `firestore.rules` / `storage.rules`（コメント付き）が正。
このファイルとルールファイルの記述が食い違ったら、ルールファイルを正として
このファイルを更新すること。

## アイコン・PWA表示

- `public/manifest.json` でアプリ名・テーマカラー（`#38C6A3`）・背景色（`#FAF6EE`）・
  アイコンを定義。ブラウザタブ（`favicon.ico`／`icons/favicon-{16,32}.png`）、
  iOSの「ホーム画面に追加」（`icons/apple-touch-icon.png`、180px）、
  Android等のPWAインストール（`icons/icon-{192,512}.png`）に対応。
- アイコン画像はユーザー提供のロゴから`Pillow`で各サイズを生成したもの
  （元画像は1254×1254px）。ロゴを差し替える場合は同じサイズ構成
  （16/32/48/180/192/512px）で作り直し、同じファイル名で上書きする。
- Firebase Hostingの`rewrites`（SPA用キャッチオール）より静的ファイルの配信が
  優先されるため、`firebase.json`側の設定変更は不要。

## 説明資料（ガイドページ）

- `public/guide/overview.html`（アプリのつくりかた）・`public/guide/migration.html`
  （新しいGitHub/Firebaseへの引っ越し手順）を、アプリ本体とは独立した単独HTMLページ
  として同梱している。アプリからのリンクは無く、URLを直接知っている人（システム
  担当者・施設の担当者）向け。
- デプロイ後のURL: `https://<プロジェクトID>.web.app/guide/overview.html` /
  `.../guide/migration.html`。
- 内容は「動物健康管理アプリのつくりかた」「動物健康管理アプリ お引っ越しガイド」
  という2つの説明用アーティファクトを元にしている。アーティファクト側を更新した
  場合は、この2ファイルにも反映すること（自動同期はされない）。
- 新規追加時、公開直後に該当URLへアクセスすると認証読み込み中の画面が表示される
  不具合を実機で踏んだ。原因は`public/`配下へのファイル追加を`git pull`で
  ローカルに取り込む前にデプロイしていたため（詳細は`CLAUDE.md`の
  「よくある落とし穴」参照）。

## 未実装・既知の制約

`docs/backlog.md` を参照。
