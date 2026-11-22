import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger, TESTNET_FAUCET_UNITS } from "../js/ledger.js";
import { ledgerRoot, compositeStateRoot } from "../chain/stateroot.js";

// The ledger's faucet credits only TESTNET_FAUCET_UNITS, once per address. Tests use that amount and distinct addresses.
const A = "snn1" + "a".repeat(40);
const B = "snn1" + "b".repeat(40);
const EVM_ROOT = "0x" + "c".repeat(64);
const OTHER_EVM_ROOT = "0x" + "d".repeat(64);

test("ledger root is the same regardless of insertion order", () => {
  const first = new Ledger();
  first.credit(A, TESTNET_FAUCET_UNITS);
  first.credit(B, TESTNET_FAUCET_UNITS);
  const second = new Ledger();
  second.credit(B, TESTNET_FAUCET_UNITS);
  second.credit(A, TESTNET_FAUCET_UNITS);
  assert.equal(ledgerRoot(first), ledgerRoot(second));
});

test("ledger root changes when the set of funded accounts changes", () => {
  const first = new Ledger();
  first.credit(A, TESTNET_FAUCET_UNITS);
  const second = new Ledger();
  second.credit(A, TESTNET_FAUCET_UNITS);
  second.credit(B, TESTNET_FAUCET_UNITS);
  assert.notEqual(ledgerRoot(first), ledgerRoot(second));
});

test("composite root is deterministic and changes with the EVM root", () => {
  const ledger = new Ledger();
  ledger.credit(A, TESTNET_FAUCET_UNITS);
  assert.equal(compositeStateRoot(ledger, EVM_ROOT), compositeStateRoot(ledger, EVM_ROOT));
  assert.notEqual(compositeStateRoot(ledger, EVM_ROOT), compositeStateRoot(ledger, OTHER_EVM_ROOT));
});

test("composite root differs from the ledger root alone", () => {
  const ledger = new Ledger();
  ledger.credit(A, TESTNET_FAUCET_UNITS);
  assert.notEqual(compositeStateRoot(ledger, EVM_ROOT), ledgerRoot(ledger));
});

test("composite root refuses a malformed EVM root", () => {
  const ledger = new Ledger();
  for (const bad of ["0xabc", "c".repeat(64), "0x" + "C".repeat(64), undefined]) {
    assert.throws(() => compositeStateRoot(ledger, bad), (err) => err.code === "BAD_EVM_ROOT");
  }
});
