// Fee split: validators, treasury, burn (or operations when burn is off). The shares sum exactly to the fee.
import { FEE_SPLIT_BPS } from "./params.js";
import { BPS, assertUnits } from "./units.js";

export function splitFee(fee, { burnEnabled }) {
  assertUnits(fee, "fee");
  const validators = (fee * FEE_SPLIT_BPS.validators) / BPS;
  const treasury = (fee * FEE_SPLIT_BPS.treasury) / BPS;
  const rest = fee - validators - treasury;
  const burn = burnEnabled ? rest : 0n;
  const operations = rest - burn;
  return { validators, treasury, burn, operations };
}
