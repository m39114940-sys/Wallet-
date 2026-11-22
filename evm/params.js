// EVM layer parameters. Approved by the owner for the NEW Testnet chain only.
// Mainnet values are deliberately absent: they need a separate decision.

export const SNN_DECIMALS = 18; // protocol and storage precision
export const BASE_PER_SNN = 10n ** 18n; // base units per 1 SNN
export const MIN_TRANSFER_BASE = 10n ** 12n; // 0.000001 SNN, the smallest ordinary transfer

// Chain IDs approved by the owner. Checked against chainid.network and ethereum-lists/chains.
export const EVM_CHAIN_IDS = Object.freeze({
  mainnet: 20261121n,
  testnet: 20261122n,
});

// Gas policy for the new Testnet only. Not valid for Mainnet and not an economic decision.
export const TESTNET_GAS_POLICY = Object.freeze({
  gasPriceBase: 1_000_000_000n, // base units per gas unit (Testnet only)
  maxGasLimitPerTx: 3_000_000n, // hard cap per transaction (strict, as approved)
  blockGasLimit: 30_000_000n, // hard cap per block; must stay >= maxGasLimitPerTx
});
