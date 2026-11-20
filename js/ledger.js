// SNN demo ledger: pure logic with no DOM and no network access.
// Amounts are BigInt micro-SNN (1 SNN = 1,000,000 units), so no floating-point rounding is involved.
//
// Every transfer must carry an Ed25519 signature from the sender's key over the exact amount, recipient and nonce.
// A stored ledger is accepted only if replaying its transactions from scratch reproduces the stored state exactly.
// This is a local simulation of SNN Core behaviour, not the real SNN Protocol.

import { verifyTransferSignature } from "./signing.js";

export const UNITS_PER_SNN = 1_000_000n;
export const TESTNET_FAUCET_UNITS = 100n * UNITS_PER_SNN;
export const ADDRESS_PATTERN = /^snn1[0-9a-f]{40}$/;
export const MAX_TRANSACTIONS = 10_000;

const DIGITS_PATTERN = /^(0|[1-9][0-9]{0,17})$/; // up to 18 digits, so a stored amount can never be absurdly large
const PUBLIC_KEY_HEX = /^[0-9a-f]{64}$/;
const SIGNATURE_HEX = /^[0-9a-f]{128}$/;
const RECORD_FIELDS = ["height", "type", "from", "to", "amount", "nonce", "publicKey", "signature"];

export class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "LedgerError";
    this.code = code;
  }
}

export function isValidAddress(address) {
  return typeof address === "string" && ADDRESS_PATTERN.test(address);
}

// Accepts "12", "12.5", "0.000001". Rejects negatives, exponents, and more than 6 decimals.
export function parseAmount(input) {
  const text = String(input ?? "").trim();
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(text);
  if (!match) {
    throw new LedgerError("INVALID_AMOUNT", "المبلغ يجب أن يكون رقماً موجباً بحد أقصى 6 منازل عشرية.");
  }
  const whole = BigInt(match[1]);
  const fraction = BigInt((match[2] ?? "").padEnd(6, "0"));
  const units = whole * UNITS_PER_SNN + fraction;
  if (units <= 0n) {
    throw new LedgerError("INVALID_AMOUNT", "المبلغ يجب أن يكون أكبر من صفر.");
  }
  return units;
}

export function formatAmount(units) {
  const whole = units / UNITS_PER_SNN;
  const fraction = (units % UNITS_PER_SNN).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;

const corrupt = (detail) => new LedgerError("LEDGER_CORRUPT", `سجل المحفظة تالف أو تم العبث به: ${detail}`);

// Checks one stored record's shape. Every field is type- and length-checked, and unknown fields are rejected.
function assertRecordShape(record, expectedHeight) {
  if (!isPlainObject(record)) throw corrupt("سجل غير صالح.");
  const keys = Object.keys(record).sort();
  if (keys.join() !== [...RECORD_FIELDS].sort().join()) throw corrupt("حقول السجل غير مطابقة.");
  if (record.height !== expectedHeight) throw corrupt("ترقيم المعاملات غير متسلسل.");
  if (!DIGITS_PATTERN.test(String(record.amount)) || String(record.amount) === "0") {
    throw corrupt("مبلغ المعاملة غير صالح.");
  }
  if (record.type === "faucet") {
    if (record.from !== null || record.nonce !== null || record.publicKey !== null || record.signature !== null) {
      throw corrupt("معاملة الصنبور تحتوي على حقول غير مسموحة.");
    }
    if (!isValidAddress(record.to)) throw corrupt("عنوان المستلم غير صالح.");
    if (record.amount !== TESTNET_FAUCET_UNITS.toString()) throw corrupt("قيمة صنبور الاختبار غير مسموحة.");
  } else if (record.type === "transfer") {
    if (!isValidAddress(record.from) || !isValidAddress(record.to)) throw corrupt("عنوان غير صالح.");
    if (!Number.isSafeInteger(record.nonce) || record.nonce < 0) throw corrupt("رقم المعاملة غير صالح.");
    if (!PUBLIC_KEY_HEX.test(record.publicKey) || !SIGNATURE_HEX.test(record.signature)) {
      throw corrupt("توقيع المعاملة أو مفتاحها العام غير صالح.");
    }
  } else {
    throw corrupt("نوع معاملة غير معروف.");
  }
}

// Stable text form of the whole state, used to compare a stored ledger with its replayed version.
function canonicalState({ balances, nonces, transactions }) {
  const sorted = (obj) =>
    Object.keys(obj)
      .sort()
      .map((key) => [key, String(obj[key])]);
  return JSON.stringify({
    balances: sorted(balances),
    nonces: sorted(nonces),
    transactions: transactions.map((tx) => [
      tx.height,
      tx.type,
      tx.from ?? null,
      tx.to ?? null,
      String(tx.amount),
      tx.nonce ?? null,
      tx.publicKey ?? null,
      tx.signature ?? null,
    ]),
  });
}

export class Ledger {
  #balances = new Map();
  #nonces = new Map();
  #transactions = [];
  #faucetRecipients = new Set();

  // Rebuilds the ledger by replaying every transaction, verifying each signature and nonce.
  // Throws LEDGER_CORRUPT if the stored state cannot be reproduced exactly.
  static async fromSnapshot(snapshot) {
    if (!isPlainObject(snapshot) || !Array.isArray(snapshot.transactions)) {
      throw corrupt("شكل السجل غير صالح.");
    }
    if (snapshot.transactions.length > MAX_TRANSACTIONS) {
      throw corrupt("عدد المعاملات يتجاوز الحد المسموح.");
    }
    if (!isPlainObject(snapshot.balances) || !isPlainObject(snapshot.nonces)) {
      throw corrupt("الأرصدة أو الأرقام التسلسلية غير صالحة.");
    }
    for (const [address, units] of Object.entries(snapshot.balances)) {
      if (!isValidAddress(address) || !DIGITS_PATTERN.test(String(units))) throw corrupt("رصيد غير صالح.");
    }
    for (const [address, n] of Object.entries(snapshot.nonces)) {
      if (!isValidAddress(address) || !Number.isSafeInteger(n) || n < 0) throw corrupt("رقم تسلسلي غير صالح.");
    }

    const replayed = new Ledger();
    try {
      for (const [index, record] of snapshot.transactions.entries()) {
        assertRecordShape(record, index + 1);
        if (record.type === "faucet") {
          replayed.credit(record.to, BigInt(record.amount));
        } else {
          await replayed.transfer({
            from: record.from,
            to: record.to,
            amount: BigInt(record.amount),
            nonce: record.nonce,
            publicKey: record.publicKey,
            signature: record.signature,
          });
        }
      }
    } catch (err) {
      if (err instanceof LedgerError && err.code === "LEDGER_CORRUPT") throw err;
      throw corrupt(err instanceof LedgerError ? err.message : "فشل التحقق من المعاملات.");
    }

    if (canonicalState(replayed.toJSON()) !== canonicalState(snapshot)) {
      throw corrupt("الأرصدة لا تطابق المعاملات المسجلة.");
    }
    return replayed;
  }

  get height() {
    return this.#transactions.length;
  }

  balanceOf(address) {
    return this.#balances.get(address) ?? 0n;
  }

  nextNonce(address) {
    return this.#nonces.get(address) ?? 0;
  }

  // Newest first. Returns copies so callers cannot mutate the ledger.
  transactionsFor(address) {
    return this.#transactions
      .filter((tx) => tx.from === address || tx.to === address)
      .map((tx) => ({ ...tx }))
      .reverse();
  }

  // Testnet faucet only. Creates units from nothing, so it must never be exposed on a real network.
  // Each address can receive it once, and only the fixed testnet amount.
  credit(address, units) {
    if (!isValidAddress(address)) {
      throw new LedgerError("INVALID_RECIPIENT", "عنوان المحفظة غير صالح.");
    }
    if (units !== TESTNET_FAUCET_UNITS) {
      throw new LedgerError("INVALID_AMOUNT", "قيمة صنبور الاختبار غير مسموحة.");
    }
    if (this.#faucetRecipients.has(address)) {
      throw new LedgerError("FAUCET_USED", "تم استخدام صنبور الاختبار لهذه المحفظة مسبقاً.");
    }
    this.#balances.set(address, this.balanceOf(address) + units);
    this.#faucetRecipients.add(address);
    return this.#record({ type: "faucet", from: null, to: address, amount: units, nonce: null, publicKey: null, signature: null });
  }

  // Order of checks: shape, then signature, then nonce and funds. Signature comes first so that unauthenticated
  // input learns nothing about account state. Nonce and funds are checked after the last await, so the state
  // they read is the state they change.
  async transfer({ from, to, amount, nonce, publicKey, signature }) {
    if (!isValidAddress(from)) {
      throw new LedgerError("INVALID_SENDER", "عنوان المرسل غير صالح.");
    }
    if (!isValidAddress(to)) {
      throw new LedgerError("INVALID_RECIPIENT", "عنوان المستلم غير صالح.");
    }
    if (from === to) {
      throw new LedgerError("SELF_TRANSFER", "لا يمكن الإرسال إلى المحفظة نفسها.");
    }
    const units = typeof amount === "bigint" ? amount : parseAmount(amount);
    if (units <= 0n) {
      throw new LedgerError("INVALID_AMOUNT", "المبلغ يجب أن يكون أكبر من صفر.");
    }
    if (!Number.isSafeInteger(nonce) || nonce < 0) {
      throw new LedgerError("INVALID_NONCE", "رقم المعاملة غير صالح.");
    }
    if (!PUBLIC_KEY_HEX.test(publicKey ?? "") || !SIGNATURE_HEX.test(signature ?? "")) {
      throw new LedgerError("BAD_SIGNATURE", "المعاملة غير موقّعة أو التوقيع بصيغة غير صالحة.");
    }

    const verdict = await verifyTransferSignature({
      from,
      to,
      units: units.toString(),
      nonce,
      publicKey,
      signature,
    });
    if (!verdict.ok) {
      throw new LedgerError(verdict.code, verdict.message);
    }

    const expected = this.nextNonce(from);
    if (nonce !== expected) {
      throw new LedgerError("NONCE_MISMATCH", `رقم المعاملة (nonce) غير صالح. المتوقع: ${expected}.`);
    }
    const senderBalance = this.balanceOf(from);
    if (senderBalance < units) {
      throw new LedgerError("INSUFFICIENT_FUNDS", "الرصيد غير كافٍ لإتمام التحويل.");
    }

    this.#balances.set(from, senderBalance - units);
    this.#balances.set(to, this.balanceOf(to) + units);
    this.#nonces.set(from, expected + 1);
    return this.#record({ type: "transfer", from, to, amount: units, nonce: expected, publicKey, signature });
  }

  #record(tx) {
    const entry = { height: this.#transactions.length + 1, ...tx };
    this.#transactions.push(entry);
    return { ...entry };
  }

  toJSON() {
    return {
      balances: Object.fromEntries([...this.#balances].map(([address, units]) => [address, units.toString()])),
      nonces: Object.fromEntries(this.#nonces),
      transactions: this.#transactions.map((tx) => ({ ...tx, amount: tx.amount.toString() })),
    };
  }
}
