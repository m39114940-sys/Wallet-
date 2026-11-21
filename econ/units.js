// Integer helpers. All money is BigInt micro-SNN (1 SNN = 1,000,000 units); basis points use BPS = 10,000.
import { EconError } from "./errors.js";

export const BPS = 10_000n;

export function assertUnits(value, label = "amount") {
  if (typeof value !== "bigint" || value < 0n) {
    throw new EconError("BAD_AMOUNT", `${label} must be a non-negative BigInt`);
  }
  return value;
}

export function assertBps(value, label = "bps") {
  if (typeof value !== "bigint" || value < 0n || value > BPS) {
    throw new EconError("BAD_BPS", `${label} must be a BigInt between 0 and 10000`);
  }
  return value;
}

export function sum(values) {
  let total = 0n;
  for (const v of values) total += assertUnits(v);
  return total;
}

export function minOf(values) {
  return values.reduce((a, b) => (b < a ? b : a));
}
