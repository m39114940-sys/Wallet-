// Hybrid consensus simulation for SNN. Single process, deterministic, Node only.
// It models the rules, not a network: validators are plain objects, and "messages" are function calls.
// Production needs a VRF for proposer selection, real signatures, and a P2P layer (SNN Phases 3-4).

import { createHash } from "node:crypto";

export const DEFAULT_MAX_SHARE = 0.1; // no single validator may carry more than 10% of effective weight
export const SLASH_FRACTION = 0.05; // stake burned for equivocation
export const OFFLINE_SLASH_FRACTION = 0.001; // small penalty for missed duties, so downtime is not free

// Caps each validator's weight, so a large stake cannot dominate. Clipping is repeated until it converges.
// Note: a cap is per identity. It does not stop one operator who splits stake across many identities.
export function capWeights(stakes, maxShare = DEFAULT_MAX_SHARE) {
  const ids = [...stakes.keys()];
  if (ids.length === 0) throw new Error("لا يوجد مدققون.");
  if (ids.length * maxShare < 1) {
    throw new Error(`يلزم ${Math.ceil(1 / maxShare)} مدققين على الأقل لتطبيق حد ${maxShare * 100}%.`);
  }
  for (const [id, stake] of stakes) {
    if (!(stake > 0)) throw new Error(`حصة المدقق ${id} يجب أن تكون موجبة.`);
  }
  const weights = new Map(stakes);
  for (;;) {
    const total = [...weights.values()].reduce((a, b) => a + b, 0);
    const cap = maxShare * total;
    let clipped = false;
    for (const [id, w] of weights) {
      if (w > cap + 1e-12) {
        weights.set(id, cap);
        clipped = true;
      }
    }
    if (!clipped) return weights;
  }
}

// Deterministic, stake-weighted proposer choice. Inputs are public, so this is predictable.
// That is acceptable for the simulation only. Production must use a VRF.
export function proposerFor(weights, height, round) {
  const ids = [...weights.keys()].sort();
  const total = ids.reduce((sum, id) => sum + weights.get(id), 0);
  const digest = createHash("sha256").update(`snn-proposer|${height}|${round}`).digest();
  const fraction = Number(digest.readBigUInt64BE(0)) / 2 ** 64;
  let target = fraction * total;
  for (const id of ids) {
    target -= weights.get(id);
    if (target < 0) return id;
  }
  return ids[ids.length - 1];
}

// Finalization needs strictly more than 2/3 of total weight, from distinct validators, for the same block.
export function hasQuorum(power, total) {
  return power * 3 > total * 2;
}

// votes: [{ validator, height, round, blockHash }]. A validator is counted once per block, whatever its duplicates.
export function tallyPrecommits(votes, weights, height, round) {
  const total = [...weights.values()].reduce((a, b) => a + b, 0);
  const byBlock = new Map();
  for (const vote of votes) {
    if (vote.height !== height || vote.round !== round) continue;
    if (!weights.has(vote.validator)) continue;
    if (!byBlock.has(vote.blockHash)) byBlock.set(vote.blockHash, new Set());
    byBlock.get(vote.blockHash).add(vote.validator);
  }
  let best = 0;
  for (const [blockHash, voters] of byBlock) {
    const power = [...voters].reduce((sum, id) => sum + weights.get(id), 0);
    if (hasQuorum(power, total)) return { committed: true, blockHash, power, total };
    best = Math.max(best, power);
  }
  return { committed: false, power: best, total };
}

// Two different precommits from one validator at one height and round is equivocation (double signing).
export function findEquivocations(votes) {
  const seen = new Map();
  const evidence = new Map();
  for (const vote of votes) {
    const key = `${vote.validator}|${vote.height}|${vote.round}`;
    const previous = seen.get(key);
    if (previous === undefined) {
      seen.set(key, vote.blockHash);
    } else if (previous !== vote.blockHash) {
      evidence.set(vote.validator, { validator: vote.validator, height: vote.height, round: vote.round });
    }
  }
  return [...evidence.values()];
}

// Burns the stake of equivocators and jails them. The result is a new map of stakes and a set of jailed ids.
export function applyEquivocationSlashing(stakes, jailed, evidence) {
  const next = new Map(stakes);
  const nextJailed = new Set(jailed);
  for (const { validator } of evidence) {
    if (!next.has(validator)) continue;
    next.set(validator, next.get(validator) * (1 - SLASH_FRACTION));
    nextJailed.add(validator);
  }
  return { stakes: next, jailed: nextJailed };
}

// Runs rounds for one height until a block is committed or the round budget is spent.
// Offline proposers cause a timeout, and the next round selects another proposer.
// If more than 1/3 of weight is offline, no quorum is possible: the chain halts rather than finalizing unsafely.
export function runHeight({ weights, height, online, jailed = new Set(), maxRounds = 10, blockFor }) {
  const active = new Map([...weights].filter(([id]) => !jailed.has(id)));
  const votes = [];
  for (let round = 0; round < maxRounds; round++) {
    const proposer = proposerFor(active, height, round);
    if (!online.has(proposer)) continue; // timeout, move to the next round
    const blockHash = blockFor(height, round, proposer);
    for (const id of active.keys()) {
      if (online.has(id)) votes.push({ validator: id, height, round, blockHash });
    }
    const result = tallyPrecommits(votes, active, height, round);
    if (result.committed) return { committed: true, round, proposer, blockHash: result.blockHash, votes };
  }
  return { committed: false, votes };
}

// Smallest set of validators (largest weights first) whose combined weight exceeds the threshold share of total.
// threshold 1/3: this set can halt the chain. threshold 2/3: this set can finalize alone.
export function controllingSetSize(weights, threshold) {
  const total = [...weights.values()].reduce((a, b) => a + b, 0);
  const sorted = [...weights.values()].sort((a, b) => b - a);
  let acc = 0;
  for (let i = 0; i < sorted.length; i++) {
    acc += sorted[i];
    if (acc > threshold * total) return i + 1;
  }
  return sorted.length;
}
