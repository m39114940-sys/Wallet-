// Feature flags for Model F. Every flag defaults to OFF.
// Mainnet refuses any enabled flag: activation there needs explicit written owner approval,
// which this code cannot verify, so it is not accepted here at all.
import { EconError } from "./errors.js";

export const FLAG_NAMES = Object.freeze([
  "feeEngine",
  "dynamicFee",
  "securityReward",
  "adaptiveIssuance",
  "treasuryLedgers",
  "burn",
  "validatorRewards",
  "emergencyControls",
]);

export const NETWORKS = Object.freeze(["testnet", "mainnet"]);

// A flag may only be on if the flags it relies on are on too.
const DEPENDS_ON = Object.freeze({
  feeEngine: ["treasuryLedgers"],
  dynamicFee: ["feeEngine"],
  burn: ["feeEngine"],
  securityReward: ["treasuryLedgers"],
  adaptiveIssuance: ["securityReward"],
});

export function resolveFlags(network, requested = {}) {
  if (!NETWORKS.includes(network)) {
    throw new EconError("BAD_NETWORK", `unknown network "${network}"`);
  }
  const flags = Object.fromEntries(FLAG_NAMES.map((name) => [name, false]));
  for (const [name, value] of Object.entries(requested)) {
    if (!FLAG_NAMES.includes(name)) throw new EconError("UNKNOWN_FLAG", `unknown flag "${name}"`);
    if (typeof value !== "boolean") throw new EconError("BAD_FLAG", `flag "${name}" must be boolean`);
    flags[name] = value;
  }
  for (const [name, deps] of Object.entries(DEPENDS_ON)) {
    if (!flags[name]) continue;
    for (const dep of deps) {
      if (!flags[dep]) throw new EconError("FLAG_DEPENDENCY", `"${name}" requires "${dep}"`);
    }
  }
  if (network === "mainnet" && Object.values(flags).some(Boolean)) {
    throw new EconError(
      "MAINNET_ACTIVATION_FORBIDDEN",
      "Model F flags cannot be enabled on Mainnet without explicit written owner approval",
    );
  }
  return Object.freeze(flags);
}
