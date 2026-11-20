// SNN chain core (Phase 1): hashing, Merkle roots, signed blocks, validation and replay.
// Everything here is deterministic and shared by every node, so two nodes with the same genesis
// and the same blocks always reach the same state.

import { createHash } from "node:crypto";
import { Ledger, TESTNET_FAUCET_UNITS, parseAmount, formatAmount } from "../js/ledger.js";
import { importSigningKey, fromHex, toHex } from "../js/signing.js";

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();

export const GENESIS_PREV_HASH = "0".repeat(64);

export class ChainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ChainError";
    this.code = code;
  }
}

export const sha256Hex = (text) => createHash("sha256").update(text).digest("hex");

// Stable JSON: keys sorted, so the same data always produces the same bytes.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

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

const headerOf = (block) => ({
  height: block.height,
  timestamp: block.timestamp,
  prevHash: block.prevHash,
  merkleRoot: block.merkleRoot,
  producer: block.producer,
});

export const blockHashOf = (block) => sha256Hex(canonicalJson(headerOf(block)));

async function importProducer(privateKeyDerHex) {
  return importSigningKey(fromHex(privateKeyDerHex));
}

export async function signText(privateKeyDerHex, text) {
  const key = await importProducer(privateKeyDerHex);
  return toHex(new Uint8Array(await subtle.sign("Ed25519", key, encoder.encode(text))));
}

export async function verifyText(publicKeyHex, text, signatureHex) {
  try {
    const key = await subtle.importKey("raw", fromHex(publicKeyHex), { name: "Ed25519" }, false, ["verify"]);
    return await subtle.verify("Ed25519", key, fromHex(signatureHex), encoder.encode(text));
  } catch {
    return false;
  }
}

// ---------- Genesis ----------

export function createGenesisConfig({ chainId, timestamp, allocations, producerPublicKey }) {
  return {
    chainId,
    timestamp,
    producerPublicKey,
    // Testnet only: each allocation is one faucet-sized credit. Real genesis allocations need their own rules.
    allocations: [...allocations].sort(),
  };
}

const allocationsRoot = (config) => merkleRoot(config.allocations.map((address) => sha256Hex(address)));

export function genesisBlock(config) {
  const block = {
    height: 0,
    timestamp: config.timestamp,
    prevHash: GENESIS_PREV_HASH,
    merkleRoot: allocationsRoot(config),
    producer: config.producerPublicKey,
    txs: [],
    signature: null,
  };
  block.hash = blockHashOf(block);
  return block;
}

export function genesisState(config) {
  const ledger = new Ledger();
  for (const address of config.allocations) {
    ledger.credit(address, TESTNET_FAUCET_UNITS);
  }
  return ledger;
}

// ---------- Blocks ----------

export async function buildBlock({ height, timestamp, prevHash, txs, producer, privateKeyDerHex }) {
  const normalized = txs.map(normalizeTx);
  const block = {
    height,
    timestamp,
    prevHash,
    merkleRoot: merkleRoot(normalized.map(txId)),
    producer,
    txs: normalized,
  };
  block.hash = blockHashOf(block);
  block.signature = await signText(privateKeyDerHex, block.hash);
  return block;
}

export async function cloneState(state) {
  return Ledger.fromSnapshot(JSON.parse(JSON.stringify(state)));
}

// Validates one block against the expected parent, and returns the state after applying it.
// Throws ChainError on any violation. It never modifies `state`.
export async function applyBlock(state, block, parent, expectedProducer) {
  if (block === null || typeof block !== "object" || !Array.isArray(block.txs)) {
    throw new ChainError("BAD_BLOCK", "شكل الكتلة غير صالح.");
  }
  if (block.height !== parent.height + 1) throw new ChainError("BAD_HEIGHT", "ارتفاع الكتلة غير متسلسل.");
  if (block.prevHash !== parent.hash) throw new ChainError("BAD_PARENT", "الكتلة لا تشير إلى الكتلة السابقة الصحيحة.");
  if (block.producer !== expectedProducer) throw new ChainError("BAD_PRODUCER", "منتج الكتلة غير معتمد.");
  if (block.hash !== blockHashOf(block)) throw new ChainError("BAD_HASH", "بصمة الكتلة لا تطابق محتواها.");
  if (!(await verifyText(block.producer, block.hash, block.signature))) {
    throw new ChainError("BAD_SIGNATURE", "توقيع منتج الكتلة غير صحيح.");
  }
  for (const tx of block.txs) {
    if (canonicalJson(tx) !== canonicalJson(normalizeTx(tx))) {
      throw new ChainError("BAD_TX", "المعاملة تحتوي على حقول غير مسموحة.");
    }
  }
  if (block.merkleRoot !== merkleRoot(block.txs.map(txId))) {
    throw new ChainError("BAD_MERKLE", "جذر Merkle لا يطابق المعاملات.");
  }

  const trial = await cloneState(state);
  for (const tx of block.txs) {
    try {
      await trial.transfer(tx);
    } catch (err) {
      throw new ChainError("BAD_TX", `معاملة غير صالحة داخل الكتلة: ${err.message}`);
    }
  }
  return trial;
}

// Rebuilds the full state from a list of blocks, starting at genesis. Used on startup and when syncing.
export async function replayChain(blocks, config) {
  if (!Array.isArray(blocks) || blocks.length === 0) throw new ChainError("EMPTY_CHAIN", "السلسلة فارغة.");
  const genesis = genesisBlock(config);
  if (canonicalJson(blocks[0]) !== canonicalJson(genesis)) {
    throw new ChainError("BAD_GENESIS", "الكتلة الأولى لا تطابق الكتلة التأسيسية.");
  }
  let state = genesisState(config);
  let parent = { height: 0, hash: genesis.hash };
  for (const block of blocks.slice(1)) {
    state = await applyBlock(state, block, parent, config.producerPublicKey);
    parent = { height: block.height, hash: block.hash };
  }
  return state;
}
