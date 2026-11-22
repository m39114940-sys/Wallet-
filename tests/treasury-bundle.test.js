import { test } from "node:test";
import assert from "node:assert/strict";
import { createAccount, toHex, importSigningKey } from "../js/signing.js";
import { proposalMessage, verifyWithdrawalBundle, TreasuryError } from "../econ/treasury.js";

const TO = "snn1" + "a".repeat(40);
const UNITS = 1_000n;
const TIMELOCK = 60_480;
const PROPOSED = 100;
const EXECUTE = PROPOSED + TIMELOCK;

async function signers(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = await createAccount();
    out.push({ pub: toHex(a.publicKey), key: await importSigningKey(a.privateKeyDer) });
  }
  return out;
}

async function approve(s, { id = 1, to = TO, units = UNITS, executeAfter = EXECUTE } = {}) {
  const msg = proposalMessage({ id, to, units, executeAfter });
  return { signer: s.pub, signature: toHex(new Uint8Array(await crypto.subtle.sign("Ed25519", s.key, msg))) };
}

async function fixture() {
  const set = await signers(5);
  const outsider = (await signers(1))[0];
  const config = { signers: set.map((s) => s.pub), threshold: 3, timelockBlocks: TIMELOCK };
  const base = { config, id: 1, to: TO, units: UNITS, proposedAt: PROPOSED, executeAfter: EXECUTE, height: EXECUTE };
  return { set, outsider, base };
}

test("three distinct valid approvals after the timelock pass", async () => {
  const { set, base } = await fixture();
  const approvals = await Promise.all([approve(set[0]), approve(set[2]), approve(set[4])]);
  assert.equal(await verifyWithdrawalBundle({ ...base, approvals }), true);
});

test("two approvals, or one signer counted twice, are refused", async () => {
  const { set, base } = await fixture();
  const two = await Promise.all([approve(set[0]), approve(set[1])]);
  await assert.rejects(verifyWithdrawalBundle({ ...base, approvals: two }), { code: "NOT_ENOUGH_APPROVALS" });
  const dup = [await approve(set[0]), await approve(set[0]), await approve(set[1])];
  await assert.rejects(verifyWithdrawalBundle({ ...base, approvals: dup }), { code: "DUPLICATE_APPROVAL" });
});

test("an outsider or a bad signature spoils the whole bundle", async () => {
  const { set, outsider, base } = await fixture();
  const good = await Promise.all([approve(set[0]), approve(set[1]), approve(set[2])]);
  await assert.rejects(verifyWithdrawalBundle({ ...base, approvals: [...good, await approve(outsider)] }), { code: "NOT_SIGNER" });
  const tampered = [...good.slice(0, 2), await approve(set[2], { units: 999n })];
  await assert.rejects(verifyWithdrawalBundle({ ...base, approvals: tampered }), { code: "BAD_SIGNATURE" });
});

test("timelock: early height and a wrong executeAfter are refused", async () => {
  const { set, base } = await fixture();
  const approvals = await Promise.all([approve(set[0]), approve(set[1]), approve(set[2])]);
  await assert.rejects(verifyWithdrawalBundle({ ...base, height: EXECUTE - 1, approvals }), { code: "TIMELOCKED" });
  await assert.rejects(verifyWithdrawalBundle({ ...base, executeAfter: EXECUTE + 1, approvals }), TreasuryError);
});
