# 引っ越しガイド（新しいGitHub・Firebaseへの移行）

対象読者: プログラミング未経験の学生（卒業実習でこのアプリを引き継ぐ人向け）。
パソコンに何も入っていない「完全ゼロ」の状態から、以下がすべて完了するまでを説明する。

- 新しいGitHubアカウントに、このアプリのソースコードを引っ越す
- 新しいFirebaseプロジェクトを作り、アプリと接続する（**データは引き継がない。空の状態から開始**）
- 自分のパソコンで動作確認し、インターネット上に公開する

これ以降のメンテナンス（機能追加・不具合修正）は、引っ越し先の環境で学生自身が行う前提。

このファイルは **upsert専用ではない**（`docs/specs.md`等と違い、手順書として一度きりの
移行作業を記録する性質のため）。内容が古くなったら書き換えて構わない。

---

## この作業の全体像

```
① アカウントを2つ用意する    GitHubアカウント / Googleアカウント
② パソコンに道具を入れる     Git（またはGitHub Desktop）/ Node.js
③ GitHubへ引っ越す           新しいリポジトリを作り、ソースコードを移す
④ Firebaseを新しく作る       Authentication / Firestore / Storage を新規作成
⑤ 接続情報を書き換える       public/firebase-config.js を新しい値に
⑥ 手元で動作確認する         簡易サーバーで localhost 確認
⑦ インターネットに公開する   firebase deploy --only hosting
```

**引き継がないもの**: 現在のFirebaseプロジェクトに入っている動物の記録・写真データ。
新しい環境はまっさらな状態から使い始める（後から必要になった場合は別途相談する）。

---

## ① アカウントを2つ用意する

### GitHubアカウント

1. https://github.com/ を開き、右上「Sign up」
2. メールアドレス・パスワード・ユーザー名を入力し、案内に従って進める
3. メールに届く確認コードを入力すれば完了（無料プランでよい）

### Googleアカウント

Firebase（後述）はGoogleアカウントでログインして使う。すでに持っていることが多いが、
無ければ https://accounts.google.com/signup から新規作成する。

---

## ② パソコンに道具を入れる

### GitHub Desktop（推奨・初心者向け）

コマンド入力が不要な、画面操作だけでGitHubを使えるアプリ。

1. https://desktop.github.com/ からダウンロード・インストール
2. 起動したら「Sign in to GitHub.com」から①で作ったGitHubアカウントでログインする

> コマンド操作（`git`コマンド）に慣れている人は、GitHub Desktopの代わりに
> [Git for Windows](https://git-scm.com/) を入れてコマンドラインで操作してもよい。
> 以降の手順はGitHub Desktopでの操作を基準に説明する。

### Node.js

Firebaseを操作する道具（Firebase CLI）を動かすために必要。

1. https://nodejs.org/ を開き、**LTS版**をダウンロード・インストール（既定設定のままでよい）
2. インストール後、コマンドプロンプト（Windowsキー→「cmd」と入力）で確認する

```
node --version
npm --version
```

バージョン番号が表示されればOK。

---

## ③ GitHubへ引っ越す

### 3-1. 今のソースコードを手に入れる

今のリポジトリ（`e-bluewave/AniMediRec`）を開き、「Code」ボタン →
「Download ZIP」でソースコード一式をダウンロードし、パソコンの分かりやすい場所
（例: デスクトップ）に展開（解凍）する。

### 3-2. 新しいリポジトリを作る

1. GitHub Desktopのメニュー「File」→「New repository...」
2. Name（例: `AniMediRec`）を入力
3. Local Path で、3-1で展開したフォルダを選択
   - すでに中身が入っているフォルダを指定すると「このフォルダは空ではありません」と
     聞かれるので、「Add existing repository instead」に進む
4. 「Create repository」（または「Add repository」）

### 3-3. GitHub上に公開する

1. GitHub Desktop画面上部の「Publish repository」ボタンを押す
2. ログインした新しいアカウント名になっていることを確認
3. 「Keep this code private」のチェックは、学外に公開したくなければ入れたままにする
4. 「Publish repository」を押す

これで新しいGitHubアカウントの下に、ソースコード一式が入ったリポジトリが完成する。
以降、ファイルを変更するたびに GitHub Desktop 画面下の「Summary」欄に変更内容を一言書き、
「Commit to main」→「Push origin」の2ステップで変更を記録・反映していく。

---

## ④ Firebaseを新しく作る

ここからは新しいFirebaseプロジェクトを一から作る。手順は基本的に
`docs/SETUP-FIREBASE.md` の1〜7と同じだが、「新しいプロジェクトを新規作成する」点が異なる。

### 4-1. プロジェクトを作成する

1. https://console.firebase.google.com/ を開き、Googleアカウントでログイン
2. 「プロジェクトを追加」→ プロジェクト名を入力（例: `animedirec-新しい名前`）
3. Googleアナリティクスは「今は設定しない」でよい

### 4-2. Authentication（ログイン機能）を有効化する

左メニュー「構築」→「Authentication」→「始める」→「Sign-in method」タブ→
「メール / パスワード」を有効にする→保存。

### 4-3. Firestore Database を有効化する

左メニュー「構築」→「Firestore Database」→「データベースの作成」→
エディション: Standard → モード: 本番環境モード → リージョン: `asia-northeast1`（東京）
でよい → 有効にする。

### 4-4. Cloud Storage を有効化する（Blazeプランへのアップグレードが必要）

1. 左メニュー「構築」→「Storage」→「Storageを使用するには、プロジェクトの料金プランを
   アップグレードしてください」と出るので「プロジェクトをアップグレード」
2. **Blazeプラン**（従量課金プラン）へアップグレードする。ここでクレジットカードの登録が
   必要になる
3. アップグレード後、「Storage」→「始める」→「デフォルトバケットのセットアップ」で
   **「料金不要のロケーション」（US-EAST1固定）を選ぶ**（東京リージョンは無料枠の対象外の
   ため。詳しくは`docs/SETUP-FIREBASE.md`の該当コラム参照）

4. 続けて、予算アラートを必ず設定する。
   https://console.cloud.google.com/billing → 対象の請求先アカウント→
   「予算とアラート」→「予算を作成」→予算額を少額（例: 100〜500円）に設定→
   しきい値50%・90%・100%で通知が来るようにする。

> カード登録＝即課金ではない。利用量が無料枠内であれば請求は0円。
> 予算アラートは「万一の使いすぎにすぐ気づく」ための安全装置。

### 4-5. ウェブアプリを登録し、接続情報を取得する

1. プロジェクト概要ページ →「</>」（ウェブ）アイコン→アプリの名前を入力
   （Firebase Hostingの設定はここではしなくてよい）
2. 表示される `firebaseConfig = { apiKey: ..., ... }` の6つの値をコピーする
   （次の⑤で使う）

---

## ⑤ 接続情報を書き換える

新しいリポジトリの `public/firebase-config.js` を開き、④-5でコピーした値に置き換える。

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

保存したら、GitHub Desktopで「Commit to main」→「Push origin」して変更を記録する。

### セキュリティルールを反映する

コマンドプロンプトで、リポジトリのフォルダに移動してから実行する。

```
npm install -g firebase-tools
firebase login
```

（ブラウザが開くのでGoogleアカウントでログインする）

```
copy .firebaserc.example .firebaserc
```

作成された `.firebaserc` をテキストエディタで開き、`default` の値を
④-1で作ったプロジェクトIDに書き換えて保存する。その後、

```
firebase deploy --only firestore:rules,storage:rules
```

を実行すると、`firestore.rules`・`storage.rules`（このリポジトリに元から入っている
権限ルール）が新しいプロジェクトに反映される。

> **Windows注意**: コマンドは1行ずつ実行し、行末に`#`から始まる説明は付けない
> （Windowsのコマンドプロンプトは`#`をコメントとして扱わずエラーになる）。

---

## ⑥ 手元で動作確認する

```
cd public
python -m http.server 8000
```

（`python`が見つからない場合は`python3`または`py`を試す）

ブラウザで `http://localhost:8000` を開き、「施設を新規登録」から施設・管理者アカウントを
作成して、記録の追加などひととおり試す。

---

## ⑦ インターネットに公開する

```
firebase deploy --only hosting
```

実行後に表示されるURL（`https://<プロジェクトID>.web.app`）が本番URL。
スマホ・PC・タブレットからアクセスできる。

---

## これからのメンテナンスの流れ（引っ越し後）

1. ソースコードを直す（`public/index.html`・`public/app.js`など）
2. GitHub Desktopで変更内容を確認し、Summaryに一言書いて「Commit to main」
3. 「Push origin」でGitHub上のリポジトリに反映
4. アプリの見た目・動きを変えた場合は、手元で動作確認（⑥）してから
5. 本番に反映する場合は `firebase deploy --only hosting` を実行

Firestoreのルール（`firestore.rules`）やStorageのルール（`storage.rules`）を変更した
場合のみ、`firebase deploy --only firestore:rules,storage:rules` も忘れずに実行する。

## うまく動かないときは

`docs/SETUP-FIREBASE.md` の「うまく動かないときは」セクションを参照
（新しいプロジェクトでも原因の切り分け方は同じ）。
