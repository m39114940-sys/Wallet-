// SNN chain core: blocks, commit certificates, double-sign evidence and state transitions.
// Everything here is deterministic and shared by every node: the same genesis and the same
// certified blocks always produce the same state.
//
// State: { ledger, stakes: Map<publicKey, bigint>, jailed: Set<publicKey> }
// Stakes are micro-SNN units, so slashing uses integer arithmetic only.

import { Ledger, TESTNET_FAUCET_UNITS, parseAmount, formatAmount } from "../js/ledger.js";
import { capWeights, DEFAULT_MAX_SHARE, hasQuorum } from "../consensus/sim.js";
import { sha256Hex, canonicalJson, verifyText } from "./crypto.js";

export const GENESIS_PREV_HASH = "0".repeat(64);
export const SLASH_PERCENT = 5n; // equivocation burns 5% of the stake and jails the validator
export const NIL = "nil"; // vote for "no block"

const HEX_64 = /^[0-9a-f]{64}$/;
const DECIMAL_STAKE = /^[1-9][0-9]*$/;

export class ChainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ChainError";
    this.code = code;
  }
}

// ---------- Transactions ----------

// Only these fields exist in a transaction. Amounts are rewritten to one canonical decimal form,
// so "2.5" and "2.50" cannot produce two different transaction ids for the same transfer.
export function normalizeTx(tx) {
  if (tx === null || typeof tx !== "object") throw new ChainError("BAD_TX", "المعاملة غير صالحة.");
  return {
    from: tx.from,
    to: tx.to,
    amount: formatAmount(parseAmount(tx.amount)),
    nonce: tx.nonce,
    publicKey: tx.publicKey,
    signature: tx.signature,
  };
}

export const txId = (tx) => sha256Hex(canonicalJson(normalizeTx(tx)));

// Merkle root with the last leaf duplicated on odd levels. An empty list hashes the empty string.
export function merkleRoot(hashes) {
  if (hashes.length === 0) return sha256Hex("");
  let level = hashes;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] ?? left;
      next.push(sha256Hex(left + right));
    }
    level = next;
  }
  return level[0];
}

// ---------- Messages that validators sign ----------

// A validator signs one of these for each vote. The chain id prevents replay on another network.
export const voteMessage = (chainId, type, height, round, blockHash) =>
  `SNN-VOTE-v1|${chainId}|${type}|${height}|${round}|${blockHash}`;

export const proposalMessage = (chainId, height, round, polkaRound, blockHash) =>
  `SNN-PROPOSAL-v1|${chainId}|${height}|${round}|${polkaRound}|${blockHash}`;

// ---------- Evidence of double signing ----------

export function normalizeEvidence(ev) {
  if (ev === null || typeof ev !== "object") throw new ChainError("BAD_EVIDENCE", "دليل التوقيع المزدوج غير صالح.");
  const { validator, height, round, blockA, signatureA, blockB, signatureB } = ev;
  const ok =
    typeof validator === "string" &&
    Number.isInteger(height) &&
    height >= 0 &&
    Number.isInteger(round) &&
    round >= 0 &&
    typeof blockA === "string" &&
    typeof blockB === "string" &&
    typeof signatureA === "string" &&
    typeof signatureB === "string";
  if (!ok) throw new ChainError("BAD_EVIDENCE", "شكل دليل التوقيع المزدوج غير صالح.");
  return { validator, height, round, blockA, signatureA, blockB, signatureB };
}

export const evidenceKey = (ev) => `${ev.validator}|${ev.height}|${ev.round}`;

// Two different precommits from one validator for the same height and round. The signatures prove it.
// The caller decides the height limit, because the rule depends on which block would include the evidence.
export async function verifyEvidence(evRaw, chainId, state) {
  const ev = normalizeEvidence(evRaw);
  if (ev.blockA === ev.blockB) throw new ChainError("BAD_EVIDENCE", "الدليل لا يثبت تناقضاً.");
  if (!state.stakes.has(ev.validator) || state.jailed.has(ev.validator)) {
    throw new ChainError("BAD_EVIDENCE", "المدقق غير نشط.");
  }
  const okA = await verifyText(
    ev.validator,
    voteMessage(chainId, "precommit", ev.height, ev.round, ev.blockA),
    ev.signatureA,
  );
  const okB = await verifyText(
    ev.validator,
    voteMessage(chainId, "precommit", ev.height, ev.round, ev.blockB),
    ev.signatureB,
  );
  if (!okA || !okB) throw new ChainError("BAD_EVIDENCE", "توقيع دليل التوقيع المزدوج غير صحيح.");
  return ev;
}

// ---------- Genesis ----------

// validators: [{ publicKey (hex), stake (decimal string of micro-SNN units) }]
export function createGenesisConfig({ chainId, timestamp, allocations, validators, maxShare = DEFAULT_MAX_SHARE }) {
  return {
    chainId,
    timestamp,
    maxShare,
    allocations: [...allocations].sort(),
    validators: validators
      .map((v) => ({ publicKey: v.publicKey, stake: String(v.stake) }))
      .sort((a, b) => (a.publicKey < b.publicKey ? -1 : 1)),
  };
}

export function validateGenesis(config) {
  const bad = (msg) => new ChainError("BAD_GENESIS", msg);
  if (config === null || typeof config !== "object") throw bad("ملف التأسيس غير صالح.");
  if (typeof config.chainId !== "string" || config.chainId.length === 0) throw bad("معرّف الشبكة غير صالح.");
  if (!(config.maxShare > 0 && config.maxShare <= 1)) throw bad("حد الحصة يجب أن يكون في (0, 1].");
  if (!Array.isArray(config.validators) || config.validators.length === 0) throw bad("لا يوجد مدققون في التأسيس.");
  const seen = new Set();
  for (const v of config.validators) {
    if (!HEX_64.test(v.publicKey)) throw bad("مفتاح مدقق غير صالح.");
    if (seen.has(v.publicKey)) throw bad("مدقق مكرر في التأسيس.");
    if (!DECIMAL_STAKE.test(v.stake)) throw bad("حصة المدقق يجب أن تكون عدداً صحيحاً موجباً.");
    seen.add(v.publicKey);
  }
}

const allocationsRoot = (config) => merkleRoot(config.allocations.map((address) => sha256Hex(address)));

export function genesisBlock(config) {
  const block = {
    height: 0,
    timestamp: config.timestamp,
    prevHash: GENESIS_PREV_HASH,
    merkleRoot: sha256Hex(canonicalJson(config)), // commits the whole genesis configuration
    evidenceRoot: merkleRoot([]),
    txs: [],
    evidence: [],
    certificate: null,
  };
  block.hash = blockHashOf(block);
  return block;
}

export function genesisState(config) {
  validateGenesis(config);
  const ledger = new Ledger();
  for (const address of config.allocations) {
    // Testnet only: every allocation gets one faucet-sized credit.
    ledger.credit(address, TESTNET_FAUCET_UNITS);
  }
  const stakes = new Map(config.validators.map((v) => [v.publicKey, BigInt(v.stake)]));
  return { ledger, stakes, jailed: new Set() };
}

// ---------- State and validator set ----------

export async function cloneState(state) {
  return {
    ledger: await Ledger.fromSnapshot(JSON.parse(JSON.stringify(state.ledger))),
    stakes: new Map(state.stakes),
    jailed: new Set(state.jailed),
  };
}

// Active validators are those that are not jailed. Weights are capped so no one holds more than maxShare.
export function validatorWeights(state, maxShare) {
  const active = new Map();
  for (const [id, stake] of state.stakes) {
    if (!state.jailed.has(id)) active.set(id, Number(stake));
  }
  let weights;
  try {
    weights = capWeights(active, maxShare);
  } catch (err) {
    throw new ChainError("NOT_ENOUGH_VALIDATORS", err.message);
  }
  const total = [...weights.values()].reduce((a, b) => a + b, 0);
  return { weights, total };
}

// ---------- Blocks ----------

export const blockHashOf = (block) =>
  sha256Hex(
    canonicalJson({
      height: block.height,
      timestamp: block.timestamp,
      prevHash: block.prevHash,
      merkleRoot: block.merkleRoot,
      evidenceRoot: block.evidenceRoot,
    }),
  );

const evidenceRootOf = (evidence) => merkleRoot(evidence.map((e) => sha256Hex(canonicalJson(e))));

// Builds an unsigned block. Evidence is sorted by key, so the block bytes do not depend on arrival order.
export function buildBlock({ height, timestamp, prevHash, txs, evidence = [] }) {
  const normalized = txs.map(normalizeTx);
  const sorted = evidence.map(normalizeEvidence).sort((a, b) => (evidenceKey(a) < evidenceKey(b) ? -1 : 1));
  const block = {
    height,
    timestamp,
    prevHash,
    merkleRoot: merkleRoot(normalized.map(txId)),
    evidenceRoot: evidenceRootOf(sorted),
    txs: normalized,
    evidence: sorted,
    certificate: null,
  };
  block.hash = blockHashOf(block);
  return block;
}

// Checks that the commit certificate was signed by a strict majority above two thirds of the validator
// set that was active before this block. Signatures from unknown, jailed or repeated validators do not count.
export async function verifyCertificate(chainId, parentState, block, maxShare) {
  const cert = block.certificate;
  if (cert === null || typeof cert !== "object" || !Number.isInteger(cert.round) || cert.round < 0) {
    throw new ChainError("BAD_CERTIFICATE", "الكتلة بلا شهادة اعتماد صالحة.");
  }
  if (!Array.isArray(cert.signatures)) throw new ChainError("BAD_CERTIFICATE", "شكل شهادة الاعتماد غير صالح.");
  const { weights, total } = validatorWeights(parentState, maxShare);
  const message = (round) => voteMessage(chainId, "precommit", block.height, round, block.hash);
  const seen = new Set();
  let power = 0;
  for (const { validator, signature } of cert.signatures) {
    if (!weights.has(validator) || seen.has(validator)) {
      throw new ChainError("BAD_CERTIFICATE", "توقيع من مدقق غير معتمد أو مكرر.");
    }
    seen.add(validator);
    if (!(await verifyText(validator, message(cert.round), signature))) {
      throw new ChainError("BAD_CERTIFICATE", "توقيع الاعتماد غير صحيح.");
    }
    power += weights.get(validator);
  }
  if (!hasQuorum(power, total)) throw new ChainError("NO_QUORUM", "شهادة الاعتماد لا تبلغ أكثر من الثلثين.");
}

// Validates one block against its parent and returns the state after it. Throws ChainError on any problem.
// It never modifies `state`. It does not check the certificate: see applyCommitted for that.
export async function applyBlock(state, block, parent, config) {
  if (block === null || typeof block !== "object" || !Array.isArray(block.txs) || !Array.isArray(block.evidence)) {
    throw new ChainError("BAD_BLOCK", "شكل الكتلة غير صالح.");
  }
  if (block.height !== parent.height + 1) throw new ChainError("BAD_HEIGHT", "ارتفاع الكتلة غير متسلسل.");
  if (block.prevHash !== parent.hash) throw new ChainError("BAD_PARENT", "الكتلة لا تشير إلى الكتلة السابقة الصحيحة.");
  if (block.hash !== blockHashOf(block)) throw new ChainError("BAD_HASH", "بصمة الكتلة لا تطابق محتواها.");
  for (const tx of block.txs) {
    if (canonicalJson(tx) !== canonicalJson(normalizeTx(tx))) {
      throw new ChainError("BAD_TX", "المعاملة تحتوي على حقول غير مسموحة.");
    }
  }
  if (block.merkleRoot !== merkleRoot(block.txs.map(txId))) {
    throw new ChainError("BAD_MERKLE", "جذر Merkle لا يطابق المعاملات.");
  }
  if (block.evidenceRoot !== evidenceRootOf(block.evidence)) {
    throw new ChainError("BAD_EVIDENCE_ROOT", "جذر الأدلة لا يطابق محتواها.");
  }

  const next = await cloneState(state);
  let previousKey = null;
  for (const raw of block.evidence) {
    const ev = normalizeEvidence(raw);
    if (canonicalJson(raw) !== canonicalJson(ev)) throw new ChainError("BAD_EVIDENCE", "حقول دليل غير مسموحة.");
    const key = evidenceKey(ev);
    if (previousKey !== null && key <= previousKey) {
      throw new ChainError("BAD_EVIDENCE", "الأدلة غير مرتبة أو مكررة.");
    }
    previousKey = key;
    if (ev.height >= block.height) throw new ChainError("BAD_EVIDENCE", "الدليل يخص كتلة لم تُعتمد بعد.");
    await verifyEvidence(ev, config.chainId, next);
    const stake = next.stakes.get(ev.validator);
    next.stakes.set(ev.validator, stake - (stake * SLASH_PERCENT) / 100n);
    next.jailed.add(ev.validator);
  }

  for (const tx of block.txs) {
    try {
      await next.ledger.transfer(tx);
    } catch (err) {
      throw new ChainError("BAD_TX", `معاملة غير صالحة داخل الكتلة: ${err.message}`);
    }
  }
  return next;
}

// A block is accepted only with a valid certificate for the validator set that was active before it.
export async function applyCommitted(state, block, parent, config) {
  await verifyCertificate(config.chainId, state, block, config.maxShare);
  return applyBlock(state, block, parent, config);
}

// Rebuilds the full state from genesis. Used on startup and when syncing from a peer.
export async function replayChain(blocks, config) {
  if (!Array.isArray(blocks) || blocks.length === 0) throw new ChainError("EMPTY_CHAIN", "السلسلة فارغة.");
  const genesis = genesisBlock(config);
  if (canonicalJson(blocks[0]) !== canonicalJson(genesis)) {
    throw new ChainError("BAD_GENESIS", "الكتلة الأولى لا تطابق الكتلة التأسيسية.");
  }
  let state = genesisState(config);
  let parent = { height: 0, hash: genesis.hash };
  for (const block of blocks.slice(1)) {
    state = await applyCommitted(state, block, parent, config);
    parent = { height: block.height, hash: block.hash };
  }
  return state;
}
