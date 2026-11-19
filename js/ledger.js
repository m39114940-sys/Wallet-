// SNN demo ledger: pure logic with no DOM and no network access.
// Amounts are BigInt "micro-SNN" (1 SNN = 1,000,000 units), so no floating-point rounding is involved.
// This is a local simulation of SNN Core behaviour for the testnet UI. It is not the real SNN Protocol.

export const UNITS_PER_SNN = 1_000_000n;
export const TESTNET_FAUCET_UNITS = 100n * UNITS_PER_SNN;
export const ADDRESS_PATTERN = /^snn1[0-9a-f]{40}$/;

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

export class Ledger {
  #balances;
  #nonces;
  #transactions;

  constructor(snapshot = {}) {
    this.#balances = new Map(
      Object.entries(snapshot.balances ?? {}).map(([address, units]) => [address, BigInt(units)]),
    );
    this.#nonces = new Map(Object.entries(snapshot.nonces ?? {}).map(([address, n]) => [address, Number(n)]));
    this.#transactions = (snapshot.transactions ?? []).map((tx) => ({ ...tx, amount: BigInt(tx.amount) }));
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
  credit(address, units) {
    if (!isValidAddress(address)) {
      throw new LedgerError("INVALID_RECIPIENT", "عنوان المحفظة غير صالح.");
    }
    if (typeof units !== "bigint" || units <= 0n) {
      throw new LedgerError("INVALID_AMOUNT", "المبلغ يجب أن يكون أكبر من صفر.");
    }
    this.#balances.set(address, this.balanceOf(address) + units);
    return this.#record({ type: "faucet", from: null, to: address, amount: units, nonce: null });
  }

  // The nonce must equal the sender's next expected nonce. Replaying an old transfer therefore fails,
  // and two competing transfers with the same nonce cannot both be applied (double-spend protection).
  transfer({ from, to, amount, nonce }) {
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
    return this.#record({ type: "transfer", from, to, amount: units, nonce: expected });
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
