// Adaptive issuance: the amount is the smallest of four limits. Issuance is never the primary security funding.
import { ISSUANCE } from "./params.js";
import { BPS, assertBps, assertUnits, minOf } from "./units.js";

export function issuanceAmount({
  deficit,
  remainingBudget,
  circulating,
  remainingSupply,
  capBps = ISSUANCE.maxPerBlockBps,
}) {
  assertUnits(deficit, "deficit");
  assertUnits(remainingBudget, "remainingBudget");
  assertUnits(circulating, "circulating");
  assertUnits(remainingSupply, "remainingSupply");
  assertBps(capBps, "capBps");
  const perBlockCap = (circulating * capBps) / BPS;
  return minOf([deficit, remainingBudget, perBlockCap, remainingSupply]);
}
