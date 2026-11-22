// Treasury governance for SmartNode Network: a 3-of-5 multisig with a timelock and an audit trail.
//
// This module is pure logic. It does not hold funds and does not touch js/ledger.js. A withdrawal
// approved here returns an instruction ({ to, units }); applying it to the ledger is a separate,
// later step that needs its own review.
//
// No key is defined here. The five public keys come from the caller's config and must be generated
// in the test environment. Private keys are never stored or committed by this module.
//
// Rules:
// - A proposal needs `threshold` distinct valid approvals from the configured signers.
// - Execution waits until `timelockBlocks` blocks after the proposal height.
// - No single signer, including the founder, can withdraw alone.
// - Every event (propose, approve, execute) is appended to a hash-chained audit trail.

import { canonicalJson } from "../chain/crypto.js";
import { fromHex } from "../js/signing.js";

export const TREASURY_SIGNERS = 5;
export const TREASURY_THRESHOLD = 3;
const DOMAIN = "snn-treasury-v1";
const PUBLIC_KEY_BYTES = 32;
const SIGNATURE_BYTES = 64;
const encoder = new TextEncoder();

export class TreasuryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TreasuryError";
    this.code = code;
  }
}

const fail = (code, message) => {
  throw new TreasuryError(code, message);
};

const hexOf = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sha256Hex(text) {
  return hexOf(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}

// Checks the signer set, threshold and timelock. Public keys are 32-byte Ed25519 keys in hex.
export function validateTreasuryConfig(config) {
  if (config === null || typeof config !== "object") fail("BAD_CONFIG", "إعدادات الخزينة مطلوبة.");
  const { signers, threshold, timelockBlocks } = config;
  if (!Array.isArray(signers) || signers.length !== TREASURY_SIGNERS) {
    fail("BAD_CONFIG", `يجب أن يكون عدد الموقعين ${TREASURY_SIGNERS} بالضبط.`);
  }
  for (const key of signers) {
    if (typeof key !== "string" || !/^[0-9a-f]+$/.test(key) || key.length !== PUBLIC_KEY_BYTES * 2) {
      fail("BAD_CONFIG", "كل مفتاح موقّع يجب أن يكون مفتاح Ed25519 عاماً بطول 32 بايت.");
    }
  }
  if (new Set(signers).size !== signers.length) fail("BAD_CONFIG", "المفاتيح الموقّعة يجب أن تكون مختلفة.");
  if (threshold !== TREASURY_THRESHOLD) fail("BAD_CONFIG", `العتبة يجب أن تكون ${TREASURY_THRESHOLD} من ${TREASURY_SIGNERS}.`);
  if (!Number.isSafeInteger(timelockBlocks) || timelockBlocks <= 0) {
    fail("BAD_CONFIG", "مدة القفل الزمني يجب أن تكون عدد كتل موجباً.");
  }
  return Object.freeze({ signers: Object.freeze([...signers]), threshold, timelockBlocks });
}

// The exact bytes a signer approves. Amounts are integer micro-SNN strings.
export function proposalMessage({ id, to, units, executeAfter }) {
  return encoder.encode(canonicalJson({ domain: DOMAIN, id, to, units: String(units), executeAfter }));
}

async function verifySignature(publicKeyHex, signatureHex, message) {
  let sig;
  try {
    sig = fromHex(signatureHex);
  } catch {
    return false;
  }
  if (sig.length !== SIGNATURE_BYTES) return false;
  const key = await crypto.subtle.importKey("raw", fromHex(publicKeyHex), { name: "Ed25519" }, false, ["verify"]);
  return crypto.subtle.verify("Ed25519", key, sig, message);
}

export class Treasury {
  #config;
  #proposals = new Map();
  #nextId = 1;
  #audit = [];

  constructor(config) {
    this.#config = validateTreasuryConfig(config);
  }

  get config() {
    return this.#config;
  }

  get audit() {
    return this.#audit.map((entry) => ({ ...entry }));
  }

  proposal(id) {
    const p = this.#proposals.get(id);
    return p === undefined ? undefined : { ...p, approvals: [...p.approvals] };
  }

  // Appends one event to the hash chain. Each entry commits to the previous entry's hash.
  async #record(event, fields) {
    const prevHash = this.#audit.length === 0 ? "0".repeat(64) : this.#audit[this.#audit.length - 1].hash;
    const body = { seq: this.#audit.length + 1, event, prevHash, ...fields };
    const hash = await sha256Hex(canonicalJson(body));
    this.#audit.push(Object.freeze({ ...body, hash }));
  }

  // Opens a withdrawal proposal. The proposer must be a configured signer and must sign the proposal.
  async propose({ height, proposer, signature, to, units }) {
    if (!this.#config.signers.includes(proposer)) fail("NOT_SIGNER", "المقترِح ليس من الموقّعين.");
    if (typeof to !== "string" || to.length === 0) fail("BAD_PROPOSAL", "عنوان المستلم مطلوب.");
    if (typeof units !== "bigint" || units <= 0n) fail("BAD_PROPOSAL", "المبلغ يجب أن يكون عدداً صحيحاً موجباً.");
    const id = this.#nextId;
    const executeAfter = height + this.#config.timelockBlocks;
    const message = proposalMessage({ id, to, units, executeAfter });
    if (!(await verifySignature(proposer, signature, message))) fail("BAD_SIGNATURE", "توقيع الاقتراح غير صالح.");
    this.#nextId += 1;
    this.#proposals.set(id, { id, to, units, proposedAt: height, executeAfter, approvals: [proposer], executed: false });
    await this.#record("propose", { id, actor: proposer, height, to, units: String(units), executeAfter });
    await this.#record("approve", { id, actor: proposer, height });
    return id;
  }

  // Adds one approval. Each signer counts once.
  async approve({ id, height, signer, signature }) {
    const p = this.#proposals.get(id);
    if (p === undefined) fail("UNKNOWN_PROPOSAL", "الاقتراح غير موجود.");
    if (p.executed) fail("ALREADY_EXECUTED", "الاقتراح نُفّذ بالفعل.");
    if (!this.#config.signers.includes(signer)) fail("NOT_SIGNER", "الموقّع ليس من الموقّعين.");
    if (p.approvals.includes(signer)) fail("DUPLICATE_APPROVAL", "هذا الموقّع وافق على الاقتراح سابقاً.");
    const message = proposalMessage({ id: p.id, to: p.to, units: p.units, executeAfter: p.executeAfter });
    if (!(await verifySignature(signer, signature, message))) fail("BAD_SIGNATURE", "توقيع الموافقة غير صالح.");
    p.approvals.push(signer);
    await this.#record("approve", { id, actor: signer, height });
  }

  // Returns the withdrawal instruction once the threshold and timelock are both met.
  async execute({ id, height }) {
    const p = this.#proposals.get(id);
    if (p === undefined) fail("UNKNOWN_PROPOSAL", "الاقتراح غير موجود.");
    if (p.executed) fail("ALREADY_EXECUTED", "الاقتراح نُفّذ بالفعل.");
    if (p.approvals.length < this.#config.threshold) fail("NOT_ENOUGH_APPROVALS", "عدد الموافقات أقل من العتبة.");
    if (height < p.executeAfter) fail("TIMELOCKED", "القفل الزمني لم ينتهِ بعد.");
    p.executed = true;
    await this.#record("execute", { id, height, to: p.to, units: String(p.units) });
    return { to: p.to, units: p.units };
  }

  // Confirms the trail is intact: every entry's hash matches and links to the one before it.
  async verifyAudit() {
    let prev = "0".repeat(64);
    for (const [i, entry] of this.#audit.entries()) {
      if (entry.seq !== i + 1 || entry.prevHash !== prev) return false;
      const { hash, ...body } = entry;
      if ((await sha256Hex(canonicalJson(body))) !== hash) return false;
      prev = hash;
    }
    return true;
  }
}

// Applies an approved withdrawal to a ledger (js/ledger.js). The treasury's locked balance is
// passed in by the caller, so a locked amount can never leave the treasury early.
// The move is a protocol record from the treasury address to the recipient.
export function applyWithdrawal(ledger, { treasuryAddress, lockedUnits = 0n, instruction }) {
  if (instruction === null || typeof instruction !== "object") fail("BAD_INSTRUCTION", "تعليمة السحب مطلوبة.");
  const { to, units } = instruction;
  if (typeof units !== "bigint" || units <= 0n) fail("BAD_INSTRUCTION", "المبلغ يجب أن يكون عدداً صحيحاً موجباً.");
  if (typeof lockedUnits !== "bigint" || lockedUnits < 0n) fail("BAD_INSTRUCTION", "قيمة الرصيد المقفل غير صالحة.");
  const spendable = ledger.balanceOf(treasuryAddress) - lockedUnits;
  if (spendable < units) fail("INSUFFICIENT_SPENDABLE", "الرصيد القابل للصرف في الخزينة غير كافٍ.");
  return ledger.protocolMove({ from: treasuryAddress, to, amount: units });
}
