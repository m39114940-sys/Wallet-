import { test } from "node:test";
import assert from "node:assert/strict";
import {
  Ledger,
  LedgerError,
  formatAmount,
  parseAmount,
  isValidAddress,
  TESTNET_FAUCET_UNITS,
} from "../js/ledger.js";

const ALICE = "snn1" + "a".repeat(40);
const BOB = "snn1" + "b".repeat(40);

const expectError = (fn, code) => {
  assert.throws(fn, (err) => err instanceof LedgerError && err.code === code);
};

test("parseAmount converts decimals to exact micro-SNN units", () => {
  assert.equal(parseAmount("1"), 1_000_000n);
  assert.equal(parseAmount("0.5"), 500_000n);
  assert.equal(parseAmount("0.000001"), 1n);
  assert.equal(parseAmount(" 12.25 "), 12_250_000n);
});

test("parseAmount rejects zero, negatives, exponents and extra decimals", () => {
  for (const bad of ["0", "0.0", "-1", "1e3", "1.0000001", "abc", "", "1,5"]) {
    expectError(() => parseAmount(bad), "INVALID_AMOUNT");
  }
});

test("formatAmount trims trailing zeros", () => {
  assert.equal(formatAmount(1_000_000n), "1");
  assert.equal(formatAmount(1_500_000n), "1.5");
  assert.equal(formatAmount(1n), "0.000001");
  assert.equal(formatAmount(0n), "0");
});

test("isValidAddress accepts only snn1 followed by 40 lowercase hex characters", () => {
  assert.equal(isValidAddress(ALICE), true);
  assert.equal(isValidAddress("snn1" + "A".repeat(40)), false);
  assert.equal(isValidAddress("snn1" + "a".repeat(39)), false);
  assert.equal(isValidAddress("btc1" + "a".repeat(40)), false);
  assert.equal(isValidAddress(undefined), false);
});

test("faucet credit increases balance and is recorded in history", () => {
  const ledger = new Ledger();
  ledger.credit(ALICE, TESTNET_FAUCET_UNITS);
  assert.equal(ledger.balanceOf(ALICE), TESTNET_FAUCET_UNITS);
  assert.equal(ledger.height, 1);
  assert.equal(ledger.transactionsFor(ALICE)[0].type, "faucet");
});

test("transfer moves funds and increments the sender nonce", () => {
  const ledger = new Ledger();
  ledger.credit(ALICE, parseAmount("10"));
  const tx = ledger.transfer({ from: ALICE, to: BOB, amount: "2.5", nonce: 0 });

  assert.equal(ledger.balanceOf(ALICE), parseAmount("7.5"));
  assert.equal(ledger.balanceOf(BOB), parseAmount("2.5"));
  assert.equal(ledger.nextNonce(ALICE), 1);
  assert.equal(tx.nonce, 0);
  assert.equal(tx.height, 2);
});

test("a replayed transfer with the same nonce is rejected (replay and double-spend protection)", () => {
  const ledger = new Ledger();
  ledger.credit(ALICE, parseAmount("10"));
  ledger.transfer({ from: ALICE, to: BOB, amount: "1", nonce: 0 });

  expectError(() => ledger.transfer({ from: ALICE, to: BOB, amount: "1", nonce: 0 }), "NONCE_MISMATCH");
  assert.equal(ledger.balanceOf(BOB), parseAmount("1"));
});

test("a nonce from the future is rejected", () => {
  const ledger = new Ledger();
  ledger.credit(ALICE, parseAmount("10"));
  expectError(() => ledger.transfer({ from: ALICE, to: BOB, amount: "1", nonce: 5 }), "NONCE_MISMATCH");
});

test("transfer fails when the balance is insufficient and leaves state unchanged", () => {
  const ledger = new Ledger();
  ledger.credit(ALICE, parseAmount("1"));
  expectError(() => ledger.transfer({ from: ALICE, to: BOB, amount: "2", nonce: 0 }), "INSUFFICIENT_FUNDS");
  assert.equal(ledger.balanceOf(ALICE), parseAmount("1"));
  assert.equal(ledger.nextNonce(ALICE), 0);
});

test("transfer rejects self-transfers and invalid addresses", () => {
  const ledger = new Ledger();
  ledger.credit(ALICE, parseAmount("1"));
  expectError(() => ledger.transfer({ from: ALICE, to: ALICE, amount: "1", nonce: 0 }), "SELF_TRANSFER");
  expectError(() => ledger.transfer({ from: ALICE, to: "nope", amount: "1", nonce: 0 }), "INVALID_RECIPIENT");
  expectError(() => ledger.transfer({ from: "nope", to: BOB, amount: "1", nonce: 0 }), "INVALID_SENDER");
});

test("transactionsFor returns newest first and includes both incoming and outgoing transfers", () => {
  const ledger = new Ledger();
  ledger.credit(ALICE, parseAmount("5"));
  ledger.transfer({ from: ALICE, to: BOB, amount: "1", nonce: 0 });
  const bobHistory = ledger.transactionsFor(BOB);
  assert.equal(bobHistory.length, 1);
  assert.equal(bobHistory[0].type, "transfer");
  assert.equal(ledger.transactionsFor(ALICE)[0].height, 2);
});

test("state survives a JSON round trip without losing BigInt precision", () => {
  const ledger = new Ledger();
  ledger.credit(ALICE, TESTNET_FAUCET_UNITS);
  ledger.transfer({ from: ALICE, to: BOB, amount: "0.000001", nonce: 0 });

  const restored = new Ledger(JSON.parse(JSON.stringify(ledger)));
  assert.equal(restored.balanceOf(ALICE), ledger.balanceOf(ALICE));
  assert.equal(restored.balanceOf(BOB), 1n);
  assert.equal(restored.nextNonce(ALICE), 1);
  assert.equal(restored.height, 2);
});
