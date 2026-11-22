import { test } from "node:test";
import assert from "node:assert/strict";
import { createAccount, toHex, importSigningKey } from "../js/signing.js";
import { Treasury, TreasuryError, proposalMessage, validateTreasuryConfig } from "../econ/treasury.js";

const TO = "snn1" + "a".repeat(40);
const UNITS = 1_000n;

async function signers(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const acct = await createAccount();
    out.push({ pub: toHex(acct.publicKey), key: await importSigningKey(acct.privateKeyDer) });
  }
  return out;
}

// Signs the approved message for proposal `id` with the given executeAfter.
async function sign(signer, id, executeAfter, units = UNITS) {
  const msg = proposalMessage({ id, to: TO, units, executeAfter });
  return toHex(new Uint8Array(await crypto.subtle.sign("Ed25519", signer.key, msg)));
}

async function setup(timelockBlocks) {
  const set = await signers(5);
  const outsider = (await signers(1))[0];
  const treasury = new Treasury({ signers: set.map((s) => s.pub), threshold: 3, timelockBlocks });
  return { set, outsider, treasury };
}

// The first proposal of a fresh treasury has id 1. The proposer's approval counts as one.
async function proposeFirst(treasury, proposer, height) {
  const executeAfter = height + treasury.config.timelockBlocks;
  const signature = await sign(proposer, 1, executeAfter);
  return treasury.propose({ height, proposer: proposer.pub, signature, to: TO, units: UNITS });
}

test("config must be 5 distinct keys with threshold 3", async () => {
  const keys = (await signers(5)).map((s) => s.pub);
  assert.throws(() => validateTreasuryConfig({ signers: keys.slice(0, 4), threshold: 3, timelockBlocks: 5 }), TreasuryError);
  assert.throws(() => validateTreasuryConfig({ signers: [...keys.slice(0, 4), keys[0]], threshold: 3, timelockBlocks: 5 }), TreasuryError);
  assert.throws(() => validateTreasuryConfig({ signers: keys, threshold: 2, timelockBlocks: 5 }), TreasuryError);
  assert.throws(() => validateTreasuryConfig({ signers: keys, threshold: 3, timelockBlocks: 0 }), TreasuryError);
  assert.throws(() => validateTreasuryConfig({ signers: keys.map((k) => k.slice(0, 10)), threshold: 3, timelockBlocks: 5 }), TreasuryError);
  assert.equal(validateTreasuryConfig({ signers: keys, threshold: 3, timelockBlocks: 5 }).signers.length, 5);
});

test("one proposal is not enough; three approvals plus the timelock are", async () => {
  const { set, treasury } = await setup(10);
  const id = await proposeFirst(treasury, set[0], 100);
  assert.equal(id, 1);
  await assert.rejects(treasury.execute({ id, height: 200 }), { code: "NOT_ENOUGH_APPROVALS" });
  await treasury.approve({ id, height: 101, signer: set[1].pub, signature: await sign(set[1], id, 110) });
  await assert.rejects(treasury.execute({ id, height: 200 }), { code: "NOT_ENOUGH_APPROVALS" }, "two approvals are still short");
  await treasury.approve({ id, height: 102, signer: set[2].pub, signature: await sign(set[2], id, 110) });
  await assert.rejects(treasury.execute({ id, height: 109 }), { code: "TIMELOCKED" });
  assert.deepEqual(await treasury.execute({ id, height: 110 }), { to: TO, units: UNITS });
});

test("duplicate, outsider, bad signature and double execution are refused", async () => {
  const { set, outsider, treasury } = await setup(5);
  const id = await proposeFirst(treasury, set[0], 1);
  await assert.rejects(treasury.approve({ id, height: 2, signer: set[0].pub, signature: await sign(set[0], id, 6) }), { code: "DUPLICATE_APPROVAL" });
  await assert.rejects(treasury.approve({ id, height: 2, signer: outsider.pub, signature: await sign(outsider, id, 6) }), { code: "NOT_SIGNER" });
  const wrong = await sign(set[1], id, 6, 999n);
  await assert.rejects(treasury.approve({ id, height: 2, signer: set[1].pub, signature: wrong }), { code: "BAD_SIGNATURE" });
  await treasury.approve({ id, height: 2, signer: set[1].pub, signature: await sign(set[1], id, 6) });
  await treasury.approve({ id, height: 2, signer: set[2].pub, signature: await sign(set[2], id, 6) });
  await treasury.execute({ id, height: 6 });
  await assert.rejects(treasury.execute({ id, height: 7 }), { code: "ALREADY_EXECUTED" });
  await assert.rejects(treasury.approve({ id, height: 8, signer: set[3].pub, signature: await sign(set[3], id, 6) }), { code: "ALREADY_EXECUTED" });
});

test("the proposer must be a configured signer and sign the exact proposal", async () => {
  const { set, outsider, treasury } = await setup(5);
  await assert.rejects(proposeFirst(treasury, outsider, 1), { code: "NOT_SIGNER" });
  await assert.rejects(
    treasury.propose({ height: 1, proposer: set[0].pub, signature: await sign(set[0], 1, 6, 5n), to: TO, units: UNITS }),
    { code: "BAD_SIGNATURE" },
  );
});

test("audit trail is hash-chained and verifies", async () => {
  const { set, treasury } = await setup(5);
  await proposeFirst(treasury, set[0], 1);
  const trail = treasury.audit;
  assert.equal(trail.length, 2);
  assert.equal(trail[1].prevHash, trail[0].hash);
  assert.equal(await treasury.verifyAudit(), true);
});
