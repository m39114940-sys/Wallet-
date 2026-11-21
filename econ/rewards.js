// Reward distribution. Only signed validators are paid, and only if signed weight is at least two-thirds of total weight.
// Shares round down; the remainder stays in the pool, so no units are created or lost.
import { EconError } from "./errors.js";
import { assertUnits } from "./units.js";

function checkEntries(entries, label) {
  const seen = new Set();
  for (const e of entries) {
    if (typeof e.id !== "string" || e.id.length === 0) {
      throw new EconError("BAD_PARTICIPANT", `${label} id must be a non-empty string`);
    }
    if (seen.has(e.id)) throw new EconError("DUPLICATE_PARTICIPANT", `duplicate ${label} "${e.id}"`);
    seen.add(e.id);
    if (typeof e.weight !== "bigint" || e.weight <= 0n) {
      throw new EconError("BAD_WEIGHT", `${label} "${e.id}" needs a positive BigInt weight`);
    }
  }
}

export function distributeProportional(pool, participants) {
  assertUnits(pool, "pool");
  checkEntries(participants, "participant");
  let totalWeight = 0n;
  for (const p of participants) totalWeight += p.weight;
  const paid = new Map();
  let paidTotal = 0n;
  if (totalWeight > 0n) {
    for (const p of participants) {
      const share = (pool * p.weight) / totalWeight;
      if (share > 0n) {
        paid.set(p.id, share);
        paidTotal += share;
      }
    }
  }
  return { paid, paidTotal, remainder: pool - paidTotal };
}

export function validatorQuorum(validators) {
  checkEntries(validators, "validator");
  let total = 0n;
  let signed = 0n;
  for (const v of validators) {
    if (typeof v.signed !== "boolean") throw new EconError("BAD_SIGNED", `validator "${v.id}" needs a boolean signed flag`);
    total += v.weight;
    if (v.signed) signed += v.weight;
  }
  return { total, signed, meetsQuorum: total > 0n && signed * 3n >= total * 2n };
}

export function payValidators(pool, validators) {
  assertUnits(pool, "pool");
  const quorum = validatorQuorum(validators);
  if (!quorum.meetsQuorum) {
    return { quorumMet: false, paid: new Map(), paidTotal: 0n, remainder: pool };
  }
  const signers = validators.filter((v) => v.signed).map((v) => ({ id: v.id, weight: v.weight }));
  const result = distributeProportional(pool, signers);
  return { quorumMet: true, paid: result.paid, paidTotal: result.paidTotal, remainder: result.remainder };
}
