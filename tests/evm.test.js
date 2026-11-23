import { test } from "node:test";
import assert from "node:assert/strict";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { EvmError } from "../evm/errors.js";
import { BASE_PER_SNN, MIN_TRANSFER_BASE, EVM_CHAIN_IDS, TESTNET_GAS_POLICY } from "../evm/params.js";
import { snnToBase, baseToSnn, assertTransferable } from "../evm/units.js";
import { evmAddressFromPublicKey, isEvmAddress, evmLedgerKey } from "../evm/accounts.js";
import { checkGasLimit, checkBlockGas, feeFor, maxFeeFor } from "../evm/gas.js";

const G_X = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
const G_Y = "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8";
const KEY1_ADDRESS = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";

function expectEvmError(fn, code) {
  assert.throws(fn, (err) => err instanceof EvmError && err.code === code);
}

test("keccak-256 of the empty string matches the standard vector", () => {
  const hex = Buffer.from(keccak_256(new Uint8Array(0))).toString("hex");
  assert.equal(hex, "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");
});

test("chain IDs are the approved values and are distinct", () => {
  assert.equal(EVM_CHAIN_IDS.mainnet, 20261121n);
  assert.equal(EVM_CHAIN_IDS.testnet, 20261122n);
  assert.notEqual(EVM_CHAIN_IDS.mainnet, EVM_CHAIN_IDS.testnet);
});

test("SNN uses 18 decimals and the minimum transfer is 0.000001 SNN", () => {
  assert.equal(BASE_PER_SNN, 10n ** 18n);
  assert.equal(MIN_TRANSFER_BASE, 10n ** 12n);
  assert.equal(snnToBase("0.000001"), MIN_TRANSFER_BASE);
});

test("snnToBase parses exact decimal strings without floating point error", () => {
  assert.equal(snnToBase("1"), BASE_PER_SNN);
  assert.equal(snnToBase("1.5"), 15n * 10n ** 17n);
  assert.equal(snnToBase("0.000000000000000001"), 1n);
  assert.equal(snnToBase("123456789.123456789012345678"), 123456789123456789012345678n);
});

test("snnToBase refuses more than 18 decimals instead of rounding", () => {
  expectEvmError(() => snnToBase("0.0000000000000000001"), "TOO_PRECISE");
});

test("snnToBase refuses malformed input", () => {
  for (const bad of ["", "-1", "1e3", "1,5", " 1", "1.", ".5", 1, null]) {
    expectEvmError(() => snnToBase(bad), "BAD_AMOUNT");
  }
});

test("baseToSnn round-trips with snnToBase", () => {
  for (const s of ["0", "1", "0.000001", "2.5", "123.000000000000000001"]) {
    assert.equal(baseToSnn(snnToBase(s)), s);
  }
});

test("assertTransferable rejects amounts below the minimum", () => {
  expectEvmError(() => assertTransferable(MIN_TRANSFER_BASE - 1n), "BELOW_MINIMUM");
  assert.equal(assertTransferable(MIN_TRANSFER_BASE), MIN_TRANSFER_BASE);
});

test("EVM address of private key 1 matches the public reference address", () => {
  assert.equal(evmAddressFromPublicKey(`04${G_X}${G_Y}`), KEY1_ADDRESS);
});

test("address derivation accepts the 64-byte form without the 0x04 prefix", () => {
  assert.equal(evmAddressFromPublicKey(`${G_X}${G_Y}`), KEY1_ADDRESS);
});

test("address derivation rejects keys of the wrong length or format", () => {
  expectEvmError(() => evmAddressFromPublicKey("02" + G_X), "BAD_PUBLIC_KEY");
  expectEvmError(() => evmAddressFromPublicKey(G_X), "BAD_PUBLIC_KEY");
  expectEvmError(() => evmAddressFromPublicKey(G_X.toUpperCase() + G_Y.toUpperCase()), "BAD_PUBLIC_KEY");
});

test("isEvmAddress accepts only 0x plus 40 lowercase hex characters", () => {
  assert.equal(isEvmAddress(KEY1_ADDRESS), true);
  assert.equal(isEvmAddress(KEY1_ADDRESS.toUpperCase().replace("0X", "0x")), false);
  assert.equal(isEvmAddress("0x1234"), false);
  assert.equal(isEvmAddress("snn1" + "a".repeat(40)), false);
});

test("EVM ledger keys live in their own namespace", () => {
  assert.equal(evmLedgerKey(KEY1_ADDRESS), `evm:${KEY1_ADDRESS}`);
  expectEvmError(() => evmLedgerKey("snn1" + "a".repeat(40)), "BAD_ADDRESS");
});

test("gas limit above the per-transaction cap is refused", () => {
  assert.equal(checkGasLimit(TESTNET_GAS_POLICY.maxGasLimitPerTx), TESTNET_GAS_POLICY.maxGasLimitPerTx);
  expectEvmError(() => checkGasLimit(TESTNET_GAS_POLICY.maxGasLimitPerTx + 1n), "GAS_LIMIT_TOO_HIGH");
});

test("Testnet gas caps match the approved strict values and are ordered correctly", () => {
  assert.equal(TESTNET_GAS_POLICY.maxGasLimitPerTx, 3_000_000n);
  assert.equal(TESTNET_GAS_POLICY.blockGasLimit, 30_000_000n);
  assert.ok(TESTNET_GAS_POLICY.blockGasLimit >= TESTNET_GAS_POLICY.maxGasLimitPerTx);
});

test("declared gas in one block cannot exceed the block cap", () => {
  assert.equal(checkBlockGas(TESTNET_GAS_POLICY.blockGasLimit), TESTNET_GAS_POLICY.blockGasLimit);
  expectEvmError(() => checkBlockGas(TESTNET_GAS_POLICY.blockGasLimit + 1n), "BLOCK_GAS_TOO_HIGH");
});

test("gas limit must be a positive BigInt", () => {
  expectEvmError(() => checkGasLimit(0n), "BAD_GAS_LIMIT");
  expectEvmError(() => checkGasLimit(21000), "BAD_GAS_LIMIT");
});

test("fee is gasUsed times the Testnet gas price, and gasUsed cannot exceed the limit", () => {
  const price = TESTNET_GAS_POLICY.gasPriceBase;
  assert.equal(feeFor(21000n, 21000n), 21000n * price);
  assert.equal(feeFor(0n, 21000n), 0n);
  expectEvmError(() => feeFor(21001n, 21000n), "BAD_GAS_USED");
});

test("maximum fee is the gas limit times the gas price", () => {
  assert.equal(maxFeeFor(50000n), 50000n * TESTNET_GAS_POLICY.gasPriceBase);
});
