import { test } from "node:test";
import assert from "node:assert/strict";
import { EvmError } from "../evm/errors.js";
import { BASE_PER_SNN, EVM_CHAIN_IDS } from "../evm/params.js";
import { signTransfer, senderOf, EVM_TX_ENABLED } from "../evm/tx.js";

// Private key 1 (secp256k1). Its address is a public reference value.
const KEY1 = new Uint8Array(32);
KEY1[31] = 1;
const KEY1_ADDRESS = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const RECIPIENT = "0x1111111111111111111111111111111111111111";

function expectEvmError(fn, code) {
  assert.throws(fn, (err) => err instanceof EvmError && err.code === code);
}

test("EVM transaction support is disabled by default", () => {
  assert.equal(EVM_TX_ENABLED, false);
});

test("the sender recovered from the signature is the key's address", () => {
  const tx = signTransfer({ privateKey: KEY1, nonce: 0, gasLimit: 21_000n, to: RECIPIENT, value: BASE_PER_SNN });
  assert.equal(senderOf(tx), KEY1_ADDRESS);
});

test("a zero-value transfer is allowed; a value below the minimum is refused", () => {
  const zero = signTransfer({ privateKey: KEY1, nonce: 1, gasLimit: 21_000n, to: RECIPIENT, value: 0n });
  assert.equal(senderOf(zero), KEY1_ADDRESS);
  expectEvmError(
    () => signTransfer({ privateKey: KEY1, nonce: 0, gasLimit: 21_000n, to: RECIPIENT, value: 1n }),
    "BELOW_MINIMUM",
  );
});

test("the same transaction on another chain has a different signing hash (replay protection)", () => {
  const testnet = signTransfer({ privateKey: KEY1, nonce: 0, gasLimit: 21_000n, to: RECIPIENT, value: BASE_PER_SNN });
  const mainnet = signTransfer({
    privateKey: KEY1,
    nonce: 0,
    gasLimit: 21_000n,
    to: RECIPIENT,
    value: BASE_PER_SNN,
    chainId: EVM_CHAIN_IDS.mainnet,
  });
  assert.notDeepEqual(Buffer.from(testnet.getHashedMessageToSign()), Buffer.from(mainnet.getHashedMessageToSign()));
  assert.equal(senderOf(mainnet), KEY1_ADDRESS);
});

test("a gas limit above the cap is refused before signing", () => {
  expectEvmError(
    () => signTransfer({ privateKey: KEY1, nonce: 0, gasLimit: 3_000_001n, to: RECIPIENT, value: 0n }),
    "GAS_LIMIT_TOO_HIGH",
  );
});

test("malformed inputs are refused", () => {
  expectEvmError(() => signTransfer({ privateKey: new Uint8Array(31), nonce: 0, gasLimit: 21_000n, to: RECIPIENT, value: 0n }), "BAD_KEY");
  expectEvmError(() => signTransfer({ privateKey: KEY1, nonce: -1, gasLimit: 21_000n, to: RECIPIENT, value: 0n }), "BAD_NONCE");
  expectEvmError(() => signTransfer({ privateKey: KEY1, nonce: 0, gasLimit: 21_000n, to: "0xABC", value: 0n }), "BAD_ADDRESS");
  expectEvmError(() => signTransfer({ privateKey: KEY1, nonce: 0, gasLimit: 21_000n, to: RECIPIENT, value: -1n }), "BAD_VALUE");
});
