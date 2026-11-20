import { Ledger, LedgerError, TESTNET_FAUCET_UNITS, formatAmount, parseAmount, isValidAddress } from "./ledger.js";
import {
  createPrivateKey,
  deriveAddress,
  encryptKeystore,
  decryptKeystore,
  parseKeystoreFile,
} from "./keystore.js";

const LEDGER_KEY = "snn.demo.ledger.v1";
const KEYSTORE_KEY = "snn.demo.keystore.v1";
const MIN_PASSPHRASE_LENGTH = 10;

const $ = (selector) => document.querySelector(selector);

const views = {
  onboarding: $("#view-onboarding"),
  unlock: $("#view-unlock"),
  dashboard: $("#view-dashboard"),
};

// The ledger is the testnet state kept in localStorage. The private key lives only in memory for the session.
let ledger = loadLedger();
let session = null; // { address, privateKey }
let pendingSend = null; // { to, amount } waiting for user confirmation

// ---------- Storage helpers (storage can be disabled in private mode) ----------

function readStorage(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

function removeStorage(key) {
  try {
    localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

function loadLedger() {
  const raw = readStorage(LEDGER_KEY);
  if (!raw) return new Ledger();
  try {
    return new Ledger(JSON.parse(raw));
  } catch {
    return new Ledger();
  }
}

function saveLedger() {
  return writeStorage(LEDGER_KEY, JSON.stringify(ledger));
}

// ---------- UI helpers ----------

function showView(name) {
  for (const [key, el] of Object.entries(views)) {
    el.hidden = key !== name;
  }
}

let toastTimer;
function toast(message, kind = "ok") {
  const el = $("#toast");
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 3200);
}

function setMessage(form, message = "", kind = "error") {
  const el = form.querySelector(".form-msg");
  el.textContent = message;
  el.className = message ? `form-msg ${kind}` : "form-msg";
}

function setBusy(form, busy) {
  for (const control of form.querySelectorAll("button, input")) {
    control.disabled = busy;
  }
}

function shortAddress(address) {
  return `${address.slice(0, 10)}…${address.slice(-6)}`;
}

function historyItem(tx, address) {
  const isFaucet = tx.type === "faucet";
  const incoming = isFaucet || tx.to === address;
  const kind = isFaucet ? "faucet" : incoming ? "in" : "out";

  const li = document.createElement("li");
  li.className = `tx ${kind}`;

  const icon = document.createElement("span");
  icon.className = "tx-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = isFaucet ? "★" : incoming ? "↓" : "↑";

  const body = document.createElement("div");
  const title = document.createElement("div");
  title.className = "tx-title";
  title.textContent = isFaucet ? "صنبور الاختبار" : incoming ? "استلام" : "إرسال";

  const meta = document.createElement("div");
  meta.className = "tx-meta";
  const counterparty = isFaucet ? "testnet" : shortAddress(incoming ? tx.from : tx.to);
  meta.textContent = `#${tx.height} · ${counterparty}${tx.nonce !== null ? ` · nonce ${tx.nonce}` : ""}`;
  body.append(title, meta);

  const amount = document.createElement("div");
  amount.className = "tx-amount";
  amount.textContent = `${incoming ? "+" : "−"}${formatAmount(tx.amount)} SNN`;

  li.append(icon, body, amount);
  return li;
}

function renderDashboard() {
  if (!session) return;
  const { address } = session;
  const txs = ledger.transactionsFor(address);

  $("#balance").textContent = formatAmount(ledger.balanceOf(address));
  $("#address").textContent = address;
  $("#receive-address").textContent = address;
  $("#height").textContent = `ارتفاع السلسلة: ${ledger.height}`;
  $("#history").replaceChildren(...txs.map((tx) => historyItem(tx, address)));
  $("#history-empty").hidden = txs.length > 0;
}

function showDashboard() {
  showView("dashboard");
  renderDashboard();
}

function start() {
  session = null;
  cancelPendingSend();
  hideBackup();
  const hasWallet = Boolean(readStorage(KEYSTORE_KEY));
  showView(hasWallet ? "unlock" : "onboarding");
}

// ---------- Send confirmation ----------

function cancelPendingSend() {
  pendingSend = null;
  $("#send-confirm").hidden = true;
  $("#send-submit").hidden = false;
}

// Validates the form against the ledger before asking for confirmation, so the user never confirms an impossible transfer.
function reviewSend(form) {
  const to = form.to.value.trim();
  const amountText = form.amount.value.trim();

  if (!isValidAddress(to)) return setMessage(form, "عنوان المستلم غير صالح.");
  if (to === session.address) return setMessage(form, "لا يمكن الإرسال إلى المحفظة نفسها.");

  let units;
  try {
    units = parseAmount(amountText);
  } catch (err) {
    return setMessage(form, err.message);
  }
  if (ledger.balanceOf(session.address) < units) {
    return setMessage(form, "الرصيد غير كافٍ لإتمام التحويل.");
  }

  pendingSend = { to, amount: amountText };
  setMessage(form);
  $("#send-confirm-text").textContent = `إرسال ${formatAmount(units)} SNN إلى ${shortAddress(to)}؟ لا يمكن التراجع عن التحويل بعد تأكيده.`;
  $("#send-confirm").hidden = false;
  $("#send-submit").hidden = true;
}

function executeSend(form) {
  if (!session || !pendingSend) return;
  const { to, amount } = pendingSend;

  // Re-read the stored state, so the nonce and balance reflect any other tab that changed them.
  ledger = loadLedger();
  try {
    const tx = ledger.transfer({ from: session.address, to, amount, nonce: ledger.nextNonce(session.address) });
    const saved = saveLedger();
    cancelPendingSend();
    form.reset();
    setMessage(form);
    renderDashboard();
    toast(
      saved
        ? `تم إرسال ${formatAmount(tx.amount)} SNN (المعاملة #${tx.height})`
        : "تم التحويل في هذه الجلسة، لكن تعذّر حفظه في المتصفح",
      saved ? "ok" : "error",
    );
  } catch (err) {
    cancelPendingSend();
    if (err instanceof LedgerError) {
      setMessage(form, err.message);
    } else {
      console.error(err);
      setMessage(form, "حدث خطأ غير متوقع أثناء الإرسال.");
    }
  }
}

// ---------- Handlers ----------

$("#create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const passphrase = form.passphrase.value;
  const repeat = form.confirm.value;

  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    setMessage(form, `كلمة المرور يجب ألا تقل عن ${MIN_PASSPHRASE_LENGTH} أحرف.`);
    return;
  }
  if (passphrase !== repeat) {
    setMessage(form, "كلمتا المرور غير متطابقتين.");
    return;
  }

  setBusy(form, true);
  try {
    const privateKey = createPrivateKey();
    const address = await deriveAddress(privateKey);
    const keystore = await encryptKeystore(privateKey, passphrase, address);

    if (!writeStorage(KEYSTORE_KEY, JSON.stringify(keystore))) {
      throw new Error("storage");
    }
    ledger.credit(address, TESTNET_FAUCET_UNITS);
    saveLedger();

    session = { address, privateKey };
    form.reset();
    setMessage(form);
    showDashboard();
    toast("تم إنشاء المحفظة وإيداع 100 SNN تجريبية", "ok");
  } catch (err) {
    console.error(err);
    setMessage(form, "تعذّر إنشاء المحفظة في هذا المتصفح. تأكد من السماح بالتخزين المحلي وحاول مرة أخرى.");
  } finally {
    setBusy(form, false);
  }
});

$("#restore-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const file = form.file.files[0];
  const passphrase = form.passphrase.value;
  if (!file) {
    setMessage(form, "اختر ملف المحفظة أولاً.");
    return;
  }

  setBusy(form, true);
  try {
    const keystore = parseKeystoreFile(await file.text());
    const { privateKey, address } = await decryptKeystore(keystore, passphrase);
    if (!writeStorage(KEYSTORE_KEY, JSON.stringify(keystore))) {
      throw new Error("storage");
    }
    session = { address, privateKey };
    form.reset();
    setMessage(form);
    showDashboard();
    toast("تمت استعادة المحفظة", "ok");
  } catch (err) {
    setMessage(form, err.message || "تعذّر استعادة المحفظة.");
  } finally {
    setBusy(form, false);
  }
});

$("#unlock-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const passphrase = form.passphrase.value;

  let keystore = null;
  try {
    keystore = JSON.parse(readStorage(KEYSTORE_KEY) ?? "null");
  } catch {
    keystore = null;
  }

  setBusy(form, true);
  try {
    const { privateKey, address } = await decryptKeystore(keystore, passphrase);
    session = { address, privateKey };
    form.reset();
    setMessage(form);
    showDashboard();
  } catch (err) {
    setMessage(form, err.message || "تعذّر فتح المحفظة.");
  } finally {
    setBusy(form, false);
  }
});

const sendForm = $("#send-form");

sendForm.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!session) return;
  reviewSend(sendForm);
});

// Editing the fields after a review invalidates that review.
sendForm.addEventListener("input", () => {
  if (pendingSend) cancelPendingSend();
});

$("#send-yes").addEventListener("click", () => executeSend(sendForm));
$("#send-no").addEventListener("click", () => {
  cancelPendingSend();
  setMessage(sendForm);
});

$("#copy-address").addEventListener("click", async () => {
  if (!session) return;
  try {
    await navigator.clipboard.writeText(session.address);
    toast("تم نسخ العنوان", "ok");
  } catch {
    toast("تعذّر النسخ. انسخ العنوان يدوياً.", "error");
  }
});

// Removes the displayed backup text, so it does not stay on screen after the wallet is locked.
function hideBackup() {
  $("#backup").hidden = true;
  $("#backup-text").value = "";
}

$("#lock").addEventListener("click", () => {
  session = null;
  cancelPendingSend();
  hideBackup();
  $("#unlock-form").reset();
  setMessage($("#unlock-form"));
  showView("unlock");
  toast("تم قفل المحفظة", "ok");
});

// Shows the already-encrypted keystore as text. The plaintext key is never exported.
// Text is used instead of a file download, because published pages cannot trigger downloads.
$("#export").addEventListener("click", () => {
  const raw = readStorage(KEYSTORE_KEY);
  if (!session || !raw) {
    toast("لا يوجد ملف محفظة لعرضه.", "error");
    return;
  }
  const panel = $("#backup");
  const text = $("#backup-text");
  text.value = JSON.stringify(JSON.parse(raw), null, 2);
  panel.hidden = false;
  text.focus();
  text.select();
});

$("#copy-backup").addEventListener("click", async () => {
  const text = $("#backup-text");
  try {
    await navigator.clipboard.writeText(text.value);
    toast("تم نسخ النسخة الاحتياطية", "ok");
  } catch {
    text.focus();
    text.select();
    toast("انسخ النص يدوياً من الخانة", "error");
  }
});

$("#reset").addEventListener("click", () => {
  if (!window.confirm("سيتم حذف المحفظة وكل سجلها من هذا المتصفح. هل أنت متأكد؟")) return;
  removeStorage(KEYSTORE_KEY);
  removeStorage(LEDGER_KEY);
  ledger = new Ledger();
  start();
  toast("تم حذف المحفظة من هذا المتصفح", "ok");
});

// Keeps other open tabs in sync: new transfers appear here, and a reset in one tab locks the rest.
window.addEventListener("storage", (event) => {
  if (event.key === LEDGER_KEY && session) {
    ledger = loadLedger();
    renderDashboard();
  } else if (event.key === KEYSTORE_KEY && !event.newValue && session) {
    start();
    toast("تم حذف المحفظة من تبويب آخر", "error");
  }
});

start();
