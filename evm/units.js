// SNN amounts with 18 decimal places. Amounts are parsed from strings and never passed through floating point.
// An amount with more precision than the protocol supports is refused, never rounded.
import { BASE_PER_SNN, MIN_TRANSFER_BASE, SNN_DECIMALS } from "./params.js";
import { EvmError } from "./errors.js";

const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)(\.[0-9]+)?$/;

export function snnToBase(input) {
  if (typeof input !== "string" || !DECIMAL_PATTERN.test(input)) {
    throw new EvmError("BAD_AMOUNT", "amount must be a plain decimal string such as \"1.5\"");
  }
  const [whole, fraction = ""] = input.split(".");
  if (fraction.length > SNN_DECIMALS) {
    throw new EvmError("TOO_PRECISE", `amount has more than ${SNN_DECIMALS} decimal places`);
  }
  return BigInt(whole) * BASE_PER_SNN + BigInt(fraction.padEnd(SNN_DECIMALS, "0"));
}

export function baseToSnn(base) {
  if (typeof base !== "bigint" || base < 0n) {
    throw new EvmError("BAD_AMOUNT", "base amount must be a non-negative BigInt");
  }
  const whole = base / BASE_PER_SNN;
  const fraction = (base % BASE_PER_SNN).toString().padStart(SNN_DECIMALS, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function assertTransferable(base) {
  if (typeof base !== "bigint") throw new EvmError("BAD_AMOUNT", "transfer amount must be a BigInt");
  if (base < MIN_TRANSFER_BASE) {
    throw new EvmError("BELOW_MINIMUM", "transfer is below the 0.000001 SNN minimum");
  }
  return base;
}
