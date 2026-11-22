// Signed value-transfer transactions for the EVM layer (legacy format with EIP-155 chain binding).
// Only plain value transfers: no contract creation and no calldata. The sender is recovered from the signature, never supplied.
// Disabled by default: EVM_TX_ENABLED stays false until the owner approves enabling it on the Testnet.
import { createLegacyTx } from "@ethereumjs/tx";
import { EvmError } from "./errors.js";
import { assertTransferable } from "./units.js";
import { checkGasLimit } from "./gas.js";
import { createTestnetCommon } from "./engine.js";
import { isEvmAddress } from "./accounts.js";
import { TESTNET_GAS_POLICY, EVM_CHAIN_IDS } from "./params.js";

export const EVM_TX_ENABLED = false;

const hexToBytes = (hex) => Uint8Array.from(Buffer.from(hex.slice(2), "hex"));

// Builds and signs a transfer. `chainId` selects the Common used for EIP-155 binding.
export function signTransfer({ privateKey, nonce, gasLimit, to, value, chainId = EVM_CHAIN_IDS.testnet }) {
  if (!(privateKey instanceof Uint8Array) || privateKey.length !== 32) {
    throw new EvmError("BAD_KEY", "private key must be 32 bytes");
  }
  if (!Number.isSafeInteger(nonce) || nonce < 0) throw new EvmError("BAD_NONCE", "nonce must be a non-negative integer");
  if (!isEvmAddress(to)) throw new EvmError("BAD_ADDRESS", "recipient must be a valid EVM address");
  if (typeof value !== "bigint" || value < 0n) throw new EvmError("BAD_VALUE", "value must be a non-negative BigInt");
  if (value > 0n) assertTransferable(value);
  checkGasLimit(gasLimit, TESTNET_GAS_POLICY);
  const common = createTestnetCommon(chainId);
  const tx = createLegacyTx(
    {
      nonce: BigInt(nonce),
      gasPrice: TESTNET_GAS_POLICY.gasPriceBase,
      gasLimit,
      to: hexToBytes(to),
      value,
      data: new Uint8Array(0),
    },
    { common },
  );
  return tx.sign(privateKey);
}

// Sender recovered from the signature. Returns a lowercase 0x address.
export function senderOf(signedTx) {
  return signedTx.getSenderAddress().toString().toLowerCase();
}
