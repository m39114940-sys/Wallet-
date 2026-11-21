// Split of issued rewards between PoW and PoS pools. The ratio is a configurable experimental parameter.
import { BPS, assertBps, assertUnits } from "./units.js";

export function splitIssuance(amount, powShareBps) {
  assertUnits(amount, "amount");
  assertBps(powShareBps, "powShareBps");
  const pow = (amount * powShareBps) / BPS;
  return { pow, pos: amount - pow };
}
