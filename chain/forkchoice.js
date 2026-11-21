// Fork choice for synced chains. Pure functions: no I/O, no state.
//
// Two rules, both needed:
// 1. Finality: a candidate chain must contain every block this node has committed. Committed blocks
//    carry commit certificates, so rewriting one would require more than a third of validator weight.
//    A candidate that diverges from the committed prefix is refused, whatever its length or work.
// 2. Preference: among candidates that keep the committed prefix, the one with more cumulative work
//    wins under 'hybrid-v1'. Under the Testnet rules work is one per block, so length decides as before.

import { PowError } from "./pow.js";

const TWO_256 = 1n << 256n;

// Work of one block: 2^256 / (target + 1), the expected number of hashes to find it.
export function workOfBlock(block, config) {
  if (block.work === undefined) return 0n; // genesis, or a block without proof of work
  const target = BigInt("0x" + block.work.target);
  if (target <= 0n) throw new PowError("POW_BAD_TARGET", "هدف إثبات العمل صفر.");
  return TWO_256 / (target + 1n);
}

export function chainWork(blocks, config) {
  let total = 0n;
  for (const block of blocks.slice(1)) total += config.rules === "hybrid-v1" ? workOfBlock(block, config) : 1n;
  return total;
}

// True if `candidate` starts with every block of `local` (same hashes at the same heights).
export function keepsCommittedPrefix(local, candidate) {
  if (candidate.length < local.length) return false;
  for (let i = 0; i < local.length; i++) {
    if (candidate[i].hash !== local[i].hash) return false;
  }
  return true;
}

// Decides whether a candidate that has already been validated should replace the local chain.
// Returns { adopt, reason }. The reason is one of: 'diverges', 'lighter', 'heavier'.
export function decideAdoption(local, candidate, config) {
  if (!keepsCommittedPrefix(local, candidate)) return { adopt: false, reason: "diverges" };
  if (config.rules === "hybrid-v1") {
    const cw = chainWork(candidate, config);
    const lw = chainWork(local, config);
    return cw > lw ? { adopt: true, reason: "heavier" } : { adopt: false, reason: "lighter" };
  }
  return candidate.length > local.length ? { adopt: true, reason: "heavier" } : { adopt: false, reason: "lighter" };
}
