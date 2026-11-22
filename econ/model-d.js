// Model D reference values for SmartNode Network vesting, in blocks.
//
// These are Testnet reference values from the approved decision document. They are not Genesis.
// Nothing here changes the current Testnet or Mainnet. A new chain may copy these entries into
// its own Genesis only after the owner approves that Genesis.
//
// Block timing: 10 s blocks, 720 blocks per epoch (2 h), 12 epochs per day, 365 days per year.

export const BLOCK_SECONDS = 10;
export const BLOCKS_PER_EPOCH = 720;
export const EPOCHS_PER_DAY = 12;
export const BLOCKS_PER_YEAR = BLOCKS_PER_EPOCH * EPOCHS_PER_DAY * 365; // 3,153,600
export const EMISSION_BLOCKS = BLOCKS_PER_YEAR * 10; // 31,536,000 (10 years)

// Each entry follows the vesting shape of chain/core.js: cliffBlocks, cliffReleaseBps, durationBlocks.
// cliffReleaseBps is the share released at the cliff, in basis points (10000 = 100%).
export const MODEL_D_VESTING = Object.freeze({
  // Read literally: "سنة انتظار ثم تحرير تدريجي على 3 سنوات" means nothing is released at the cliff,
  // then linear release over three years. The earlier simulation used 25% at the cliff.
  // This needs owner confirmation before it is used anywhere.
  founder: { cliffBlocks: BLOCKS_PER_YEAR, cliffReleaseBps: 0, durationBlocks: BLOCKS_PER_YEAR * 3 },
  company: { cliffBlocks: BLOCKS_PER_YEAR, cliffReleaseBps: 0, durationBlocks: BLOCKS_PER_YEAR * 3 },
  // Same shape as founder and company, from the same wording of the decision document.
  team: { cliffBlocks: BLOCKS_PER_YEAR, cliffReleaseBps: 0, durationBlocks: BLOCKS_PER_YEAR * 3 },
  ecosystem: { cliffBlocks: 0, cliffReleaseBps: 0, durationBlocks: BLOCKS_PER_YEAR * 4 },
  // Locked for 12 months, then fully released.
  liquidity: { cliffBlocks: BLOCKS_PER_YEAR, cliffReleaseBps: 10_000, durationBlocks: 0 },
});

// Entries the decision document leaves open. They have no numeric rule yet, so they are not configured.
export const MODEL_D_OPEN = Object.freeze(["community", "reserve"]);

export function modelDVesting(name) {
  const entry = MODEL_D_VESTING[name];
  if (entry === undefined) throw new Error(`Model D has no vesting rule for ${name}.`);
  return { ...entry };
}
