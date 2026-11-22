// Applies one signed value transfer to EVM account state. Deterministic: the same entry on the same state gives the same result.
// The entry carries only the signed fields. The sender is recovered from the signature, never supplied.
// Any invalid entry throws, and the caller refuses the whole block.
import { createLegacyTx } from "@ethereumjs/tx";
import { EvmError } from "./errors.js";
import { createTestnetCommon } from "./engine.js";
import { checkGasLimit } from "./gas.js";
import { isEvmAddress } from "./accounts.js";
import { TESTNET_GAS_POLICY } from "./params.js";

export const INTRINSIC_GAS = 21_000n; // a plain value transfer always uses exactly this much gas
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const SIGNED_FIELDS = ["nonce", "gasLimit", "value", "v", "r", "s"];

// entry: { nonce, gasLimit, to, value, v, r, s } where numbers are decimal strings and `to` is a 0x address.
export function applyTransferEntry(accounts, entry, chainId) {
  if (entry === null || typeof entry !== "object") throw new EvmError("BAD_ENTRY", "transfer entry must be an object");
  for (const field of SIGNED_FIELDS) {
    if (typeof entry[field] !== "string" || !DECIMAL.test(entry[field])) {
      throw new EvmError("BAD_ENTRY", `${field} must be a decimal string`);
    }
  }
  if (!isEvmAddress(entry.to)) throw new EvmError("BAD_ADDRESS", "recipient must be a valid EVM address");

  const gasLimit = BigInt(entry.gasLimit);
  if (gasLimit < INTRINSIC_GAS) throw new EvmError("GAS_TOO_LOW", "gas limit is below the transfer's intrinsic gas");
  checkGasLimit(gasLimit, TESTNET_GAS_POLICY);

  let sender;
  try {
    const tx = createLegacyTx(
      {
        nonce: BigInt(entry.nonce),
        gasPrice: TESTNET_GAS_POLICY.gasPriceBase,
        gasLimit,
        to: Uint8Array.from(Buffer.from(entry.to.slice(2), "hex")),
        value: BigInt(entry.value),
        data: new Uint8Array(0),
        v: BigInt(entry.v),
        r: BigInt(entry.r),
        s: BigInt(entry.s),
      },
      { common: createTestnetCommon(chainId) },
    );
    sender = tx.getSenderAddress().toString().toLowerCase();
  } catch {
    throw new EvmError("BAD_SIGNATURE", "transaction signature cannot be verified for this chain");
  }

  const account = accounts.get(sender);
  if (BigInt(account.nonce) !== BigInt(entry.nonce)) {
    throw new EvmError("BAD_NONCE", "nonce does not match the sender account");
  }
  const value = BigInt(entry.value);
  const fee = INTRINSIC_GAS * TESTNET_GAS_POLICY.gasPriceBase; // burned, per the agreed Testnet fee rule
  accounts.debit(sender, value + fee);
  accounts.credit(entry.to, value);
  accounts.bumpNonce(sender);
  return { sender, fee };
}
