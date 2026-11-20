// Exact integer weights, safe proposer selection, and punishment for double prevotes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { capWeights, proposerFor, hasQuorum, hasOneThird, sumOf } from "../chain/weights.js";
import { generateValidatorKey, DEFAULT_STAKE } from "../node/tools.js";
import { applyCommitted, buildBlock, createGenesisConfig, genesisBlock, genesisState, voteMessage } from "../chain/core.js";
import { signText } from "../chain/crypto.js";

test("a dominant stake is capped until every validator weighs the same, with exact integers", () => {
  const stakes = new Map([["big", 9000n], ...Array.from({ length: 9 }, (_, i) => [`s${i}`, 100n])]);
  const weights = capWeights(stakes, 1000n); // 10%
  for (const w of weights.values()) assert.equal(w, 100n);
  assert.equal(sumOf(weights), 1000n);
});

test("a cap that too few validators cannot satisfy is refused", () => {
  assert.throws(() => capWeights(new Map([["a", 1n], ["b", 1n]]), 4000n), /لا يكفي/); // 2 * 40% < 100%
  assert.throws(() => capWeights(new Map([["a", 1n], ["b", 1n], ["c", 1n]]), 3000n), /لا يكفي/);
});

test("quorum and one-third checks are strict", () => {
  assert.equal(hasQuorum(2n, 3n), false); // exactly 2/3 is not enough
  assert.equal(hasQuorum(3n, 4n), true);
  assert.equal(hasOneThird(1n, 3n), false);
  assert.equal(hasOneThird(2n, 3n), true);
});

test("proposer choice is deterministic and follows weight", () => {
  const weights = new Map([["a", 3000n], ["b", 1000n]]);
  const counts = { a: 0, b: 0 };
  for (let h = 0; h < 1000; h++) {
    const id = proposerFor(weights, h, 0);
    assert.equal(id, proposerFor(weights, h, 0));
    counts[id]++;
  }
  assert.ok(counts.a >= 650 && counts.a <= 850, `a proposed ${counts.a} of 1000 times`);
});

test("two prevotes for different blocks are punished the same way as double precommits", async () => {
  const keys = [];
  for (let i = 0; i < 4; i++) keys.push(await generateValidatorKey());
  const config = createGenesisConfig({
    chainId: "snn-unit-prevote",
    timestamp: 1_700_000_000,
    allocations: [],
    validators: keys.map((k) => ({ publicKey: k.publicKey, stake: DEFAULT_STAKE })),
    maxShareBps: 4000,
  });
  const genesis = genesisBlock(config);
  const sign = (k, type, h, r, target) =>
    signText(k.privateKeyDer, voteMessage(config.chainId, type, h, r, target));

  const b1 = buildBlock({ height: 1, timestamp: 1_700_000_010, prevHash: genesis.hash, txs: [] });
  const cert1 = { ...b1, certificate: { round: 0, signatures: [] } };
  for (const i of [0, 1, 2]) {
    cert1.certificate.signatures.push({
      validator: keys[i].publicKey,
      signature: await sign(keys[i], "precommit", 1, 0, b1.hash),
    });
  }
  const state1 = await applyCommitted(genesisState(config), cert1, { height: 0, hash: genesis.hash, timestamp: 1_700_000_000 }, config);

  const a = "e".repeat(64);
  const b = "f".repeat(64);
  const evidence = {
    type: "prevote",
    validator: keys[3].publicKey,
    height: 1,
    round: 0,
    blockA: a,
    signatureA: await sign(keys[3], "prevote", 1, 0, a),
    blockB: b,
    signatureB: await sign(keys[3], "prevote", 1, 0, b),
  };
  const b2 = buildBlock({ height: 2, timestamp: 1_700_000_020, prevHash: b1.hash, txs: [], evidence: [evidence] });
  const cert2 = { ...b2, certificate: { round: 0, signatures: [] } };
  for (const i of [0, 1, 2]) {
    cert2.certificate.signatures.push({
      validator: keys[i].publicKey,
      signature: await sign(keys[i], "precommit", 2, 0, b2.hash),
    });
  }
  const state2 = await applyCommitted(state1, cert2, { height: 1, hash: b1.hash, timestamp: 1_700_000_010 }, config);
  assert.equal(state2.stakes.get(keys[3].publicKey), 950000000n);
  assert.ok(state2.jailed.has(keys[3].publicKey));
});
