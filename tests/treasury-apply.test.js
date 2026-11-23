import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger } from "../js/ledger.js";
import { applyWithdrawal, TreasuryError } from "../econ/treasury.js";

const TREASURY = "snn1" + "b".repeat(40);
const TO = "snn1" + "c".repeat(40);

function funded(units) {
  const ledger = new Ledger();
  ledger.genesisMint(TREASURY, units);
  return ledger;
}

test("an approved withdrawal moves funds from the treasury to the recipient", () => {
  const ledger = funded(1_000n);
  applyWithdrawal(ledger, { treasuryAddress: TREASURY, instruction: { to: TO, units: 400n } });
  assert.equal(ledger.balanceOf(TREASURY), 600n);
  assert.equal(ledger.balanceOf(TO), 400n);
});

test("locked treasury balance cannot be withdrawn", () => {
  const ledger = funded(1_000n);
  assert.throws(
    () => applyWithdrawal(ledger, { treasuryAddress: TREASURY, lockedUnits: 700n, instruction: { to: TO, units: 400n } }),
    { code: "INSUFFICIENT_SPENDABLE" },
  );
  assert.equal(ledger.balanceOf(TREASURY), 1_000n, "a refused withdrawal changes nothing");
  applyWithdrawal(ledger, { treasuryAddress: TREASURY, lockedUnits: 700n, instruction: { to: TO, units: 300n } });
  assert.equal(ledger.balanceOf(TREASURY), 700n);
});

test("malformed instructions are refused", () => {
  const ledger = funded(1_000n);
  assert.throws(() => applyWithdrawal(ledger, { treasuryAddress: TREASURY, instruction: { to: TO, units: 0n } }), TreasuryError);
  assert.throws(() => applyWithdrawal(ledger, { treasuryAddress: TREASURY, instruction: null }), TreasuryError);
});

test("a withdrawal id is executed once; a replay is refused and the balance is unchanged", () => {
  const ledger = funded(1_000n);
  applyWithdrawal(ledger, { treasuryAddress: TREASURY, instruction: { to: TO, units: 100n }, withdrawalId: 7 });
  assert.equal(ledger.hasWithdrawal(7), true);
  assert.throws(
    () => applyWithdrawal(ledger, { treasuryAddress: TREASURY, instruction: { to: TO, units: 100n }, withdrawalId: 7 }),
    { code: "WITHDRAWAL_REPLAY" },
  );
  assert.equal(ledger.balanceOf(TREASURY), 900n);
  assert.equal(ledger.balanceOf(TO), 100n);
});

test("withdrawal ids must be positive safe integers", () => {
  const ledger = funded(1_000n);
  assert.throws(
    () => applyWithdrawal(ledger, { treasuryAddress: TREASURY, instruction: { to: TO, units: 1n }, withdrawalId: 0 }),
    { code: "INVALID_WITHDRAWAL" },
  );
});
