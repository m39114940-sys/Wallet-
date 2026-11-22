import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger } from "../js/ledger.js";
import { ledgerRoot, compositeStateRoot } from "../chain/stateroot.js";

const A = "snn1" + "a".repeat(40);
const B = "snn1" + "b".repeat(40);
const EVM_ROOT = "0x" + "c".repeat(64);
const OTHER_EVM_ROOT = "0x" + "d".repeat(64);

test("ledger root is the same regardless of insertion order", () => {
  const first = new Ledger();
  first.credit(A, 5_000_000n);
  first.credit(B, 3_000_000n);
  const second = new Ledger();
  second.credit(B, 3_000_000n);
  second.credit(A, 5_000_000n);
  assert.equal(ledgerRoot(first), ledgerRoot(second));
});

test("ledger root changes when a balance changes", () => {
  const first = new Ledger();
  first.credit(A, 5_000_000n);
  const second = new Ledger();
  second.credit(A, 5_000_001n);
  assert.notEqual(ledgerRoot(first), ledgerRoot(second));
});

test("composite root is deterministic and changes with the EVM root", () => {
  const ledger = new Ledger();
  ledger.credit(A, 1_000_000n);
  assert.equal(compositeStateRoot(ledger, EVM_ROOT), compositeStateRoot(ledger, EVM_ROOT));
  assert.notEqual(compositeStateRoot(ledger, EVM_ROOT), compositeStateRoot(ledger, OTHER_EVM_ROOT));
});

test("composite root differs from the ledger root alone", () => {
  const ledger = new Ledger();
  ledger.credit(A, 1_000_000n);
  assert.notEqual(compositeStateRoot(ledger, EVM_ROOT), ledgerRoot(ledger));
});

test("composite root refuses a malformed EVM root", () => {
  const ledger = new Ledger();
  for (const bad of ["0xabc", "c".repeat(64), "0x" + "C".repeat(64), undefined]) {
    assert.throws(() => compositeStateRoot(ledger, bad), (err) => err.code === "BAD_EVM_ROOT");
  }
});
