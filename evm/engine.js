// Minimal EVM execution layer for the new Testnet. Deterministic: the same inputs on the same state give the same state root.
// Every gas limit is checked before execution. No Mainnet configuration exists in this file.
import { Common } from "@ethereumjs/common";
import { createEVM } from "@ethereumjs/evm";
import { Address } from "@ethereumjs/util";
import { EvmError } from "./errors.js";
import { testnetChainConfig, TESTNET_HARDFORK } from "./chain.js";
import { EVM_CHAIN_IDS, TESTNET_GAS_POLICY } from "./params.js";
import { checkGasLimit, feeFor } from "./gas.js";
import { isEvmAddress } from "./accounts.js";

export function createTestnetCommon(chainId = EVM_CHAIN_IDS.testnet) {
  return new Common({ chain: testnetChainConfig(chainId), hardfork: TESTNET_HARDFORK });
}

export async function createTestnetEvm(stateManager) {
  if (!stateManager) throw new EvmError("NO_STATE", "a state manager is required");
  return createEVM({ common: createTestnetCommon(), stateManager });
}

export function addressFromHex(hex) {
  if (!isEvmAddress(hex)) throw new EvmError("BAD_ADDRESS", "EVM address must be 0x followed by 40 lowercase hex characters");
  return new Address(Buffer.from(hex.slice(2), "hex"));
}

export async function stateRootHex(stateManager) {
  const root = await stateManager.getStateRoot();
  return `0x${Buffer.from(root).toString("hex")}`;
}

// Runs one message call on the Testnet EVM. Returns a plain result object for the rest of the node.
export async function runTestnetCall(evm, { caller, to, value = 0n, data = new Uint8Array(0), gasLimit }) {
  checkGasLimit(gasLimit);
  if (typeof value !== "bigint" || value < 0n) throw new EvmError("BAD_VALUE", "value must be a non-negative BigInt");
  const from = addressFromHex(caller);
  const target = to === undefined ? undefined : addressFromHex(to);
  const result = await evm.runCall({
    caller: from,
    origin: from,
    to: target,
    value,
    data,
    gasLimit,
    gasPrice: TESTNET_GAS_POLICY.gasPriceBase,
  });
  const exec = result.execResult;
  const gasUsed = exec.executionGasUsed;
  return {
    success: exec.exceptionError === undefined,
    gasUsed,
    fee: feeFor(gasUsed, gasLimit),
    returnValue: exec.returnValue,
    logs: exec.logs ?? [],
    createdAddress: result.createdAddress?.toString(),
  };
}
