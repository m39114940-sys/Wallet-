// Dynamic base fee. One step per block: rises at most 50%, falls at most 12.5%, stays inside [minFee, maxFee].
import { EconError } from "./errors.js";
import { FEE_CONTROLLER } from "./params.js";
import { BPS, assertBps, assertUnits } from "./units.js";

export function nextBaseFee(current, utilBps, c = FEE_CONTROLLER) {
  assertUnits(current, "baseFee");
  assertBps(utilBps, "utilBps");
  if (current < c.minFee || current > c.maxFee) {
    throw new EconError("BAD_BASE_FEE", "current base fee is outside the configured bounds");
  }
  let next;
  if (utilBps > c.targetUtilBps) next = (current * (BPS + c.upStepBps)) / BPS;
  else if (utilBps < c.targetUtilBps) next = (current * (BPS - c.downStepBps)) / BPS;
  else next = current;
  if (next < c.minFee) next = c.minFee;
  if (next > c.maxFee) next = c.maxFee;
  return next;
}
