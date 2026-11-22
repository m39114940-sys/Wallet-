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
import { makeAccount, signedTransfer } from "./helpers.js";

const BOB = "snn1" + "b".repeat(40);

const expectCode = async (promise, code) => {
  await assert.rejects(promise, (err) => err instanceof LedgerError && err.code === code);
};

test("parseAmount converts decimals to exact micro-SNN units", () => {
  assert.equal(parseAmount("1"), 1_000_000n);
  assert.equal(parseAmount("0.5"), 500_000n);
  assert.equal(parseAmount("0.000001"), 1n);
  assert.equal(parseAmount(" 12.25 "), 12_250_000n);
});

test("parseAmount rejects zero, negatives, exponents and extra decimals", () => {
  for (const bad of ["0", "0.0", "-1", "1e3", "1.0000001", "abc", "", "1,5"]) {
    assert.throws(() => parseAmount(bad), (err) => err.code === "INVALID_AMOUNT", bad);
  }
});

test("formatAmount trims trailing zeros", () => {
  assert.equal(formatAmount(1_000_000n), "1");
  assert.equal(formatAmount(1_500_000n), "1.5");
  assert.equal(formatAmount(1n), "0.000001");
  assert.equal(formatAmount(0n), "0");
});

test("isValidAddress accepts only snn1 followed by 40 lowercase hex characters", () => {
  assert.equal(isValidAddress("snn1" + "a".repeat(40)), true);
  assert.equal(isValidAddress("snn1" + "A".repeat(40)), false);
  assert.equal(isValidAddress("snn1" + "a".repeat(39)), false);
  assert.equal(isValidAddress("btc1" + "a".repeat(40)), false);
  assert.equal(isValidAddress(undefined), false);
});

test("faucet credit is allowed once per address and only for the fixed testnet amount", async () => {
  const alice = await makeAccount();
  const ledger = new Ledger();
  ledger.credit(alice.address, TESTNET_FAUCET_UNITS);
  assert.equal(ledger.balanceOf(alice.address), TESTNET_FAUCET_UNITS);
  assert.throws(() => ledger.credit(alice.address, TESTNET_FAUCET_UNITS), (e) => e.code === "FAUCET_USED");
  assert.throws(() => new Ledger().credit(alice.address, 1n), (e) => e.code === "INVALID_AMOUNT");
});

test("a valid signed transfer moves funds and advances the sender nonce", async () => {
  const alice = await makeAccount();
  const ledger = new Ledger();
  ledger.credit(alice.address, TESTNET_FAUCET_UNITS);

  const tx = await ledger.transfer(await signedTransfer(alice, BOB, "2.5", 0));
  assert.equal(ledger.balanceOf(alice.address), parseAmount("97.5"));
  assert.equal(ledger.balanceOf(BOB), parseAmount("2.5"));
  assert.equal(ledger.nextNonce(alice.address), 1);
  assert.equal(tx.nonce, 0);
  assert.equal(tx.height, 2);
});

test("insufficient funds fails and leaves state unchanged", async () => {
  const alice = await makeAccount();
  const ledger = new Ledger();
  ledger.credit(alice.address, TESTNET_FAUCET_UNITS);
  await expectCode(ledger.transfer(await signedTransfer(alice, BOB, "101", 0)), "INSUFFICIENT_FUNDS");
  assert.equal(ledger.balanceOf(alice.address), TESTNET_FAUCET_UNITS);
  assert.equal(ledger.nextNonce(alice.address), 0);
});

test("self-transfers and invalid recipients are rejected before any signature check", async () => {
  const alice = await makeAccount();
  const ledger = new Ledger();
  ledger.credit(alice.address, TESTNET_FAUCET_UNITS);
  await expectCode(ledger.transfer(await signedTransfer(alice, alice.address, "1", 0)), "SELF_TRANSFER");
  await expectCode(
    ledger.transfer({ ...(await signedTransfer(alice, BOB, "1", 0)), to: "nope" }),
    "INVALID_RECIPIENT",
  );
});

test("transactionsFor returns newest first and includes incoming and outgoing transfers", async () => {
  const alice = await makeAccount();
  const ledger = new Ledger();
  ledger.credit(alice.address, TESTNET_FAUCET_UNITS);
  await ledger.transfer(await signedTransfer(alice, BOB, "1", 0));
  assert.equal(ledger.transactionsFor(BOB).length, 1);
  assert.equal(ledger.transactionsFor(BOB)[0].type, "transfer");
  assert.equal(ledger.transactionsFor(alice.address)[0].height, 2);
});

test("a stored ledger reloads exactly when its records are intact", async () => {
  const alice = await makeAccount();
  const ledger = new Ledger();
  ledger.credit(alice.address, TESTNET_FAUCET_UNITS);
  await ledger.transfer(await signedTransfer(alice, BOB, "0.000001", 0));

  const restored = await Ledger.fromSnapshot(JSON.parse(JSON.stringify(ledger)));
  assert.equal(restored.balanceOf(alice.address), ledger.balanceOf(alice.address));
  assert.equal(restored.balanceOf(BOB), 1n);
  assert.equal(restored.nextNonce(alice.address), 1);
  assert.equal(restored.height, 2);
});

test("a snapshot keeps treasury withdrawal ids and refuses a replayed id on reload", async () => {
  const { Ledger: L } = await import("../js/ledger.js");
  const mint = "snn1" + "b".repeat(40);
  const dest = "snn1" + "c".repeat(40);
  const ledger = new L();
  ledger.genesisMint(mint, 1_000n);
  ledger.protocolMove({ from: mint, to: dest, amount: 50n, withdrawalId: 3 });
  const copy = await L.fromSnapshot(JSON.parse(JSON.stringify(ledger.toJSON())));
  assert.equal(copy.hasWithdrawal(3), true);
  const forged = JSON.parse(JSON.stringify(ledger.toJSON()));
  forged.transactions.push({ ...forged.transactions[1], height: 3 });
  await assert.rejects(L.fromSnapshot(forged));
});

test("the ledger mirrors every record to its log and rebuilds from it", async () => {
  const { RecordLog } = await import("../js/record-log.js");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "snn-ledger-log-"));
  try {
    const mint = "snn1" + "d".repeat(40);
    const dest = "snn1" + "e".repeat(40);
    const log = new RecordLog(dir, { segmentRecords: 2 });
    const ledger = new Ledger();
    ledger.attachLog(log);
    ledger.genesisMint(mint, 1_000n);
    ledger.protocolMove({ from: mint, to: dest, amount: 25n });
    ledger.protocolMove({ from: dest, to: null, amount: 5n });
    assert.equal(log.length, 3);
    const rebuilt = await Ledger.fromLog(new RecordLog(dir, { segmentRecords: 2 }));
    assert.equal(rebuilt.balanceOf(mint), 975n);
    assert.equal(rebuilt.balanceOf(dest), 20n);
    assert.equal(rebuilt.height, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a log that does not match the ledger height is refused", async () => {
  const { RecordLog } = await import("../js/record-log.js");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "snn-ledger-mismatch-"));
  try {
    const log = new RecordLog(dir);
    log.append({ type: "genesis" });
    const ledger = new Ledger(); // height 0, the log holds one record
    assert.throws(() => ledger.attachLog(log), { code: "LOG_MISMATCH" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
