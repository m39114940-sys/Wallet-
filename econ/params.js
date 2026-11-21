// Model F parameters. These are proposals for isolated Testnet validation only.
// They are not Mainnet values and do not activate anything by being present (see flags.js).
import { BPS } from "./units.js";

export { BPS };

export const UNIT = 1_000_000n;                    // micro-SNN per SNN
export const MAX_SUPPLY = 100_000_000n * UNIT;     // hard ceiling; never silently raised

// Fee split. Validators 85%, treasury 10%; the exact remainder (about 5%) is burned,
// or routed to operations when the burn flag is off.
export const FEE_SPLIT_BPS = Object.freeze({ validators: 8_500n, treasury: 1_000n });

// Dynamic base fee: at most +50% per block when utilisation is above target, at most -12.5% below.
export const FEE_CONTROLLER = Object.freeze({
  targetUtilBps: 5_000n,
  upStepBps: 5_000n,
  downStepBps: 1_250n,
  minFee: 1_000n,      // 0.001 SNN
  maxFee: 1_000_000n,  // 1 SNN
});

// Adaptive issuance is decided once per epoch and capped at 1% of circulating supply per epoch.
// Placeholder epoch length (about one year of 10-minute blocks); to be confirmed by the owner.
export const DEFAULT_EPOCH_BLOCKS = 52_560;
export const ISSUANCE = Object.freeze({ maxPerEpochBps: 100n });

// Experimental PoW/PoS split of issued rewards. Not an approved ratio; attack-cost assessment is pending.
export const DEFAULT_POW_SHARE_BPS = 5_000n;
