import { test } from "node:test";
import assert from "node:assert/strict";
import { EvmError } from "../evm/errors.js";
import { BASE_PER_SNN, EVM_CHAIN_IDS } from "../evm/params.js";
import { signTransfer } from "../evm/tx.js";
import { EvmAccounts } from "../evm/state.js";
import { applyTransferEntry, INTRINSIC_GAS } from "../evm/transfer.js";
import { TESTNET_GAS_POLICY } from "../evm/params.js";

const KEY1 = new Uint8Array(32);
KEY1[31] = 1;
const KEY1_ADDRESS = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const FEE = INTRINSIC_GAS * TESTNET_GAS_POLICY.gasPriceBase;

function toEntry(tx) {
  return {
    nonce: tx.nonce.toString(),
    gasLimit: tx.gasLimit.toString(),
    to: tx.to.toString().toLowerCase(),
    value: tx.value.toString(),
    v: tx.v.toString(),
    r: tx.r.toString(),
    s: tx.s.toString(),
  };
}

function expectEvmError(fn, code) {
  assert.throws(fn, (err) => err instanceof EvmError && err.code === code);
}

test("a signed transfer moves the value, burns the fee and advances the sender nonce", () => {
  const accounts = EvmAccounts.fromAllocations({ [KEY1_ADDRESS]: (10n * BASE_PER_SNN).toString() });
  const entry = toEntry(signTransfer({ privateKey: KEY1, nonce: 0, gasLimit: INTRINSIC_GAS, to: RECIPIENT, value: BASE_PER_SNN }));
  const result = applyTransferEntry(accounts, entry, EVM_CHAIN_IDS.testnet);
  assert.equal(result.sender, KEY1_ADDRESS);
  assert.equal(result.fee, FEE);
  assert.equal(accounts.get(RECIPIENT).balance, BASE_PER_SNN);
  assert.equal(accounts.get(KEY1_ADDRESS).balance, 9n * BASE_PER_SNN - FEE);
  assert.equal(accounts.get(KEY1_ADDRESS).nonce, 1);
});

test("replaying the same entry is refused by the nonce check", () => {
  const accounts = EvmAccounts.fromAllocations({ [KEY1_ADDRESS]: (10n * BASE_PER_SNN).toString() });
  const entry = toEntry(signTransfer({ privateKey: KEY1, nonce: 0, gasLimit: INTRINSIC_GAS, to: RECIPIENT, value: BASE_PER_SNN }));
  applyTransferEntry(accounts, entry, EVM_CHAIN_IDS.testnet);
  expectEvmError(() => applyTransferEntry(accounts, entry, EVM_CHAIN_IDS.testnet), "BAD_NONCE");
});

test("a sender without value plus fee is refused and nothing moves", () => {
  const accounts = EvmAccounts.fromAllocations({ [KEY1_ADDRESS]: BASE_PER_SNN.toString() });
  const before = accounts.root();
  const entry = toEntry(signTransfer({ privateKey: KEY1, nonce: 0, gasLimit: INTRINSIC_GAS, to: RECIPIENT, value: BASE_PER_SNN }));
  expectEvmError(() => applyTransferEntry(accounts, entry, EVM_CHAIN_IDS.testnet), "INSUFFICIENT_BALANCE");
  assert.equal(accounts.root(), before);
});

test("a gas limit below the intrinsic gas is refused", () => {
  const accounts = EvmAccounts.fromAllocations({ [KEY1_ADDRESS]: (10n * BASE_PER_SNN).toString() });
  const entry = toEntry(signTransfer({ privateKey: KEY1, nonce: 0, gasLimit: INTRINSIC_GAS - 1n, to: RECIPIENT, value: BASE_PER_SNN }));
  expectEvmError(() => applyTransferEntry(accounts, entry, EVM_CHAIN_IDS.testnet), "GAS_TOO_LOW");
});

test("an entry signed for another chain does not verify on this chain", () => {
  const accounts = EvmAccounts.fromAllocations({ [KEY1_ADDRESS]: (10n * BASE_PER_SNN).toString() });
  const entry = toEntry(
    signTransfer({ privateKey: KEY1, nonce: 0, gasLimit: INTRINSIC_GAS, to: RECIPIENT, value: BASE_PER_SNN, chainId: EVM_CHAIN_IDS.mainnet }),
  );
  assert.throws(() => applyTransferEntry(accounts, entry, EVM_CHAIN_IDS.testnet), EvmError);
  assert.equal(accounts.get(RECIPIENT).balance, 0n);
});

test("a tampered amount breaks the signature check", () => {
  const accounts = EvmAccounts.fromAllocations({ [KEY1_ADDRESS]: (10n * BASE_PER_SNN).toString() });
  const entry = toEntry(signTransfer({ privateKey: KEY1, nonce: 0, gasLimit: INTRINSIC_GAS, to: RECIPIENT, value: BASE_PER_SNN }));
  const tampered = { ...entry, value: (2n * BASE_PER_SNN).toString() };
  assert.throws(() => applyTransferEntry(accounts, tampered, EVM_CHAIN_IDS.testnet), EvmError);
  assert.equal(accounts.get(RECIPIENT).balance, 0n);
});

test("the state root changes with a transfer and is identical for identical runs", () => {
  const run = () => {
    const accounts = EvmAccounts.fromAllocations({ [KEY1_ADDRESS]: (10n * BASE_PER_SNN).toString() });
    const before = accounts.root();
    applyTransferEntry(
      accounts,
      toEntry(signTransfer({ privateKey: KEY1, nonce: 0, gasLimit: INTRINSIC_GAS, to: RECIPIENT, value: BASE_PER_SNN })),
      EVM_CHAIN_IDS.testnet,
    );
    return { before, after: accounts.root() };
  };
  const first = run();
  const second = run();
  assert.notEqual(first.before, first.after);
  assert.deepEqual(first, second);
});

test("allocations are validated strictly", () => {
  expectEvmError(() => EvmAccounts.fromAllocations({ [KEY1_ADDRESS]: "1.5" }), "BAD_AMOUNT");
  expectEvmError(() => EvmAccounts.fromAllocations({ "0xABC": "1" }), "BAD_ADDRESS");
});
