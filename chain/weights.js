// Exact integer weights for validators: caps, proposer selection and quorum.
// Everything is BigInt, so every node computes the same numbers, with no floating-point drift.
// Caps are in basis points (1 bps = 0.01%), so 1000 bps = 10%.

import { createHash } from "node:crypto";

export const BPS = 10_000n;
export const DEFAULT_MAX_SHARE_BPS = 1_000n; // 10%

// Caps each weight at maxShareBps of the total, repeating until nothing is above the cap.
// Feasibility: n validators can respect a cap only if n * cap >= total, i.e. n * maxShareBps >= BPS.
export function capWeights(stakes, maxShareBps) {
  if (stakes.size === 0) throw new Error("لا يوجد مدققون.");
  for (const [id, stake] of stakes) {
    if (typeof stake !== "bigint" || stake <= 0n) throw new Error(`حصة المدقق ${id} يجب أن تكون موجبة.`);
  }
  if (BigInt(stakes.size) * maxShareBps < BPS) {
    throw new Error(`عدد المدققين لا يكفي لتطبيق حد ${Number(maxShareBps) / 100}%.`);
  }
  const weights = new Map(stakes);
  for (;;) {
    const total = sumOf(weights);
    const cap = (total * maxShareBps) / BPS; // floor: never gives anyone more than the cap
    let clipped = false;
    for (const [id, w] of weights) {
      if (w > cap) {
        weights.set(id, cap);
        clipped = true;
      }
    }
    if (!clipped) return weights;
  }
}

export const sumOf = (weights) => [...weights.values()].reduce((a, b) => a + b, 0n);

// Deterministic proposer for (height, round). The hash gives a uniform integer; it is reduced
// modulo the total weight, then mapped onto validators in id order. Still predictable: see the VRF plan.
export function proposerFor(weights, height, round) {
  const ids = [...weights.keys()].sort();
  const total = sumOf(weights);
  const digest = createHash("sha256").update(`snn-proposer|${height}|${round}`).digest("hex");
  let target = BigInt(`0x${digest}`) % total;
  for (const id of ids) {
    const w = weights.get(id);
    if (target < w) return id;
    target -= w;
  }
  return ids[ids.length - 1];
}

// A quorum needs strictly more than two thirds of the total weight.
export const hasQuorum = (power, total) => power * 3n > total * 2n;

// More than one third of the weight means at least one honest validator is in that round or later.
// The consensus engine uses this to decide when skipping ahead is safe.
export const hasOneThird = (power, total) => power * 3n > total;
