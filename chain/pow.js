// Proof of Work for the hybrid protocol. Pure functions, no state: a header is valid work when its
// double SHA-256 hash, read as a big-endian integer, is at most the target the chain rules require.
//
// The header commits to the chain id, height, parent hash, Merkle root and timestamp, so work done
// for one block cannot be moved to another block, height, parent, or chain.
// Targets come from the chain rules (see docs/hybrid-consensus.md), never from the miner.
//
// Parameters here are mechanics only. Economic values and the production target bounds are not
// set in this module; they are chosen per network in its genesis config and need owner approval.

import { createHash } from "node:crypto";
import { canonicalJson } from "./crypto.js";

// Errors carry a code; core.js turns them into ChainError at the block boundary.
export class PowError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const TWO_256 = 1n << 256n;
const DOMAIN = "snn-pow-v1";

// Largest change of the target in one retarget window: the new target is within [1/4, 4] of the old one.
export const MAX_RETARGET_FACTOR = 4n;

// Canonical JSON, so field boundaries are unambiguous whatever the chain id contains.
export function headerPreimage({ chainId, height, parentHash, merkleRoot, timestamp, target, nonce }) {
  return Buffer.from(
    canonicalJson({
      domain: DOMAIN,
      chainId,
      height,
      parentHash,
      merkleRoot,
      timestamp,
      target: target.toString(16),
      nonce,
    }),
    "utf8",
  );
}

export function workHash(header) {
  const first = createHash("sha256").update(headerPreimage(header)).digest();
  return BigInt("0x" + createHash("sha256").update(first).digest("hex"));
}

export function meetsTarget(hash, target) {
  return hash <= target;
}

// Checks a block's work against the target the chain rules require at that height.
// The caller passes the expected target; a header that states a different target is rejected.
export function validateWork(header, expectedTarget, chainId) {
  if (header.chainId !== chainId) throw new PowError("POW_WRONG_CHAIN", "إثبات العمل ينتمي إلى سلسلة أخرى.");
  if (header.target !== expectedTarget) throw new PowError("POW_BAD_TARGET", "الهدف في الترويسة لا يطابق قاعدة الشبكة.");
  if (!Number.isInteger(header.nonce) || header.nonce < 0 || header.nonce >= 2 ** 53) {
    throw new PowError("POW_BAD_NONCE", "قيمة nonce غير صالحة.");
  }
  const hash = workHash(header);
  if (!meetsTarget(hash, expectedTarget)) throw new PowError("POW_INVALID", "إثبات العمل لا يستوفي الهدف.");
  return hash;
}

// Searches nonces until one meets the target. Used by miners and by tests; bounded by maxAttempts.
export function mine(header, maxAttempts = 1_000_000) {
  for (let nonce = 0; nonce < maxAttempts; nonce++) {
    const candidate = { ...header, nonce };
    if (meetsTarget(workHash(candidate), header.target)) return candidate;
  }
  throw new PowError("POW_NOT_FOUND", "لم يُعثر على nonce ضمن الحد الأقصى للمحاولات.");
}

// Next target from the time the last window took. Faster than expected raises difficulty (lower target).
// The change per window is clamped to [1/MAX, MAX] and the result stays within [minTarget, maxTarget].
export function nextTarget({ previousTarget, actualSeconds, expectedSeconds, minTarget, maxTarget }) {
  if (actualSeconds <= 0n || expectedSeconds <= 0n) throw new PowError("POW_BAD_WINDOW", "زمن النافذة غير صالح.");
  let actual = actualSeconds;
  const lower = expectedSeconds / MAX_RETARGET_FACTOR;
  const upper = expectedSeconds * MAX_RETARGET_FACTOR;
  if (actual < lower) actual = lower;
  if (actual > upper) actual = upper;
  let target = (previousTarget * actual) / expectedSeconds;
  if (target < minTarget) target = minTarget;
  if (target > maxTarget) target = maxTarget;
  if (target < 1n) target = 1n;
  if (target >= TWO_256) target = TWO_256 - 1n;
  return target;
}

// Median of the last timestamps (Bitcoin-style median time past). A block must be later than this.
export function medianTimePast(timestamps) {
  if (!Array.isArray(timestamps) || timestamps.length === 0) throw new PowError("POW_BAD_WINDOW", "لا توجد طوابع زمنية.");
  const sorted = [...timestamps].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
