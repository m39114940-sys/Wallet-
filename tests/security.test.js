// Attack scenarios: forged or altered transfers, replayed and double-spent transactions,
// tampered ledger records, and malformed or hostile keystore files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Ledger, LedgerError, TESTNET_FAUCET_UNITS, MAX_TRANSACTIONS, parseAmount } from "../js/ledger.js";
import { createKeystore, parseKeystoreFile, unlockKeystore, MAX_KEYSTORE_BYTES, MAX_ITERATIONS } from "../js/keystore.js";
import { signTransfer, toHex, createAccount, importSigningKey } from "../js/signing.js";
import { makeAccount, signedTransfer } from "./helpers.js";

const BOB = "snn1" + "b".repeat(40);
const CAROL = "snn1" + "c".repeat(40);
const ITER = 100_000;

// The faucet grants only the fixed testnet amount (100 SNN), so every test account starts with that.
async function funded(account) {
  const ledger = new Ledger();
  ledger.credit(account.address, TESTNET_FAUCET_UNITS);
  return ledger;
}

const expectCode = (promise, code) =>
  assert.rejects(promise, (err) => err instanceof LedgerError && err.code === code, `expected ${code}`);

const expectCorrupt = (promise) =>
  assert.rejects(promise, (err) => err instanceof LedgerError && err.code === "LEDGER_CORRUPT");

// ---------- Signature attacks ----------

test("altering the amount after signing is rejected", async () => {
  const alice = await makeAccount();
  const ledger = await funded(alice);
  const tx = await signedTransfer(alice, BOB, "1", 0);
  await expectCode(ledger.transfer({ ...tx, amount: "9" }), "BAD_SIGNATURE");
  assert.equal(ledger.balanceOf(BOB), 0n);
});

test("redirecting a signed transfer to another recipient is rejected", async () => {
  const alice = await makeAccount();
  const ledger = await funded(alice);
  const tx = await signedTransfer(alice, BOB, "1", 0);
  await expectCode(ledger.transfer({ ...tx, to: CAROL }), "BAD_SIGNATURE");
  assert.equal(ledger.balanceOf(CAROL), 0n);
});

test("changing the nonce on a signed transfer is rejected", async () => {
  const alice = await makeAccount();
  const ledger = await funded(alice);
  const tx = await signedTransfer(alice, BOB, "1", 0);
  await expectCode(ledger.transfer({ ...tx, nonce: 1 }), "BAD_SIGNATURE");
});

test("impersonation: an attacker cannot spend from a victim's address with their own signature", async () => {
  const victim = await makeAccount();
  const attacker = await makeAccount();
  const ledger = await funded(victim);
  // Attacker signs with their own key, but claims the victim's address and public key.
  const signature = await signTransfer(attacker.signingKey, { from: victim.address, to: BOB, units: "1000000", nonce: 0 });
  await expectCode(
    ledger.transfer({ from: victim.address, to: BOB, amount: "1", nonce: 0, publicKey: toHex(victim.publicKey), signature }),
    "BAD_SIGNATURE",
  );
  assert.equal(ledger.balanceOf(victim.address), TESTNET_FAUCET_UNITS);
});

test("a public key that does not hash to the sender's address is rejected as unauthorized", async () => {
  const victim = await makeAccount();
  const attacker = await makeAccount();
  const ledger = await funded(victim);
  const tx = await signedTransfer(attacker, BOB, "1", 0);
  // Attacker submits their own valid transaction but claims the victim as sender.
  await expectCode(ledger.transfer({ ...tx, from: victim.address }), "UNAUTHORIZED");
});

test("signatures reused from another transaction are rejected", async () => {
  const alice = await makeAccount();
  const ledger = await funded(alice);
  const first = await signedTransfer(alice, BOB, "1", 0);
  const second = await signedTransfer(alice, BOB, "2", 1);
  await expectCode(ledger.transfer({ ...second, signature: first.signature }), "BAD_SIGNATURE");
});

test("missing, truncated or non-hex signatures are rejected", async () => {
  const alice = await makeAccount();
  const ledger = await funded(alice);
  const tx = await signedTransfer(alice, BOB, "1", 0);
  for (const bad of ["", "ab", "z".repeat(128), tx.signature.slice(0, 126)]) {
    await expectCode(ledger.transfer({ ...tx, signature: bad }), "BAD_SIGNATURE");
  }
  await expectCode(ledger.transfer({ ...tx, publicKey: "00" }), "BAD_SIGNATURE");
  await expectCode(ledger.transfer({ ...tx, signature: undefined }), "BAD_SIGNATURE");
});

test("an unsigned transfer with no key is rejected before any state changes", async () => {
  const alice = await makeAccount();
  const ledger = await funded(alice);
  await expectCode(ledger.transfer({ from: alice.address, to: BOB, amount: "1", nonce: 0 }), "BAD_SIGNATURE");
  assert.equal(ledger.nextNonce(alice.address), 0);
});

// ---------- Replay and double-spend ----------

test("replaying an identical signed transfer is rejected and moves no funds twice", async () => {
  const alice = await makeAccount();
  const ledger = await funded(alice);
  const tx = await signedTransfer(alice, BOB, "1", 0);
  await ledger.transfer(tx);
  await expectCode(ledger.transfer(tx), "NONCE_MISMATCH");
  assert.equal(ledger.balanceOf(BOB), parseAmount("1"));
  assert.equal(ledger.balanceOf(alice.address), parseAmount("99"));
});

test("replaying an old transfer after later transfers is still rejected", async () => {
  const alice = await makeAccount();
  const ledger = await funded(alice);
  const old = await signedTransfer(alice, BOB, "1", 0);
  await ledger.transfer(old);
  await ledger.transfer(await signedTransfer(alice, CAROL, "1", 1));
  await ledger.transfer(await signedTransfer(alice, CAROL, "1", 2));
  await expectCode(ledger.transfer(old), "NONCE_MISMATCH");
  assert.equal(ledger.balanceOf(BOB), parseAmount("1"));
});

test("double spend: two different signed transfers with the same nonce cannot both apply", async () => {
  const alice = await makeAccount();
  const ledger = await funded(alice);
  const payBob = await signedTransfer(alice, BOB, "9", 0);
  const payCarol = await signedTransfer(alice, CAROL, "9", 0);
  await ledger.transfer(payBob);
  await expectCode(ledger.transfer(payCarol), "NONCE_MISMATCH");
  assert.equal(ledger.balanceOf(CAROL), 0n);
});

test("a transfer with a future nonce is rejected", async () => {
  const alice = await makeAccount();
  const ledger = await funded(alice);
  await expectCode(ledger.transfer(await signedTransfer(alice, BOB, "1", 7)), "NONCE_MISMATCH");
});

test("a negative or non-integer nonce is rejected", async () => {
  const alice = await makeAccount();
  const ledger = await funded(alice);
  const tx = await signedTransfer(alice, BOB, "1", 0);
  await expectCode(ledger.transfer({ ...tx, nonce: -1 }), "INVALID_NONCE");
  await expectCode(ledger.transfer({ ...tx, nonce: 0.5 }), "INVALID_NONCE");
});

test("spending more than the balance is rejected even with a valid signature", async () => {
  const alice = await makeAccount();
  const ledger = await funded(alice);
  await expectCode(ledger.transfer(await signedTransfer(alice, BOB, "100.000001", 0)), "INSUFFICIENT_FUNDS");
});

// ---------- Tampered ledger records ----------

async function honestSnapshot() {
  const alice = await makeAccount();
  const ledger = new Ledger();
  ledger.credit(alice.address, TESTNET_FAUCET_UNITS);
  await ledger.transfer(await signedTransfer(alice, BOB, "2", 0));
  return { alice, snapshot: JSON.parse(JSON.stringify(ledger)) };
}

test("an honest stored ledger loads", async () => {
  const { snapshot } = await honestSnapshot();
  await Ledger.fromSnapshot(snapshot);
});

test("inflating a stored balance is detected", async () => {
  const { alice, snapshot } = await honestSnapshot();
  snapshot.balances[alice.address] = (BigInt(snapshot.balances[alice.address]) + 1n).toString();
  await expectCorrupt(Ledger.fromSnapshot(snapshot));
});

test("editing a stored transfer amount is detected through the signature", async () => {
  const { snapshot } = await honestSnapshot();
  snapshot.transactions[1].amount = "5000000";
  await expectCorrupt(Ledger.fromSnapshot(snapshot));
});

test("editing a stored recipient is detected", async () => {
  const { snapshot } = await honestSnapshot();
  snapshot.transactions[1].to = CAROL;
  await expectCorrupt(Ledger.fromSnapshot(snapshot));
});

test("a negative balance is rejected", async () => {
  const { alice, snapshot } = await honestSnapshot();
  snapshot.balances[alice.address] = "-5000000";
  await expectCorrupt(Ledger.fromSnapshot(snapshot));
});

test("a fabricated account with a balance but no transactions is detected", async () => {
  const { snapshot } = await honestSnapshot();
  snapshot.balances[CAROL] = "1000000000";
  await expectCorrupt(Ledger.fromSnapshot(snapshot));
});

test("a second faucet credit for the same address is rejected", async () => {
  const { alice, snapshot } = await honestSnapshot();
  snapshot.transactions.push({
    height: 3, type: "faucet", from: null, to: alice.address,
    amount: TESTNET_FAUCET_UNITS.toString(), nonce: null, publicKey: null, signature: null,
  });
  snapshot.balances[alice.address] = (BigInt(snapshot.balances[alice.address]) + TESTNET_FAUCET_UNITS).toString();
  await expectCorrupt(Ledger.fromSnapshot(snapshot));
});

test("a faucet record with an inflated amount is rejected", async () => {
  const { snapshot } = await honestSnapshot();
  snapshot.transactions[0].amount = "1000000000000";
  await expectCorrupt(Ledger.fromSnapshot(snapshot));
});

test("deleting a transaction while keeping the balances is detected", async () => {
  const { snapshot } = await honestSnapshot();
  snapshot.transactions.splice(1, 1);
  await expectCorrupt(Ledger.fromSnapshot(snapshot));
});

test("out-of-order heights are rejected", async () => {
  const { snapshot } = await honestSnapshot();
  [snapshot.transactions[0], snapshot.transactions[1]] = [snapshot.transactions[1], snapshot.transactions[0]];
  await expectCorrupt(Ledger.fromSnapshot(snapshot));
});

test("an unknown field injected into a record is rejected", async () => {
  const { snapshot } = await honestSnapshot();
  snapshot.transactions[1].memo = "<script>";
  await expectCorrupt(Ledger.fromSnapshot(snapshot));
});

test("an unknown transaction type is rejected", async () => {
  const { snapshot } = await honestSnapshot();
  snapshot.transactions[1].type = "mint";
  await expectCorrupt(Ledger.fromSnapshot(snapshot));
});

test("a nonce edited in storage is detected", async () => {
  const { alice, snapshot } = await honestSnapshot();
  snapshot.nonces[alice.address] = 5;
  await expectCorrupt(Ledger.fromSnapshot(snapshot));
});

test("a ledger exceeding the transaction limit is rejected without replay", async () => {
  await expectCorrupt(Ledger.fromSnapshot({ balances: {}, nonces: {}, transactions: new Array(MAX_TRANSACTIONS + 1).fill({}) }));
});

test("a snapshot of the wrong shape is rejected", async () => {
  await expectCorrupt(Ledger.fromSnapshot(null));
  await expectCorrupt(Ledger.fromSnapshot({ balances: [], nonces: {}, transactions: [] }));
  await expectCorrupt(Ledger.fromSnapshot({ balances: {}, nonces: {}, transactions: "x" }));
});

// ---------- Hostile keystore files ----------

async function goodKeystore() {
  const { keystore } = await createKeystore("right-passphrase-1", ITER);
  return JSON.parse(JSON.stringify(keystore));
}

test("a file larger than the size limit is rejected before parsing", async () => {
  const padded = JSON.stringify({ pad: "x".repeat(MAX_KEYSTORE_BYTES) });
  assert.throws(() => parseKeystoreFile(padded), /كبير الحجم/);
});

test("PBKDF2 iterations above the cap are rejected without deriving a key", async () => {
  const ks = await goodKeystore();
  ks.kdf.iterations = MAX_ITERATIONS + 1;
  assert.throws(() => parseKeystoreFile(JSON.stringify(ks)), /صيغة SNN/);
});

test("PBKDF2 iterations below the floor are rejected", async () => {
  const ks = await goodKeystore();
  ks.kdf.iterations = 1000;
  assert.throws(() => parseKeystoreFile(JSON.stringify(ks)), /صيغة SNN/);
});

test("wrong salt, IV, ciphertext or public-key lengths are rejected", async () => {
  const cases = [
    (k) => (k.kdf.salt = "ab"),
    (k) => (k.cipher.iv = "a".repeat(26)),
    (k) => (k.cipher.data = "a".repeat(126)),
    (k) => (k.publicKey = "a".repeat(62)),
    (k) => (k.publicKey = "G".repeat(64)),
  ];
  for (const mutate of cases) {
    const ks = await goodKeystore();
    mutate(ks);
    assert.throws(() => parseKeystoreFile(JSON.stringify(ks)), /صيغة SNN/);
  }
});

test("unknown extra fields in a keystore are rejected", async () => {
  const ks = await goodKeystore();
  ks.extra = "payload";
  assert.throws(() => parseKeystoreFile(JSON.stringify(ks)), /صيغة SNN/);
});

test("an address that does not match the public key is rejected on unlock", async () => {
  const ks = await goodKeystore();
  ks.address = "snn1" + "f".repeat(40);
  await assert.rejects(unlockKeystore(ks, "right-passphrase-1"), /لا يطابق العنوان/);
});

test("an oversized passphrase is refused before key derivation", async () => {
  const ks = await goodKeystore();
  await assert.rejects(unlockKeystore(ks, "x".repeat(10_000)), /كلمة المرور غير صحيحة/);
});

test("a tampered salt makes unlock fail without revealing which check failed", async () => {
  const ks = await goodKeystore();
  ks.kdf.salt = (ks.kdf.salt.startsWith("0") ? "1" : "0") + ks.kdf.salt.slice(1);
  await assert.rejects(unlockKeystore(ks, "right-passphrase-1"), /كلمة المرور غير صحيحة/);
});

test("the signing key produced on unlock can sign and the public key verifies it", async () => {
  const ks = await goodKeystore();
  const unlocked = await unlockKeystore(ks, "right-passphrase-1");
  const tx = await signedTransfer({ ...unlocked, address: ks.address }, BOB, "1", 0);
  const ledger = new Ledger();
  ledger.credit(ks.address, TESTNET_FAUCET_UNITS);
  await ledger.transfer(tx);
  assert.equal(ledger.balanceOf(BOB), parseAmount("1"));
});

test("account import rejects keys of the wrong length", async () => {
  await assert.rejects(importSigningKey(new Uint8Array(32)), /حجم المفتاح/);
  const other = await createAccount();
  assert.equal(other.privateKeyDer.length, 48);
});
