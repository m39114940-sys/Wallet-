// Gas accounting for the new Testnet. Fee = gasUsed × gasPrice, charged once.
// Every limit is checked before execution, so an unbounded transaction cannot consume node resources.
import { EvmError } from "./errors.js";
import { TESTNET_GAS_POLICY } from "./params.js";

export function checkGasLimit(gasLimit, policy = TESTNET_GAS_POLICY) {
  if (typeof gasLimit !== "bigint" || gasLimit <= 0n) {
    throw new EvmError("BAD_GAS_LIMIT", "gas limit must be a positive BigInt");
  }
  if (gasLimit > policy.maxGasLimitPerTx) {
    throw new EvmError("GAS_LIMIT_TOO_HIGH", "gas limit exceeds the per-transaction cap");
  }
  return gasLimit;
}

export function feeFor(gasUsed, gasLimit, policy = TESTNET_GAS_POLICY) {
  checkGasLimit(gasLimit, policy);
  if (typeof gasUsed !== "bigint" || gasUsed < 0n || gasUsed > gasLimit) {
    throw new EvmError("BAD_GAS_USED", "gas used must be between 0 and the gas limit");
  }
  return gasUsed * policy.gasPriceBase;
}

// Sum of declared gas limits in one block must stay within the block cap.
export function checkBlockGas(totalGasLimit, policy = TESTNET_GAS_POLICY) {
  if (typeof totalGasLimit !== "bigint" || totalGasLimit < 0n) {
    throw new EvmError("BAD_GAS_LIMIT", "block gas total must be a non-negative BigInt");
  }
  if (totalGasLimit > policy.blockGasLimit) {
    throw new EvmError("BLOCK_GAS_TOO_HIGH", "declared gas exceeds the block cap");
  }
  return totalGasLimit;
}

// Maximum fee a sender must be able to pay before execution starts.
export function maxFeeFor(gasLimit, policy = TESTNET_GAS_POLICY) {
  checkGasLimit(gasLimit, policy);
  return gasLimit * policy.gasPriceBase;
}
