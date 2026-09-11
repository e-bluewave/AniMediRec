// ============================================================
// Firebase 接続設定
// ------------------------------------------------------------
// docs/SETUP-FIREBASE.md の手順で作成した、自分のFirebaseプロジェクトの
// 「ウェブアプリの構成」に表示される値をここに貼り付けてください。
//
// 補足: このファイルの値(APIキーなど)はブラウザに公開される前提の値で、
// Firebase公式にも「秘密情報ではない」と明記されています。実際のアクセス制御は
// firestore.rules / storage.rules（施設・権限チェック）が行います。
// ============================================================

export const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID",
  storageBucket: "YOUR_PROJECT_ID.appspot.com",
  messagingSenderId: "YOUR_SENDER_ID",
  appId: "YOUR_APP_ID"
};
