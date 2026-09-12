// ============================================================
// AniMediRec クラウド版 ロジック本体
// Firebase (Authentication / Firestore / Storage) 無料枠(Sparkプラン)のみで
// 動作する構成。Cloud Functions は使用しない。
// ============================================================

import { firebaseConfig } from "./firebase-config.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentSingleTabManager,
  doc, getDoc, setDoc, updateDoc, deleteDoc, addDoc, collection,
  query, where, orderBy, onSnapshot, serverTimestamp, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getStorage, ref, uploadBytes, getDownloadURL, deleteObject
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-storage.js";

// ---- Firebase 初期化 ----
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
// オフライン時も記録でき、復帰時に自動同期されるようローカルキャッシュを永続化
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentSingleTabManager() })
});
const storage = getStorage(app);

// ============================================================
// 共通ユーティリティ
// ============================================================

/** HTMLエスケープ（未エスケープのinnerHTML埋め込みによる表示崩れ・動作不良を防止） */
function esc(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function todayStr() {
  const n = new Date();
  return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, "0")}-${String(n.getDate()).padStart(2, "0")}`;
}

function nowTimeStr() {
  const n = new Date();
  return `${String(n.getHours()).padStart(2, "0")}:${String(n.getMinutes()).padStart(2, "0")}`;
}

/** date(YYYY-MM-DD) + time(HH:MM) から比較・保存用のISO文字列を作る(JST固定) */
function toRecordedAt(dateStr, timeStr) {
  return `${dateStr}T${timeStr || "00:00"}:00+09:00`;
}

function formatDateJp(dateStr) {
  return (dateStr || "").replace(/-/g, "/");
}

/**
 * 体重記録を「日付→(同日なら)作成順」で昇順ソートする。
 * dateはYYYY-MM-DD(時刻を持たない)のため、同じ日に複数回記録すると日付だけでは
 * 順序を決められず、Firestoreから返る順(≒作成順とは限らない)のままになってしまう
 * 不具合が実機で見つかった。createdAt(serverTimestamp)を同日内のタイブレークに使う。
 */
function sortWeightsAsc(weights) {
  return [...weights].sort((x, y) => {
    if (x.date !== y.date) return x.date < y.date ? -1 : 1;
    const xMs = x.createdAt && typeof x.createdAt.toMillis === "function" ? x.createdAt.toMillis() : 0;
    const yMs = y.createdAt && typeof y.createdAt.toMillis === "function" ? y.createdAt.toMillis() : 0;
    return xMs - yMs;
  });
}

/** グラム(数値) <-> 表示文字列。個体ごとの単位設定(kg/g)に従って整形する */
function formatWeight(grams, unit) {
  if (grams === null || grams === undefined || isNaN(grams)) return "未登録";
  if (unit === "g") return `${Math.round(grams)} g`;
  return `${(grams / 1000).toFixed(2)} kg`;
}

/** 入力欄の数値(unit基準)をグラムの整数に変換 */
function toGrams(inputValue, unit) {
  const v = parseFloat(inputValue);
  if (isNaN(v)) return null;
  return unit === "g" ? Math.round(v) : Math.round(v * 1000);
}

function gramsToInputValue(grams, unit) {
  if (grams === null || grams === undefined) return "";
  return unit === "g" ? String(Math.round(grams)) : (grams / 1000).toFixed(2);
}

/** カテゴリから体重単位の初期値を提案 */
function suggestWeightUnit(category) {
  return (category === "犬・猫") ? "kg" : "g";
}

/** 直近N日以内に △/✕ の記録があるか（要観察バッジの判定。過去全期間ではなく期間限定） */
function hasRecentWarn(logs, days = 7) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  return logs.some(l => (l.statusFlag === "△" || l.statusFlag === "✕") && new Date(l.recordedAt).getTime() >= cutoff);
}

/** 画像を長辺1280px・JPEG品質0.7に圧縮してBlobを返す（Storage無料枠を守るため必須） */
function compressImage(file, maxDim = 1280, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      let { width, height } = img;
      if (width > height && width > maxDim) {
        height = Math.round(height * (maxDim / width));
        width = maxDim;
      } else if (height > maxDim) {
        width = Math.round(width * (maxDim / height));
        height = maxDim;
      }
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      canvas.toBlob(blob => {
        URL.revokeObjectURL(url);
        blob ? resolve(blob) : reject(new Error("画像の圧縮に失敗しました"));
      }, "image/jpeg", quality);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("画像の読み込みに失敗しました")); };
    img.src = url;
  });
}

async function uploadPhoto(path, file) {
  const blob = await compressImage(file);
  const r = ref(storage, path);
  await uploadBytes(r, blob, { contentType: "image/jpeg" });
  return { photoPath: path, photoURL: await getDownloadURL(r) };
}

async function removePhoto(path) {
  if (!path) return;
  try { await deleteObject(ref(storage, path)); } catch (e) { /* 既に無い場合は無視 */ }
}

function downloadTextFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function csvCell(v) {
  const s = (v === null || v === undefined) ? "" : String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCSV(rows) {
  // Excelでの文字化けを防ぐためUTF-8 BOM付き、改行はCRLF
  const body = rows.map(row => row.map(csvCell).join(",")).join("\r\n");
  return "﻿" + body + "\r\n";
}

function showToast(msg, isError = false) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.className = isError ? "toast show error" : "toast show";
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = "toast"; }, 3400);
}

// ============================================================
// 自前ダイアログ（confirm()/prompt()の代替。CLAUDE.mdルール9）
// ============================================================

let dialogResolver = null;

function openDialog({ title, message, withInput = false, inputValue = "", placeholder = "", okLabel = "OK", danger = false }) {
  return new Promise((resolve) => {
    dialogResolver = resolve;
    document.getElementById("dialogTitle").textContent = title;
    document.getElementById("dialogMessage").textContent = message;
    const input = document.getElementById("dialogInput");
    input.style.display = withInput ? "block" : "none";
    input.value = inputValue;
    input.placeholder = placeholder;
    const okBtn = document.getElementById("dialogOkBtn");
    okBtn.textContent = okLabel;
    okBtn.className = danger ? "btn-danger" : "btn-primary";
    document.getElementById("dialogOverlay").classList.add("active");
    // 破壊的な操作をEnterキーで誤って確定させないよう、OKボタンではなくダイアログ本体
    // (input無しの場合)かinput自体(input有りの場合)にフォーカスする
    if (withInput) setTimeout(() => input.focus(), 50);
    else document.getElementById("dialogBox").focus();
  });
}

function closeDialog(result) {
  document.getElementById("dialogOverlay").classList.remove("active");
  if (dialogResolver) { dialogResolver(result); dialogResolver = null; }
}

/** ブラウザ標準confirm()の代替。Promise<boolean>を返す */
function customConfirm(message, opts = {}) {
  return openDialog({ title: "確認", ...opts, message, withInput: false }).then(r => r === true);
}

/** ブラウザ標準prompt()の代替。OK時は入力文字列、キャンセル時はnullを返す */
function customPrompt(message, opts = {}) {
  return openDialog({ title: "入力してください", ...opts, message, withInput: true });
}

document.getElementById("dialogCancelBtn").addEventListener("click", () => {
  const withInput = document.getElementById("dialogInput").style.display !== "none";
  closeDialog(withInput ? null : false);
});
document.getElementById("dialogOkBtn").addEventListener("click", () => {
  const input = document.getElementById("dialogInput");
  const withInput = input.style.display !== "none";
  closeDialog(withInput ? input.value : true);
});
document.getElementById("dialogInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("dialogOkBtn").click();
});
document.getElementById("dialogOverlay").addEventListener("click", (e) => {
  if (e.target.id === "dialogOverlay") document.getElementById("dialogCancelBtn").click();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.getElementById("dialogOverlay").classList.contains("active")) {
    document.getElementById("dialogCancelBtn").click();
  }
});

// ============================================================
// 状態管理
// ============================================================

const state = {
  user: null,          // { uid, name, email, role, facilityId }
  facility: null,       // { id, name, code }
  category: "犬・猫",
  categoryIcon: "🐶",
  animals: [],          // 現在の施設・カテゴリの個体キャッシュ(deletedAt==nullのみ購読)
  trashedAnimals: [],
  currentAnimalId: null,
  currentAnimalDeletedList: [],
  logs: [],             // 現在開いている個体の記録キャッシュ
  weights: [],          // 現在開いている個体の体重キャッシュ
  timezone: "朝",
  selectedDate: todayStr(),
  searchKeyword: "",
  filterMode: "all",
  selectedStatusFlag: "〇",
  selectedTags: [],
  dogCatIcon: "🐶",
};

// 施設登録・ログイン処理の途中でonAuthStateChangedが介入し、
// users/{uid}がまだ存在しないタイミングでsignOutしてしまう競合状態を防ぐためのフラグ
let authFlowInProgress = false;

let unsubAnimals = null;
let unsubLogs = null;
let unsubWeights = null;
let unsubTrashAnimals = null;
let unsubStaff = null;

function stopListener(name) {
  if (name === "animals" && unsubAnimals) { unsubAnimals(); unsubAnimals = null; }
  if (name === "logs" && unsubLogs) { unsubLogs(); unsubLogs = null; }
  if (name === "weights" && unsubWeights) { unsubWeights(); unsubWeights = null; }
  if (name === "trashAnimals" && unsubTrashAnimals) { unsubTrashAnimals(); unsubTrashAnimals = null; }
  if (name === "staff" && unsubStaff) { unsubStaff(); unsubStaff = null; }
}

// 記録タグ定義（元アプリと同一）
const categoryTagMap = {
  "排泄物": {
    "〇": ["普通便", "快便", "💧 おしっこ良好"],
    "warn": ["💩 硬い便・コロコロ便", "💩 やや軟便", "💩 下痢", "💩 水様便", "💩 血便混じり", "💧 尿量異常", "💧 血尿"]
  },
  "食事・嘔吐": {
    "〇": ["完食", "食欲旺盛", "水分補給OK"],
    "warn": ["半分残し", "少し食べた", "拒食・全く食べない", "水ばかり飲む", "🤮 嘔吐（毛玉）", "🤮 嘔吐（フード未消化）", "🤮 嘔吐（胃液・泡）"]
  },
  "元気・様子": {
    "〇": ["⚡ 元気いっぱい", "落ち着いている", "機嫌が良い"],
    "warn": ["少し元気がない", "😫 ぐったりしている", "寝床から出てこない", "🎾 遊ばない・無反応", "体を痒がる", "目やに・鼻水", "咳・くしゃみ"]
  },
  "爪切り": {
    "〇": ["すんなり切らせてくれた", "全足完了"],
    "warn": ["嫌がった・バタついた", "激しく暴れた・噛みつき", "途中で断念", "血が滲んだ"]
  },
  "自由備考": { "〇": ["特記事項あり"], "warn": ["特記事項あり"] }
};

// ============================================================
// 画面切り替え
// ============================================================

function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
  document.getElementById("appBar").style.display =
    ["screenLogin", "screenRegister", "screenAuthLoading"].includes(id) ? "none" : "flex";
  if (id === "screenList") renderAnimalList();
}

// ============================================================
// 認証・施設登録
// ============================================================

function genFacilityCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // 誤読しやすい文字を除外
  let s = "";
  for (let i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

async function registerFacility(facilityName, adminName, email, password) {
  authFlowInProgress = true;
  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    const uid = cred.user.uid;
    const facilityId = uid; // 設立者のuidをそのまま施設IDにする(不正な施設乗っ取りを防ぐ設計。firestore.rules参照)
    const code = genFacilityCode();

    await setDoc(doc(db, "facilities", facilityId), {
      name: facilityName, code, createdAt: serverTimestamp()
    });
    await setDoc(doc(db, "facilityCodes", code), { facilityId });
    await setDoc(doc(db, "users", uid), {
      facilityId, name: adminName, email, role: "admin", createdAt: serverTimestamp()
    });

    return { facilityId, code };
  } finally {
    authFlowInProgress = false;
  }
}

async function loginWithFacility(code, email, password) {
  authFlowInProgress = true;
  try {
    const cred = await signInWithEmailAndPassword(auth, email, password);
    const uid = cred.user.uid;
    const userSnap = await getDoc(doc(db, "users", uid));
    if (!userSnap.exists()) {
      await signOut(auth);
      throw new Error("アカウント情報が見つかりません。管理者に確認してください。");
    }
    const userData = userSnap.data();
    if (userData.role === "disabled") {
      await signOut(auth);
      throw new Error("このアカウントは無効化されています。");
    }

    const codeSnap = await getDoc(doc(db, "facilityCodes", code.trim().toUpperCase()));
    if (!codeSnap.exists() || codeSnap.data().facilityId !== userData.facilityId) {
      await signOut(auth);
      throw new Error("施設コードが正しくありません。");
    }
    return userData;
  } finally {
    authFlowInProgress = false;
  }
}

async function loadFacility(facilityId) {
  const snap = await getDoc(doc(db, "facilities", facilityId));
  return snap.exists() ? { id: facilityId, ...snap.data() } : { id: facilityId, name: "(不明な施設)", code: "" };
}

function initAuthUI() {
  document.getElementById("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = document.getElementById("loginFacilityCode").value;
    const email = document.getElementById("loginEmail").value;
    const pass = document.getElementById("loginPassword").value;
    const btn = document.getElementById("loginSubmitBtn");
    btn.disabled = true; btn.textContent = "ログイン中...";
    try {
      await loginWithFacility(code, email, pass);
      // 登録処理中はonAuthStateChangedの介入を止めているため、完了後に手動で呼ぶ
      await afterSignedIn(auth.currentUser);
    } catch (err) {
      showToast(err.message || "ログインに失敗しました", true);
    } finally {
      btn.disabled = false; btn.textContent = "ログイン";
    }
  });

  document.getElementById("registerForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const facilityName = document.getElementById("regFacilityName").value.trim();
    const adminName = document.getElementById("regAdminName").value.trim();
    const email = document.getElementById("regEmail").value;
    const pass = document.getElementById("regPassword").value;
    const btn = document.getElementById("registerSubmitBtn");
    if (pass.length < 6) { showToast("パスワードは6文字以上にしてください", true); return; }
    btn.disabled = true; btn.textContent = "登録中...";
    try {
      const { code } = await registerFacility(facilityName, adminName, email, pass);
      // 登録処理中はonAuthStateChangedの介入を止めているため、完了後に手動で呼ぶ
      await afterSignedIn(auth.currentUser);
      showToast(`施設を登録しました。施設コード: ${code}（職員に共有してください）`);
    } catch (err) {
      showToast(err.message || "登録に失敗しました", true);
    } finally {
      btn.disabled = false; btn.textContent = "施設を登録する";
    }
  });

  document.getElementById("toRegisterLink").addEventListener("click", (e) => {
    e.preventDefault(); showScreen("screenRegister");
  });
  document.getElementById("toLoginLink").addEventListener("click", (e) => {
    e.preventDefault(); showScreen("screenLogin");
  });
  document.getElementById("logoutBtn").addEventListener("click", async () => {
    stopListener("animals"); stopListener("logs"); stopListener("weights");
    stopListener("trashAnimals"); stopListener("staff");
    await signOut(auth);
  });
}

/**
 * サインイン済みユーザーの画面初期化。onAuthStateChangedから通常は自動で呼ばれるが、
 * registerFacility/loginWithFacility実行中はauthFlowInProgressで介入を止めているため、
 * それらの処理が完了した直後にも明示的に呼び出す（2箇所から呼ばれる想定）。
 */
async function afterSignedIn(fbUser) {
  if (!fbUser) return;
  try {
    const userSnap = await getDoc(doc(db, "users", fbUser.uid));
    if (!userSnap.exists()) { await signOut(auth); return; }
    const u = userSnap.data();
    state.user = { uid: fbUser.uid, name: u.name, email: u.email, role: u.role, facilityId: u.facilityId };
    state.facility = await loadFacility(u.facilityId);

    document.getElementById("facilityNameLabel").textContent = state.facility.name;
    document.getElementById("userNameLabel").textContent = `${u.name}（${roleLabel(u.role)}）`;
    document.getElementById("staffNavBtn").style.display = (u.role === "admin") ? "inline-block" : "none";
    // hidden属性を使う(style.display="" はCSSクラスのdisplay:noneを上書きできないため)。
    // ただしこれは今すでにDOMにある「静的な」editor-only/admin-only要素にのみ効く。
    // タイムライン等で動的に生成されるボタン類はcanEdit()/isAdminRole()を使って
    // 描画時に含めるかどうかを判定している(renderLogItem等を参照)。
    document.querySelectorAll(".editor-only").forEach(el => {
      el.hidden = !canEdit();
    });
    document.querySelectorAll(".admin-only").forEach(el => {
      el.hidden = !isAdminRole();
    });

    showScreen("screenHome");
  } catch (err) {
    console.error(err);
    showToast("ログイン情報の取得に失敗しました", true);
  }
}

onAuthStateChanged(auth, async (fbUser) => {
  if (authFlowInProgress) return; // registerFacility/loginWithFacility側で完了後に手動で呼ぶ
  if (!fbUser) {
    state.user = null; state.facility = null;
    showScreen("screenLogin");
    return;
  }
  await afterSignedIn(fbUser);
});

function roleLabel(role) {
  return { admin: "管理者", staff: "職員", viewer: "閲覧のみ", disabled: "無効" }[role] || role;
}

/** admin/staffなら記録・個体の追加編集が可能（動的に生成するボタンの出し分けに使う） */
function canEdit() {
  return !!state.user && (state.user.role === "admin" || state.user.role === "staff");
}

/** adminのみ可能な操作（個体の完全削除など） */
function isAdminRole() {
  return !!state.user && state.user.role === "admin";
}

// ============================================================
// カテゴリ選択・個体一覧
// ============================================================

function selectCategory(category, icon) {
  state.category = category;
  state.categoryIcon = icon;
  document.getElementById("selectedCategoryName").textContent = category;
  document.getElementById("searchInput").value = "";
  state.searchKeyword = "";
  subscribeAnimals();
  showScreen("screenList");
}

function subscribeAnimals() {
  stopListener("animals");
  const q = query(
    collection(db, "facilities", state.user.facilityId, "animals"),
    where("category", "==", state.category),
    where("deletedAt", "==", null)
  );
  unsubAnimals = onSnapshot(q, (snap) => {
    state.animals = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderAnimalList();
  }, (err) => { console.error(err); showToast("個体一覧の取得に失敗しました", true); });
}

function setFilterMode(mode) {
  state.filterMode = mode;
  document.getElementById("tabFilterAll").className = mode === "all" ? "filter-tab active" : "filter-tab";
  document.getElementById("tabFilterWarn").className = mode === "warn" ? "filter-tab active-warn" : "filter-tab";
  renderAnimalList();
}

function renderAnimalList() {
  const query_ = document.getElementById("searchInput").value.trim().toLowerCase();
  state.searchKeyword = query_;
  const container = document.getElementById("petListContainer");

  let list = state.animals.filter(a => {
    if (state.filterMode === "warn" && !a._warn) return false;
    if (!query_) return true;
    const hay = `${a.name || ""} ${a.breed || ""} ${a.code || ""}`.toLowerCase();
    return hay.includes(query_);
  });

  if (list.length === 0) {
    container.innerHTML = `<div style="text-align:center;color:#AAA;padding:20px;">${
      state.filterMode === "warn" ? "現在、異常や注意が記録されている個体はいません" : "該当する個体が見つかりません"
    }</div>`;
    return;
  }

  container.innerHTML = list.map(a => {
    const avatar = a.photoURL
      ? `<img src="${esc(a.photoURL)}" class="pet-avatar">`
      : `<div class="pet-avatar">${esc(a.type || "🐾")}</div>`;
    const warnBadge = a._warn
      ? `<span style="background:#FEE2E2;color:#EF4444;font-size:.7rem;padding:2px 6px;border-radius:6px;font-weight:bold;margin-left:6px;">⚠️ 要観察</span>`
      : "";
    const codeBadge = a.code ? `<span class="badge-category" style="background:#EFF6FF;color:#2563EB;">No.${esc(a.code)}</span>` : "";
    return `
      <div class="pet-card" data-id="${a.id}">
        <div class="pet-info">
          ${avatar}
          <div>
            <div style="display:flex;align-items:center;flex-wrap:wrap;gap:2px;">
              <span class="pet-name">${esc(a.name)}</span>
              ${codeBadge}
              ${warnBadge}
            </div>
            <div style="font-size:.75rem;color:var(--text-sub);">${esc(a.breed || "未指定")} ・ ${esc(formatWeight(a.latestWeightGrams, a.weightUnit || "kg"))}</div>
          </div>
        </div>
        <span style="font-size:.8rem;color:var(--text-sub);">記録へ ＞</span>
      </div>`;
  }).join("");

  // 「要観察」判定は各個体の直近ログを都度読みに行くと無料枠の読み取り回数を消費するため、
  // 一覧では animals ドキュメント自身が持つ集計フィールド(hasRecentWarn)を利用する。
  // (このフィールドは記録の追加・更新時にクライアント側で計算して書き込む)
}

document.addEventListener("click", (e) => {
  const card = e.target.closest(".pet-card[data-id]");
  if (card) openAnimalDetail(card.dataset.id);
});

// ============================================================
// 個体の登録・編集
// ============================================================

let editingAnimalId = null;
let pendingPhotoFile = null;

function openAddAnimalScreen(animal = null) {
  editingAnimalId = animal ? animal.id : null;
  pendingPhotoFile = null;
  document.getElementById("formHeaderTitle").textContent = animal ? "個体情報を編集" : `${state.category}の個体を登録`;

  const dogCatGroup = document.getElementById("dogCatTypeGroup");
  if (state.category === "犬・猫") {
    dogCatGroup.style.display = "block";
    setDogCatType(animal && animal.type === "🐱" ? "猫" : "犬", animal && animal.type === "🐱" ? "🐱" : "🐶",
      document.getElementById(animal && animal.type === "🐱" ? "btnTypeCat" : "btnTypeDog"));
  } else {
    dogCatGroup.style.display = "none";
  }

  const unit = (animal && animal.weightUnit) || suggestWeightUnit(state.category);
  setWeightUnit(unit);

  document.getElementById("addCode").value = animal ? (animal.code || "") : "";
  document.getElementById("addName").value = animal ? animal.name : "";
  document.getElementById("addBreed").value = animal ? animal.breed : "";
  document.getElementById("addWeight").value = animal ? gramsToInputValue(animal.latestWeightGrams, unit) : "";
  document.getElementById("addSex").value = animal ? (animal.sex || "不明") : "不明";
  document.getElementById("addBirthAccuracy").value = animal ? (animal.birthAccuracy || "正確に分かる") : "正確に分かる";
  document.getElementById("addBirth").value = animal ? (animal.birthDate || "") : "";
  document.getElementById("addArrive").value = animal ? (animal.arrivedAt || "") : "";
  document.getElementById("addArea").value = animal ? (animal.area || "") : "";
  document.getElementById("addBody").value = animal ? (animal.build || "") : "";
  document.getElementById("addPersonality").value = animal ? (animal.personality || "") : "";
  document.getElementById("addHistory").value = animal ? (animal.history || "") : "";
  document.getElementById("addHospital").value = animal ? (animal.hospitalName || "") : "";
  document.getElementById("addPhone").value = animal ? (animal.hospitalTel || "") : "";
  document.getElementById("addHospMemo").value = animal ? (animal.hospitalMemo || "") : "";
  document.getElementById("addPetPhotoPreview").textContent = animal && animal.photoURL ? "※すでに写真が設定されています（変更しない場合はそのまま保存でOK）" : "";
  document.getElementById("addPetPhoto").value = "";

  showScreen("screenAdd");
}

function setDogCatType(label, icon, el) {
  state.dogCatIcon = icon;
  document.getElementById("btnTypeDog").className = "pill-btn";
  document.getElementById("btnTypeCat").className = "pill-btn";
  el.className = "pill-btn active";
}

function setWeightUnit(unit) {
  document.getElementById("weightUnitLabel").textContent = unit;
  document.getElementById("addWeight").step = unit === "g" ? "1" : "0.01";
  document.getElementById("btnUnitKg").className = unit === "kg" ? "pill-btn active" : "pill-btn";
  document.getElementById("btnUnitG").className = unit === "g" ? "pill-btn active" : "pill-btn";
  document.getElementById("addWeightUnit").value = unit;
}

function previewPetPhoto(input) {
  const preview = document.getElementById("addPetPhotoPreview");
  if (input.files && input.files[0]) {
    pendingPhotoFile = input.files[0];
    preview.textContent = `📷 選択中: ${input.files[0].name}（保存時に圧縮してアップロードします）`;
  }
}

async function checkCodeDuplicate(code, excludeId) {
  if (!code) return false;
  const q = query(collection(db, "facilities", state.user.facilityId, "animals"), where("code", "==", code));
  const snap = await getDocs(q);
  return snap.docs.some(d => d.id !== excludeId && !d.data().deletedAt);
}

async function saveAnimalForm() {
  const code = document.getElementById("addCode").value.trim();
  const name = document.getElementById("addName").value.trim() || "無題";
  const unit = document.getElementById("addWeightUnit").value;
  const weightGrams = toGrams(document.getElementById("addWeight").value, unit);
  const btn = document.getElementById("saveAnimalBtn");

  if (code && await checkCodeDuplicate(code, editingAnimalId)) {
    showToast(`管理番号「${code}」は既に使用されています`, true);
    return;
  }

  const data = {
    code, name,
    category: state.category,
    type: state.category === "犬・猫" ? state.dogCatIcon : state.categoryIcon,
    breed: document.getElementById("addBreed").value.trim() || "未指定",
    sex: document.getElementById("addSex").value,
    birthAccuracy: document.getElementById("addBirthAccuracy").value,
    birthDate: document.getElementById("addBirth").value || "",
    arrivedAt: document.getElementById("addArrive").value || "",
    area: document.getElementById("addArea").value.trim(),
    build: document.getElementById("addBody").value.trim(),
    personality: document.getElementById("addPersonality").value.trim(),
    history: document.getElementById("addHistory").value.trim(),
    hospitalName: document.getElementById("addHospital").value.trim(),
    hospitalTel: document.getElementById("addPhone").value.trim(),
    hospitalMemo: document.getElementById("addHospMemo").value.trim(),
    weightUnit: unit,
    updatedAt: serverTimestamp(),
    updatedBy: state.user.uid,
  };
  if (weightGrams !== null) data.latestWeightGrams = weightGrams;

  btn.disabled = true; btn.textContent = "保存中...";
  try {
    let animalId = editingAnimalId;
    if (animalId) {
      await updateDoc(doc(db, "facilities", state.user.facilityId, "animals", animalId), data);
    } else {
      data.deletedAt = null;
      data.createdAt = serverTimestamp();
      data.createdBy = state.user.uid;
      data.photoPath = null; data.photoURL = null;
      data.latestWeightGrams = weightGrams; // null可(未入力時)
      data._warn = false;
      const ref_ = await addDoc(collection(db, "facilities", state.user.facilityId, "animals"), data);
      animalId = ref_.id;
      if (weightGrams !== null) {
        await addDoc(collection(db, "facilities", state.user.facilityId, "animals", animalId, "weights"), {
          date: todayStr(), grams: weightGrams, deletedAt: null,
          recordedBy: state.user.uid, createdAt: serverTimestamp()
        });
      }
    }

    if (pendingPhotoFile) {
      const path = `facilities/${state.user.facilityId}/animals/${animalId}/profile_${Date.now()}.jpg`;
      const { photoPath, photoURL } = await uploadPhoto(path, pendingPhotoFile);
      await updateDoc(doc(db, "facilities", state.user.facilityId, "animals", animalId), { photoPath, photoURL });
    }

    showToast("保存しました");
    if (editingAnimalId) {
      openAnimalDetail(animalId);
    } else {
      showScreen("screenList");
    }
  } catch (err) {
    console.error(err);
    showToast("保存に失敗しました: " + err.message, true);
  } finally {
    btn.disabled = false; btn.textContent = "保存を完了する";
  }
}

async function confirmDeleteAnimal() {
  const a = state.animals.find(x => x.id === state.currentAnimalId) ||
            state.trashedAnimals.find(x => x.id === state.currentAnimalId);
  const input = await customPrompt(
    `「${a.name}」をゴミ箱に移動します。\n30日以内であれば復元できます。\n\n実行する場合は個体名「${a.name}」を入力してください。`,
    { title: "削除の確認", placeholder: a.name, okLabel: "削除する", danger: true }
  );
  if (input === a.name) {
    await updateDoc(doc(db, "facilities", state.user.facilityId, "animals", a.id), {
      deletedAt: serverTimestamp(), updatedBy: state.user.uid
    });
    showToast(`「${a.name}」をゴミ箱に移動しました`);
    showScreen("screenList");
  } else if (input !== null) {
    showToast("名前が一致しなかったため、削除をキャンセルしました", true);
  }
}

// ============================================================
// 個体詳細・タイムライン
// ============================================================

function openAnimalDetail(id) {
  state.currentAnimalId = id;
  const a = state.animals.find(x => x.id === id);
  if (!a) return;

  document.getElementById("detailName").textContent = a.name;
  document.getElementById("detailCategory").textContent = a.category || "未分類";
  document.getElementById("detailSub").textContent = `${a.breed || ""} ・ ${formatWeight(a.latestWeightGrams, a.weightUnit || "kg")}${a.code ? " ・ No." + a.code : ""}`;
  document.getElementById("detailAvatarContainer").innerHTML = a.photoURL
    ? `<img src="${esc(a.photoURL)}" class="pet-avatar">`
    : `<div class="pet-avatar">${esc(a.type || "🐾")}</div>`;

  document.getElementById("timelineDatePicker").value = state.selectedDate;
  state.searchKeywordDetail = "";
  document.getElementById("detailSearchInput").value = "";
  document.getElementById("timeTabContainer").style.display = "grid";
  document.getElementById("datePickerCard").style.display = "flex";
  subscribeLogs(id);
  subscribeWeights(id);
  switchMainView("timeline");
  switchTimezone(state.timezone);
  showScreen("screenDetail");
}

function subscribeLogs(animalId) {
  stopListener("logs");
  const q = query(
    collection(db, "facilities", state.user.facilityId, "animals", animalId, "logs"),
    where("deletedAt", "==", null)
  );
  unsubLogs = onSnapshot(q, (snap) => {
    state.logs = snap.docs.map(d => ({ id: d.id, ...d.data() }))
      .sort((x, y) => x.recordedAt < y.recordedAt ? 1 : -1); // 新しい順（⑥: recordedAtで一元ソート）
    updateWarnFlag(animalId);
    renderTimelineOrSearch();
  }, (err) => { console.error(err); showToast("記録の取得に失敗しました", true); });
}

function subscribeWeights(animalId) {
  stopListener("weights");
  const q = query(
    collection(db, "facilities", state.user.facilityId, "animals", animalId, "weights"),
    where("deletedAt", "==", null)
  );
  unsubWeights = onSnapshot(q, (snap) => {
    state.weights = sortWeightsAsc(snap.docs.map(d => ({ id: d.id, ...d.data() }))); // 古い順（⑥: グラフ描画用）
    if (document.getElementById("weightViewArea").style.display !== "none") renderWeightChart();
  }, (err) => { console.error(err); showToast("体重記録の取得に失敗しました", true); });
}

/** 直近7日以内の△✕有無をanimalドキュメントに書き込み、一覧の「⚠️要観察」表示に使う */
async function updateWarnFlag(animalId) {
  const warn = hasRecentWarn(state.logs, 7);
  const a = state.animals.find(x => x.id === animalId);
  if (a && a._warn === warn) return; // 変わっていなければ書き込まない(無料枠の書き込み回数節約)
  try {
    await updateDoc(doc(db, "facilities", state.user.facilityId, "animals", animalId), { _warn: warn });
  } catch (e) { /* 権限がなくても致命的ではないので無視 */ }
}

function switchMainView(view) {
  const isTimeline = view === "timeline";
  document.getElementById("navTimeline").classList.toggle("active", isTimeline);
  document.getElementById("navWeight").classList.toggle("active", !isTimeline);
  document.getElementById("timelineViewArea").style.display = isTimeline ? "block" : "none";
  document.getElementById("weightViewArea").style.display = isTimeline ? "none" : "block";
  if (!isTimeline) renderWeightChart();
}

function onDateChanged() {
  state.selectedDate = document.getElementById("timelineDatePicker").value;
  renderTimelineOrSearch();
}

function switchTimezone(tz) {
  state.timezone = tz;
  const tabIds = { "朝": "tabMorning", "昼": "tabNoon", "夜": "tabNight" };
  Object.values(tabIds).forEach(id => document.getElementById(id).classList.remove("active"));
  document.getElementById(tabIds[tz]).classList.add("active");
  renderTimelineOrSearch();
}

function renderTimelineOrSearch() {
  if (state.searchKeywordDetail) {
    renderSearchResultTimeline();
  } else {
    renderTimeline();
  }
}

function renderTimeline() {
  const container = document.getElementById("timelineList");
  document.getElementById("timelineTitle").textContent = `${formatDateJp(state.selectedDate)} (${state.timezone}) のタイムライン`;
  const list = state.logs.filter(l => l.recordedAt.slice(0, 10) === state.selectedDate && l.timezone === state.timezone);
  if (list.length === 0) {
    container.innerHTML = `<div style="font-size:.8rem;color:#AAA;text-align:center;padding:20px 0;">${formatDateJp(state.selectedDate)} (${state.timezone}) の記録はありません</div>`;
    return;
  }
  container.innerHTML = list.map(l => renderLogItem(l, false)).join("");
}

function renderLogItem(log, showDate) {
  let badgeClass = "badge-good";
  if (log.statusFlag === "△") badgeClass = "badge-warn";
  if (log.statusFlag === "✕") badgeClass = "badge-bad";
  const tagsHtml = (log.tags || []).map(t => `<span style="background:#F0F0F0;padding:2px 6px;border-radius:6px;font-size:.75rem;margin-right:4px;">${esc(t)}</span>`).join("");
  const timeStr = log.recordedAt.slice(11, 16);
  const dateStr = log.recordedAt.slice(0, 10).replace(/-/g, "/");
  const photoHtml = log.photoURL ? `<img src="${esc(log.photoURL)}" class="tl-img" data-photo="${esc(log.photoURL)}">` : "";
  const actionsHtml = canEdit() ? `
      <div class="tl-actions">
        <button class="tl-action-btn" data-edit-log="${log.id}">編集</button>
        <button class="tl-action-btn delete" data-del-log="${log.id}">削除</button>
      </div>` : "";
  return `
    <div class="tl-item">
      ${actionsHtml}
      <div class="tl-time-box">
        ${showDate ? `<div class="tl-date">${dateStr}</div>` : ""}
        <div>${timeStr} (${esc(log.timezone)})</div>
      </div>
      <div class="tl-content">
        <div><span class="tl-badge ${badgeClass}">${esc(log.statusFlag)} ${esc(log.category)}</span></div>
        <div style="margin-top:4px;">${tagsHtml}</div>
        ${log.memo ? `<div style="font-size:.8rem;margin-top:6px;color:#555;">📝 ${esc(log.memo)}</div>` : ""}
        ${photoHtml}
      </div>
    </div>`;
}

function renderSearchResultTimeline() {
  const q = (state.searchKeywordDetail || "").toLowerCase();
  const list = state.logs.filter(l =>
    l.category.toLowerCase().includes(q) ||
    (l.tags || []).some(t => t.toLowerCase().includes(q)) ||
    (l.memo && l.memo.toLowerCase().includes(q))
  );
  document.getElementById("timelineTitle").textContent = `「${state.searchKeywordDetail}」が含まれる過去の記録`;
  const container = document.getElementById("timelineList");
  container.innerHTML = list.length === 0
    ? `<div style="font-size:.8rem;color:#AAA;text-align:center;padding:20px 0;">「${esc(state.searchKeywordDetail)}」に該当する記録はありません</div>`
    : list.map(l => renderLogItem(l, true)).join("");
}

document.addEventListener("click", (e) => {
  const img = e.target.closest(".tl-img[data-photo]");
  if (img) openImageModal(img.dataset.photo);
  const editBtn = e.target.closest("[data-edit-log]");
  if (editBtn) openLogModal(editBtn.dataset.editLog, null);
  const delBtn = e.target.closest("[data-del-log]");
  if (delBtn) deleteLogRecord(delBtn.dataset.delLog);
});

// ============================================================
// 記録の追加・編集モーダル
// ============================================================

let editingLogId = null;
let pendingLogPhotoFile = null;

function openLogModal(logId = null, presetCategory = null) {
  state.selectedStatusFlag = "〇";
  state.selectedTags = [];
  editingLogId = logId;
  pendingLogPhotoFile = null;
  document.getElementById("modalMemo").value = "";
  document.getElementById("modalPhoto").value = "";
  document.getElementById("modalPhotoPreview").textContent = "";
  document.getElementById("existingPhotoNotice").textContent = "";

  const existing = logId ? state.logs.find(l => l.id === logId) : null;
  let category = existing ? existing.category : presetCategory;

  if (existing) {
    state.selectedStatusFlag = existing.statusFlag;
    state.selectedTags = [...(existing.tags || [])];
    document.getElementById("modalMemo").value = existing.memo || "";
    if (existing.photoURL) document.getElementById("existingPhotoNotice").textContent = "※新しい写真を選ばない場合、既存の写真が保持されます。";
  }

  document.getElementById("modalTitle").textContent = existing ? `${category}を編集` : `${category}を記録 (${state.timezone})`;
  document.getElementById("modalOverlay").dataset.category = category;
  // #modalDate / #modalTime はrenderModalFormContent()がinnerHTMLで生成するため、
  // 生成が終わった後でなければ値を設定できない
  renderModalFormContent(category);
  document.getElementById("modalDate").value = existing ? existing.recordedAt.slice(0, 10) : state.selectedDate;
  document.getElementById("modalTime").value = existing ? existing.recordedAt.slice(11, 16) : nowTimeStr();
  document.getElementById("modalOverlay").classList.add("active");
}

function renderModalFormContent(category) {
  const content = document.getElementById("modalFormContent");
  let html = `
    <div class="form-group">
      <label class="form-label">状態判定</label>
      <div class="pill-group">
        <div class="pill-btn ${state.selectedStatusFlag === "〇" ? "active" : ""}" data-flag="〇">〇 普通・良</div>
        <div class="pill-btn ${state.selectedStatusFlag === "△" ? "active-orange" : ""}" data-flag="△">△ やや気になる</div>
        <div class="pill-btn ${state.selectedStatusFlag === "✕" ? "active-red" : ""}" data-flag="✕">✕ 悪い・異常</div>
      </div>
    </div>`;

  const tagDef = categoryTagMap[category];
  if (tagDef) {
    const tagType = state.selectedStatusFlag === "〇" ? "〇" : "warn";
    const tags = tagDef[tagType];
    html += `
      <div class="form-group">
        <label class="form-label">${state.selectedStatusFlag === "〇" ? "状態" : "気になる症状・異常項目"}</label>
        <div class="tag-grid">
          ${tags.map(t => `<div class="tag-btn ${state.selectedTags.includes(t) ? "selected" : ""}" data-tag="${esc(t)}">${esc(t)}</div>`).join("")}
        </div>
      </div>`;
  }
  if (category === "投薬・通院") {
    let medName = "", medPeriod = "";
    state.selectedTags.forEach(t => {
      if (t.startsWith("薬: ")) medName = t.replace("薬: ", "");
      if (t.startsWith("期間: ")) medPeriod = t.replace("期間: ", "");
    });
    html += `
      <div class="form-group">
        <label class="form-label">薬・通院詳細</label>
        <input type="text" id="addMedName" class="input-field" value="${esc(medName)}" placeholder="薬の名前（例: 抗生剤・整腸剤）" style="margin-bottom:8px;">
        <input type="text" id="addMedPeriod" class="input-field" value="${esc(medPeriod)}" placeholder="服用期間（例: 9/4〜9/10まで）">
      </div>`;
  }
  content.innerHTML = html;
}

document.addEventListener("click", (e) => {
  const flagBtn = e.target.closest("#modalFormContent [data-flag]");
  if (flagBtn) {
    state.selectedStatusFlag = flagBtn.dataset.flag;
    state.selectedTags = [];
    renderModalFormContent(document.getElementById("modalOverlay").dataset.category);
    return;
  }
  const tagBtn = e.target.closest("#modalFormContent [data-tag]");
  if (tagBtn) {
    tagBtn.classList.toggle("selected");
    const t = tagBtn.dataset.tag;
    state.selectedTags = state.selectedTags.includes(t) ? state.selectedTags.filter(x => x !== t) : [...state.selectedTags, t];
  }
});

function closeLogModal() { document.getElementById("modalOverlay").classList.remove("active"); }

function previewModalPhoto(input) {
  if (input.files && input.files[0]) {
    pendingLogPhotoFile = input.files[0];
    document.getElementById("modalPhotoPreview").textContent = `📷 選択中: ${input.files[0].name}`;
  }
}

async function saveLogRecord() {
  const category = document.getElementById("modalOverlay").dataset.category;
  const memo = document.getElementById("modalMemo").value.trim();
  const dateVal = document.getElementById("modalDate").value || state.selectedDate;
  const timeVal = document.getElementById("modalTime").value || nowTimeStr();
  const animalId = state.currentAnimalId;

  if (category === "投薬・通院") {
    const medName = document.getElementById("addMedName")?.value.trim();
    const medPeriod = document.getElementById("addMedPeriod")?.value.trim();
    state.selectedTags = state.selectedTags.filter(t => !t.startsWith("薬: ") && !t.startsWith("期間: "));
    if (medName) state.selectedTags.push(`薬: ${medName}`);
    if (medPeriod) state.selectedTags.push(`期間: ${medPeriod}`);
  }

  const data = {
    category, statusFlag: state.selectedStatusFlag, tags: state.selectedTags, memo,
    recordedAt: toRecordedAt(dateVal, timeVal),
    timezone: state.timezone,
    updatedAt: serverTimestamp(),
  };

  const btn = document.getElementById("saveLogBtn");
  btn.disabled = true; btn.textContent = "保存中...";
  try {
    let logId = editingLogId;
    if (logId) {
      await updateDoc(doc(db, "facilities", state.user.facilityId, "animals", animalId, "logs", logId), data);
    } else {
      data.deletedAt = null;
      data.createdAt = serverTimestamp();
      data.recordedBy = state.user.uid;
      data.recordedByName = state.user.name;
      data.photoPath = null; data.photoURL = null;
      const ref_ = await addDoc(collection(db, "facilities", state.user.facilityId, "animals", animalId, "logs"), data);
      logId = ref_.id;
    }
    if (pendingLogPhotoFile) {
      const path = `facilities/${state.user.facilityId}/animals/${animalId}/logs/${logId}_${Date.now()}.jpg`;
      const { photoPath, photoURL } = await uploadPhoto(path, pendingLogPhotoFile);
      await updateDoc(doc(db, "facilities", state.user.facilityId, "animals", animalId, "logs", logId), { photoPath, photoURL });
    }
    closeLogModal();
    showToast("記録を保存しました");
  } catch (err) {
    console.error(err);
    showToast("保存に失敗しました: " + err.message, true);
  } finally {
    btn.disabled = false; btn.textContent = "保存する";
  }
}

async function deleteLogRecord(logId) {
  if (!(await customConfirm("この記録をゴミ箱に移動します。よろしいですか？", { title: "記録の削除", okLabel: "削除する", danger: true }))) return;
  await updateDoc(doc(db, "facilities", state.user.facilityId, "animals", state.currentAnimalId, "logs", logId), {
    deletedAt: serverTimestamp()
  });
  showToast("記録をゴミ箱に移動しました");
}

// ============================================================
// 体重
// ============================================================

async function addWeightRecord() {
  const a = state.animals.find(x => x.id === state.currentAnimalId);
  const unit = (a && a.weightUnit) || "kg";
  const grams = toGrams(document.getElementById("newWeightInput").value, unit);
  if (grams === null || grams <= 0) { showToast("正しい体重数値を入力してください", true); return; }

  await addDoc(collection(db, "facilities", state.user.facilityId, "animals", state.currentAnimalId, "weights"), {
    date: todayStr(), grams, deletedAt: null, recordedBy: state.user.uid, createdAt: serverTimestamp()
  });
  await updateDoc(doc(db, "facilities", state.user.facilityId, "animals", state.currentAnimalId), { latestWeightGrams: grams });
  document.getElementById("newWeightInput").value = "";
  showToast("体重を記録しました");
}

async function editWeightRecord(id) {
  const item = state.weights.find(w => w.id === id);
  const a = state.animals.find(x => x.id === state.currentAnimalId);
  const unit = (a && a.weightUnit) || "kg";
  const newVal = await customPrompt(
    `${item.date} の体重を入力してください (${unit}):`,
    { title: "体重記録の修正", inputValue: gramsToInputValue(item.grams, unit), okLabel: "保存" }
  );
  if (newVal === null) return;
  const grams = toGrams(newVal, unit);
  if (grams === null || grams <= 0) { showToast("正しい数値を入力してください", true); return; }
  await updateDoc(doc(db, "facilities", state.user.facilityId, "animals", state.currentAnimalId, "weights", id), { grams });
  const latest = sortWeightsAsc(state.weights).pop();
  if (latest && latest.id === id) await updateDoc(doc(db, "facilities", state.user.facilityId, "animals", state.currentAnimalId), { latestWeightGrams: grams });
}

async function deleteWeightRecord(id) {
  const item = state.weights.find(w => w.id === id);
  if (!(await customConfirm(`${item.date} の記録を削除しますか？`, { title: "体重記録の削除", okLabel: "削除する", danger: true }))) return;
  await updateDoc(doc(db, "facilities", state.user.facilityId, "animals", state.currentAnimalId, "weights", id), { deletedAt: serverTimestamp() });
}

document.addEventListener("click", (e) => {
  const edit = e.target.closest("[data-edit-weight]");
  if (edit) editWeightRecord(edit.dataset.editWeight);
  const del = e.target.closest("[data-del-weight]");
  if (del) deleteWeightRecord(del.dataset.delWeight);
});

function renderWeightChart() {
  const a = state.animals.find(x => x.id === state.currentAnimalId);
  const unit = (a && a.weightUnit) || "kg";
  const history = state.weights; // すでに日付昇順(⑥)
  const listContainer = document.getElementById("weightHistoryList");

  listContainer.innerHTML = history.length === 0
    ? `<div style="text-align:center;color:#AAA;font-size:.8rem;padding:10px;">記録がありません</div>`
    : history.slice().reverse().map(h => `
        <div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #EEE;font-size:.85rem;">
          <span>📅 ${esc(h.date)}</span>
          <div style="display:flex;align-items:center;gap:10px;">
            <span style="font-weight:bold;color:var(--accent-green);">${esc(formatWeight(h.grams, unit))}</span>
            ${canEdit() ? `
            <button class="tl-action-btn" data-edit-weight="${h.id}">編集</button>
            <button class="tl-action-btn delete" data-del-weight="${h.id}">削除</button>` : ""}
          </div>
        </div>`).join("");

  const canvas = document.getElementById("weightChart");
  const ctx = canvas.getContext("2d");
  canvas.width = canvas.parentElement.clientWidth;
  canvas.height = 220;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (history.length === 0) {
    ctx.fillStyle = "#AAA"; ctx.font = "12px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("体重の記録データがありません", canvas.width / 2, canvas.height / 2);
    return;
  }

  const padding = 38;
  const w = canvas.width - padding * 2;
  const h = canvas.height - padding * 2;
  const values = history.map(item => unit === "g" ? item.grams : item.grams / 1000);
  let minW = Math.min(...values), maxW = Math.max(...values);
  const span = maxW - minW || (unit === "g" ? 10 : 0.5);
  minW -= span * 0.15; maxW += span * 0.15;

  ctx.strokeStyle = "#E0E0E0"; ctx.lineWidth = 1; ctx.fillStyle = "#8E8E93"; ctx.font = "10px sans-serif";
  for (let i = 0; i <= 3; i++) {
    const yVal = minW + ((maxW - minW) / 3) * i;
    const yPos = canvas.height - padding - (h / 3) * i;
    ctx.beginPath(); ctx.moveTo(padding, yPos); ctx.lineTo(canvas.width - padding, yPos); ctx.stroke();
    ctx.fillText((unit === "g" ? Math.round(yVal) : yVal.toFixed(2)) + unit, 2, yPos + 3);
  }

  const points = history.map((item, index) => {
    const val = unit === "g" ? item.grams : item.grams / 1000;
    const x = history.length === 1 ? canvas.width / 2 : padding + (w / (history.length - 1)) * index;
    const y = canvas.height - padding - ((val - minW) / (maxW - minW)) * h;
    return { x, y, date: item.date, val };
  });

  if (points.length > 1) {
    ctx.beginPath(); ctx.strokeStyle = "#38C6A3"; ctx.lineWidth = 3;
    points.forEach((p, i) => i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y));
    ctx.stroke();
  }
  points.forEach(p => {
    ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.fillStyle = "#38C6A3"; ctx.fill();
    ctx.strokeStyle = "#FFF"; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = "#4A4A4A"; ctx.font = "bold 10px sans-serif"; ctx.textAlign = "center";
    ctx.fillText(`${unit === "g" ? Math.round(p.val) : p.val.toFixed(2)}${unit}`, p.x, p.y - 10);
    ctx.fillStyle = "#8E8E93"; ctx.font = "9px sans-serif";
    ctx.fillText(p.date.slice(5), p.x, canvas.height - 10);
  });
}

// ============================================================
// 画像拡大モーダル
// ============================================================
function openImageModal(url) {
  document.getElementById("enlargedImage").src = url;
  document.getElementById("imageModal").classList.add("active");
}
function closeImageModal() { document.getElementById("imageModal").classList.remove("active"); }

// ============================================================
// ゴミ箱（⑤ 論理削除・復元）
// ============================================================

function openTrashScreen() {
  stopListener("trashAnimals");
  const q = query(collection(db, "facilities", state.user.facilityId, "animals"), where("deletedAt", "!=", null));
  unsubTrashAnimals = onSnapshot(q, (snap) => {
    state.trashedAnimals = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    renderTrash();
  }, (err) => { console.error(err); showToast("ゴミ箱の取得に失敗しました（索引の作成が必要な場合、コンソールのリンクから作成してください）", true); });
  showScreen("screenTrash");
}

function renderTrash() {
  const container = document.getElementById("trashList");
  if (state.trashedAnimals.length === 0) {
    container.innerHTML = `<div style="text-align:center;color:#AAA;padding:20px;">ゴミ箱は空です</div>`;
    return;
  }
  container.innerHTML = state.trashedAnimals.map(a => `
    <div class="pet-card" style="cursor:default;">
      <div class="pet-info">
        <div class="pet-avatar">${esc(a.type || "🐾")}</div>
        <div>
          <div class="pet-name">${esc(a.name)}</div>
          <div style="font-size:.75rem;color:var(--text-sub);">${esc(a.breed || "")}</div>
        </div>
      </div>
      <div style="display:flex;gap:6px;">
        ${canEdit() ? `<button class="tl-action-btn" data-restore="${a.id}">復元</button>` : ""}
        ${isAdminRole() ? `<button class="tl-action-btn delete" data-purge="${a.id}">完全削除</button>` : ""}
      </div>
    </div>`).join("");
}

document.addEventListener("click", async (e) => {
  const restore = e.target.closest("[data-restore]");
  if (restore) {
    await updateDoc(doc(db, "facilities", state.user.facilityId, "animals", restore.dataset.restore), { deletedAt: null });
    showToast("復元しました");
  }
  const purge = e.target.closest("[data-purge]");
  if (purge) {
    if (!(await customConfirm("完全に削除します。この操作は取り消せません。よろしいですか？", { title: "完全削除の確認", okLabel: "完全に削除する", danger: true }))) return;
    await deleteDoc(doc(db, "facilities", state.user.facilityId, "animals", purge.dataset.purge));
    showToast("完全に削除しました");
  }
});

// ============================================================
// 職員管理（admin専用・②③④⑤の①部分）
// ============================================================

function openStaffScreen() {
  stopListener("staff");
  const q = query(collection(db, "users"), where("facilityId", "==", state.user.facilityId));
  unsubStaff = onSnapshot(q, (snap) => {
    renderStaffList(snap.docs.map(d => ({ id: d.id, ...d.data() })));
  });
  document.getElementById("staffFacilityCode").textContent = state.facility.code;
  showScreen("screenStaff");
}

function renderStaffList(users) {
  document.getElementById("staffList").innerHTML = users.map(u => `
    <div class="pet-card" style="cursor:default;">
      <div>
        <div class="pet-name">${esc(u.name)}</div>
        <div style="font-size:.75rem;color:var(--text-sub);">${esc(u.email)} ・ ${esc(roleLabel(u.role))}</div>
      </div>
      ${u.id !== state.user.uid ? `
        <select class="input-field" style="width:auto;" data-role-select="${u.id}">
          <option value="staff" ${u.role === "staff" ? "selected" : ""}>職員</option>
          <option value="viewer" ${u.role === "viewer" ? "selected" : ""}>閲覧のみ</option>
          <option value="disabled" ${u.role === "disabled" ? "selected" : ""}>無効化</option>
        </select>` : `<span class="badge-category">自分</span>`}
    </div>`).join("");
}

document.addEventListener("change", async (e) => {
  const sel = e.target.closest("[data-role-select]");
  if (sel) {
    await updateDoc(doc(db, "users", sel.dataset.roleSelect), { role: sel.value });
    showToast("権限を更新しました");
  }
});

async function inviteStaff(name, email, password, role) {
  // 管理者自身のログインセッションを維持したまま新しい職員アカウントを作るため、
  // セカンダリのFirebaseアプリインスタンスで作成する。
  const { initializeApp: initApp2, deleteApp } = await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js");
  const secondaryApp = initApp2(firebaseConfig, "Secondary-" + Date.now());
  const { getAuth: getAuth2, createUserWithEmailAndPassword: createUser2, signOut: signOut2 } =
    await import("https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js");
  const secondaryAuth = getAuth2(secondaryApp);
  const cred = await createUser2(secondaryAuth, email, password);
  await setDoc(doc(db, "users", cred.user.uid), {
    facilityId: state.user.facilityId, name, email, role, createdAt: serverTimestamp()
  });
  await signOut2(secondaryAuth);
  await deleteApp(secondaryApp);
}

// ============================================================
// エクスポート（⑧ CSV / JSON）
// ============================================================

function exportAnimalListCSV() {
  const rows = [["管理番号", "名前", "カテゴリ", "種類", "性別", "体重", "単位", "部屋・エリア", "既往歴"]];
  state.animals.forEach(a => rows.push([
    a.code || "", a.name, a.category, a.breed, a.sex,
    a.weightUnit === "g" ? a.latestWeightGrams : (a.latestWeightGrams / 1000).toFixed(2),
    a.weightUnit || "kg", a.area || "", a.history || ""
  ]));
  downloadTextFile(`個体一覧_${todayStr()}.csv`, toCSV(rows), "text/csv;charset=utf-8");
}

function exportCurrentAnimalCSV() {
  const a = state.animals.find(x => x.id === state.currentAnimalId);
  const rows = [["日付", "時間帯", "時刻", "記録種別", "判定", "タグ", "備考", "記録者"]];
  state.logs.forEach(l => rows.push([
    l.recordedAt.slice(0, 10).replace(/-/g, "/"), l.timezone, l.recordedAt.slice(11, 16),
    l.category, l.statusFlag, (l.tags || []).join(" / "), l.memo || "", l.recordedByName || ""
  ]));
  downloadTextFile(`${a.name}_記録_${todayStr()}.csv`, toCSV(rows), "text/csv;charset=utf-8");
}

function exportCurrentAnimalJSON() {
  const a = state.animals.find(x => x.id === state.currentAnimalId);
  const data = { schemaVersion: 1, exportedAt: new Date().toISOString(), animal: a, logs: state.logs, weights: state.weights };
  downloadTextFile(`${a.name}_バックアップ_${todayStr()}.json`, JSON.stringify(data, null, 2), "application/json");
}

/** 施設全体のバックアップ。全記録を読むためオンデマンド実行のみ(admin限定)。 */
async function exportFacilityBackupJSON() {
  if (!(await customConfirm("施設内の全データを読み込みます（無料枠の読み取り回数を消費します）。実行しますか？", { title: "全データバックアップ", okLabel: "実行する" }))) return;
  showToast("バックアップを作成中...");
  const animalsSnap = await getDocs(collection(db, "facilities", state.user.facilityId, "animals"));
  const animals = [];
  for (const aDoc of animalsSnap.docs) {
    const logsSnap = await getDocs(collection(db, "facilities", state.user.facilityId, "animals", aDoc.id, "logs"));
    const weightsSnap = await getDocs(collection(db, "facilities", state.user.facilityId, "animals", aDoc.id, "weights"));
    animals.push({
      id: aDoc.id, ...aDoc.data(),
      logs: logsSnap.docs.map(d => ({ id: d.id, ...d.data() })),
      weights: weightsSnap.docs.map(d => ({ id: d.id, ...d.data() }))
    });
  }
  downloadTextFile(`${state.facility.name}_全データバックアップ_${todayStr()}.json`,
    JSON.stringify({ schemaVersion: 1, exportedAt: new Date().toISOString(), facility: state.facility, animals }, null, 2),
    "application/json");
  showToast("バックアップを保存しました");
}

// ============================================================
// 印刷用カルテ（⑧ PDF代替: ブラウザのPDF保存を利用）
// ============================================================

function printAnimalChart() {
  const a = state.animals.find(x => x.id === state.currentAnimalId);
  const recentLogs = state.logs.slice(0, 30);
  const html = `
    <h1>${esc(a.name)} の診療用カルテ</h1>
    <table class="print-meta">
      <tr><th>管理番号</th><td>${esc(a.code || "-")}</td><th>種類</th><td>${esc(a.breed || "-")}</td></tr>
      <tr><th>性別</th><td>${esc(a.sex || "-")}</td><th>体重</th><td>${esc(formatWeight(a.latestWeightGrams, a.weightUnit || "kg"))}</td></tr>
      <tr><th>かかりつけ病院</th><td>${esc(a.hospitalName || "-")}</td><th>電話</th><td>${esc(a.hospitalTel || "-")}</td></tr>
      <tr><th colspan="4">既往歴・アレルギー</th></tr>
      <tr><td colspan="4">${esc(a.history || "特記事項なし")}</td></tr>
    </table>
    <h2>直近の記録（最新30件）</h2>
    <table class="print-log">
      <tr><th>日付</th><th>時間帯</th><th>種別</th><th>判定</th><th>タグ・備考</th></tr>
      ${recentLogs.map(l => `<tr>
        <td>${esc(l.recordedAt.slice(0, 10).replace(/-/g, "/"))}</td>
        <td>${esc(l.timezone)}</td><td>${esc(l.category)}</td><td>${esc(l.statusFlag)}</td>
        <td>${esc((l.tags || []).join(" / "))}${l.memo ? " / " + esc(l.memo) : ""}</td>
      </tr>`).join("")}
    </table>`;
  document.getElementById("printArea").innerHTML = html;
  window.print();
}

// ============================================================
// 全画面共通の検索欄（詳細画面内・全期間検索）
// ============================================================

function setDetailSearch(keyword) {
  state.searchKeywordDetail = keyword.trim();
  document.getElementById("timeTabContainer").style.display = state.searchKeywordDetail ? "none" : "grid";
  document.getElementById("datePickerCard").style.display = state.searchKeywordDetail ? "none" : "flex";
  renderTimelineOrSearch();
}

// ============================================================
// グローバル公開（index.html の inline onclick から呼び出すため）
// ============================================================
Object.assign(window, {
  selectCategory, setFilterMode, renderAnimalList, openAddAnimalScreen, saveAnimalForm,
  setDogCatType, setWeightUnit, previewPetPhoto, confirmDeleteAnimal, switchMainView,
  onDateChanged, switchTimezone, openLogModal, closeLogModal, previewModalPhoto,
  saveLogRecord, addWeightRecord, openImageModal, closeImageModal, openTrashScreen,
  openStaffScreen, exportAnimalListCSV, exportCurrentAnimalCSV, exportCurrentAnimalJSON,
  exportFacilityBackupJSON, printAnimalChart, setDetailSearch,
  showScreen,
});

document.getElementById("staffInviteForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = document.getElementById("inviteName").value.trim();
  const email = document.getElementById("inviteEmail").value.trim();
  const pass = document.getElementById("invitePassword").value;
  const role = document.getElementById("inviteRole").value;
  if (pass.length < 6) { showToast("パスワードは6文字以上にしてください", true); return; }
  try {
    await inviteStaff(name, email, pass, role);
    showToast(`${name} さんを追加しました`);
    e.target.reset();
  } catch (err) {
    showToast("追加に失敗しました: " + err.message, true);
  }
});

document.getElementById("editAnimalBtn").addEventListener("click", () => {
  const a = state.animals.find(x => x.id === state.currentAnimalId);
  openAddAnimalScreen(a);
});

document.getElementById("btnUnitKg").addEventListener("click", () => setWeightUnit("kg"));
document.getElementById("btnUnitG").addEventListener("click", () => setWeightUnit("g"));

initAuthUI();
