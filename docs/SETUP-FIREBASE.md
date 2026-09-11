# クラウド版セットアップ手順（Firebase 無料枠）

対象: `public/` フォルダのクラウド連携版アプリ
料金: **0円**（Firebase Spark プラン。クレジットカード登録は不要）

このアプリは Cloud Functions を使わず、ブラウザ（クライアント）側の処理と
Firestore/Storage のセキュリティルールだけで動作します。以下の手順は
すべて Firebase コンソール（ブラウザ）上の操作で完結します。

---

## 1. Firebase プロジェクトを作成する

1. https://console.firebase.google.com/ を開き、Googleアカウントでログイン
2. 「プロジェクトを追加」→ プロジェクト名を入力（例: `animedirec`）
3. Googleアナリティクスは「今は設定しない」でOK（無料枠の使用に影響しません）
4. 作成が終わるまで待つ

> **料金プランについて**: 新規プロジェクトは初期状態で無料の **Spark プラン** です。
> このアプリは Spark プランのままで完結するよう設計されているため、
> 「Blaze プランにアップグレード」の案内が出ても進める必要はありません。

## 2. Authentication（ログイン機能）を有効化する

1. 左メニュー「構築」→「Authentication」→「始める」
2. 「Sign-in method」タブ →「メール / パスワード」を選択 → 有効にする → 保存

## 3. Firestore Database（データ保存）を有効化する

1. 左メニュー「構築」→「Firestore Database」→「データベースの作成」
2. モード: **本番環境モード** を選択（セキュリティルールは後で反映します）
3. リージョン: `asia-northeast1`（東京）を推奨 → 有効にする

## 4. Cloud Storage（写真保存）を有効化する

1. 左メニュー「構築」→「Storage」→「始める」
2. 本番環境モードのまま → リージョンは Firestore と同じ `asia-northeast1` を推奨 → 完了

## 5. ウェブアプリを登録し、接続情報を取得する

1. プロジェクトの概要ページ（左上の歯車アイコンの少し下）→「</>」（ウェブ）アイコンをクリック
2. アプリの名前を入力（例: `animedirec-web`）。Firebase Hosting はここでは設定しなくてOK
3. 表示される `firebaseConfig = { apiKey: ..., authDomain: ..., ... }` の値をコピー

4. このリポジトリの `public/firebase-config.js` を開き、コピーした値で置き換える

```js
export const firebaseConfig = {
  apiKey: "コピーした値",
  authDomain: "コピーした値",
  projectId: "コピーした値",
  storageBucket: "コピーした値",
  messagingSenderId: "コピーした値",
  appId: "コピーした値"
};
```

> **この値は公開して問題ありません。** Firebase公式もこの値を「秘密情報ではない」と
> 明記しています。実際のアクセス制御は次の手順で反映する `firestore.rules` /
> `storage.rules`（施設・権限のチェック）が行っています。

## 6. セキュリティルールを反映する

Firebase CLI（コマンドラインツール）を使います。パソコンに Node.js がインストールされていれば実行できます。

```bash
npm install -g firebase-tools     # 初回のみ
firebase login                    # ブラウザが開くのでGoogleアカウントでログイン

cd animedirec                     # このリポジトリのルートフォルダで実行
cp .firebaserc.example .firebaserc
# .firebaserc を開き、default の値を手順1で作成したプロジェクトIDに書き換える

firebase deploy --only firestore:rules,storage:rules
```

これで `firestore.rules` と `storage.rules` が反映されます。
（コンソールの「Firestore Database」→「ルール」タブ、「Storage」→「Rules」タブに
直接コピー＆貼り付けして「公開」する方法でも同じ結果になります。CLIが使えない場合はこちらでもOKです。）

## 7. 動作確認（ローカル）

`public` フォルダをそのままブラウザで開いても、`type="module"` の都合上
`file://` では動作しません（CORSエラーになります）。簡易サーバーを立てて確認してください。

```bash
cd animedirec/public
python3 -m http.server 8000
# ブラウザで http://localhost:8000 を開く
```

初回は「施設を新規登録」から施設・管理者アカウントを作成してください。
登録後に表示される「施設コード」を、以降のログイン・職員招待に使います。

## 8. インターネット上に公開する（Firebase Hosting・無料）

```bash
cd animedirec
firebase deploy --only hosting
```

コマンド実行後に表示されるURL（`https://<プロジェクトID>.web.app` など）が、
スマホ・PC・タブレットからアクセスできる本番URLになります。

---

## 無料枠を超えないための注意（運用ルール）

- 写真は自動で圧縮してからアップロードされます（コードを変更しないでください）
- 施設全体のバックアップ（「職員管理」→「全データバックアップ」）は、実行するたびに
  全記録を読み込みます。**月1回程度の実行にとどめてください**
- 無料枠の使用状況は Firebase コンソールの「使用状況とお支払い」から確認できます

## うまく動かないときは

- ログインできない: メール/パスワード認証を有効化したか（手順2）を確認
- 個体一覧が表示されない: `firestore.rules` を反映したか（手順6）を確認。
  ブラウザの開発者ツール（F12）の Console タブにエラーが表示されます
- 写真が保存されない: Storage を有効化したか（手順4）、`storage.rules` を
  反映したか（手順6）を確認
- ゴミ箱やCSV出力でエラーが出る: Firestoreコンソールにインデックス作成を促す
  リンクが表示されることがあります。そのリンクをクリックして作成してください
