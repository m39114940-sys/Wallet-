import { test } from "node:test";
import assert from "node:assert/strict";
import {
  capWeights,
  proposerFor,
  hasQuorum,
  tallyPrecommits,
  findEquivocations,
  applyEquivocationSlashing,
  runHeight,
  controllingSetSize,
  DEFAULT_MAX_SHARE,
} from "../consensus/sim.js";

const total = (weights) => [...weights.values()].reduce((a, b) => a + b, 0);
const ids = (n, prefix = "v") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
const equal = (names, stake = 10) => new Map(names.map((id) => [id, stake]));
const allOnline = (weights) => new Set(weights.keys());

// ---------- Weight caps ----------

test("no validator exceeds the cap, even with a 55% stake", () => {
  const stakes = new Map([["whale", 55], ...ids(9).map((id) => [id, 5])]);
  const weights = capWeights(stakes, DEFAULT_MAX_SHARE);
  const share = weights.get("whale") / total(weights);
  assert.ok(share <= DEFAULT_MAX_SHARE + 1e-9, `whale share ${share}`);
});

test("balanced stakes pass through the cap unchanged", () => {
  const stakes = equal(ids(10));
  const weights = capWeights(stakes);
  for (const id of stakes.keys()) assert.equal(weights.get(id), 10);
});

test("too few validators for the cap is refused", () => {
  assert.throws(() => capWeights(equal(ids(5)), 0.1), /يلزم 10 مدققين/);
});

test("zero or negative stakes are refused", () => {
  assert.throws(() => capWeights(new Map([["a", 0], ...ids(9).map((id) => [id, 1])])), /موجبة/);
});

// ---------- Proposer selection ----------

test("proposer choice is deterministic and always a known validator", () => {
  const weights = equal(ids(10));
  for (let h = 1; h <= 50; h++) {
    const a = proposerFor(weights, h, 0);
    assert.equal(a, proposerFor(weights, h, 0));
    assert.ok(weights.has(a));
  }
});

test("proposer frequency tracks capped weight, so a whale gets no more than its capped share", () => {
  const stakes = new Map([["whale", 90], ...ids(19).map((id) => [id, 5])]);
  const weights = capWeights(stakes);
  const cap = weights.get("whale") / total(weights);
  const counts = new Map();
  const N = 20_000;
  for (let h = 1; h <= N; h++) {
    const p = proposerFor(weights, h, 0);
    counts.set(p, (counts.get(p) ?? 0) + 1);
  }
  const whaleShare = (counts.get("whale") ?? 0) / N;
  assert.ok(Math.abs(whaleShare - cap) < 0.02, `whale ${whaleShare} vs capped ${cap}`);
});

// ---------- Quorum and vote counting ----------

test("finality needs strictly more than two thirds of weight", () => {
  assert.equal(hasQuorum(20, 30), false); // exactly 2/3 is not enough
  assert.equal(hasQuorum(21, 30), true);
});

test("a validator voting many times for one block counts once", () => {
  const weights = equal(ids(10));
  const votes = [
    { validator: "v0", height: 1, round: 0, blockHash: "A" },
    { validator: "v0", height: 1, round: 0, blockHash: "A" },
    { validator: "v0", height: 1, round: 0, blockHash: "A" },
  ];
  const result = tallyPrecommits(votes, weights, 1, 0);
  assert.equal(result.committed, false);
  assert.equal(result.power, 0 + 10); // one validator, 10 weight, not 30
});

test("votes from unknown validators, other heights or other rounds are ignored", () => {
  const weights = equal(ids(4));
  const votes = [
    { validator: "ghost", height: 1, round: 0, blockHash: "A" },
    { validator: "v0", height: 2, round: 0, blockHash: "A" },
    { validator: "v1", height: 1, round: 1, blockHash: "A" },
  ];
  assert.equal(tallyPrecommits(votes, weights, 1, 0).committed, false);
});

// ---------- Liveness and halting ----------

const blockFor = (h, r, p) => `block-${h}-${r}-${p}`;

test("with everyone online, a block commits in the first round", () => {
  const weights = equal(ids(10));
  const result = runHeight({ weights, height: 1, online: allOnline(weights), blockFor });
  assert.equal(result.committed, true);
  assert.equal(result.round, 0);
});

test("an offline first proposer times out and the next round commits", () => {
  const weights = equal(ids(10));
  const first = proposerFor(weights, 7, 0);
  const online = new Set([...weights.keys()].filter((id) => id !== first));
  const result = runHeight({ weights, height: 7, online, blockFor });
  assert.equal(result.committed, true);
  assert.ok(result.round > 0);
  assert.notEqual(result.proposer, first);
});

test("fewer than one third offline still commits", () => {
  const weights = equal(ids(9));
  const online = new Set(ids(9).slice(2)); // 2 of 9 offline, 7/9 online
  const result = runHeight({ weights, height: 3, online, blockFor, maxRounds: 30 });
  assert.equal(result.committed, true);
});

test("exactly one third offline halts, because the quorum rule is strictly above two thirds", () => {
  const weights = equal(ids(9));
  const online = new Set(ids(9).slice(3)); // 3 of 9 offline, 6/9 = exactly 2/3 online
  const result = runHeight({ weights, height: 3, online, blockFor, maxRounds: 30 });
  assert.equal(result.committed, false);
});

test("more than one third offline halts the chain instead of finalizing unsafely", () => {
  const weights = equal(ids(9));
  const online = new Set(ids(9).slice(4)); // 4 of 9 offline
  const result = runHeight({ weights, height: 3, online, blockFor, maxRounds: 50 });
  assert.equal(result.committed, false);
});

// ---------- Safety ----------

test("an attacker below one third cannot finalize a conflicting block", () => {
  const weights = equal(ids(10));
  const honest = ids(10).slice(0, 7); // 70%
  const attackers = ids(10).slice(7); // 30%
  const votes = [
    ...honest.map((v) => ({ validator: v, height: 1, round: 0, blockHash: "A" })),
    ...attackers.flatMap((v) => [
      { validator: v, height: 1, round: 0, blockHash: "A" },
      { validator: v, height: 1, round: 0, blockHash: "B" },
    ]),
  ];
  const result = tallyPrecommits(votes, weights, 1, 0);
  assert.equal(result.committed, true);
  assert.equal(result.blockHash, "A");
  assert.equal(tallyPrecommits(votes.filter((v) => v.blockHash === "B"), weights, 1, 0).committed, false);
});

test("above one third double-signing can finalize two conflicting blocks, so the bound is necessary", () => {
  // Honest validators split 30/30 between A and B; 40% double-sign for both. Both reach quorum.
  // This is why the design caps fault tolerance at below one third.
  const weights = equal(ids(10));
  const groupA = ids(10).slice(0, 3);
  const groupB = ids(10).slice(3, 6);
  const byz = ids(10).slice(6);
  const votes = [
    ...groupA.map((v) => ({ validator: v, height: 1, round: 0, blockHash: "A" })),
    ...groupB.map((v) => ({ validator: v, height: 1, round: 0, blockHash: "B" })),
    ...byz.flatMap((v) => [
      { validator: v, height: 1, round: 0, blockHash: "A" },
      { validator: v, height: 1, round: 0, blockHash: "B" },
    ]),
  ];
  const a = tallyPrecommits(votes.filter((v) => v.blockHash === "A"), weights, 1, 0);
  const b = tallyPrecommits(votes.filter((v) => v.blockHash === "B"), weights, 1, 0);
  assert.equal(a.committed && b.committed, true);
});

// ---------- Accountability ----------

test("double signing is detected from the votes themselves", () => {
  const votes = [
    { validator: "v1", height: 4, round: 0, blockHash: "A" },
    { validator: "v1", height: 4, round: 0, blockHash: "B" },
    { validator: "v2", height: 4, round: 0, blockHash: "A" },
  ];
  assert.deepEqual(findEquivocations(votes), [{ validator: "v1", height: 4, round: 0 }]);
});

test("honest repeats of the same vote are not evidence", () => {
  const votes = [
    { validator: "v1", height: 4, round: 0, blockHash: "A" },
    { validator: "v1", height: 4, round: 0, blockHash: "A" },
  ];
  assert.deepEqual(findEquivocations(votes), []);
});

test("equivocators lose stake and are jailed, and jailed validators do not vote", () => {
  const stakes = equal(ids(10), 100);
  const evidence = [{ validator: "v1", height: 4, round: 0 }];
  const { stakes: after, jailed } = applyEquivocationSlashing(stakes, new Set(), evidence);
  assert.equal(after.get("v1"), 100 * (1 - 0.05));
  assert.equal(after.get("v2"), 100);
  assert.ok(jailed.has("v1"));

  const weights = capWeights(after);
  const result = runHeight({ weights, height: 5, online: allOnline(weights), jailed, blockFor });
  assert.equal(result.committed, true);
  assert.ok(result.votes.every((v) => v.validator !== "v1"));
});

// ---------- Concentration ----------

test("the cap makes it take more validators to control the chain", () => {
  const raw = new Map([["whale", 55], ...ids(9).map((id) => [id, 5])]);
  const capped = capWeights(raw);
  assert.equal(controllingSetSize(raw, 1 / 3), 1);
  assert.ok(controllingSetSize(capped, 1 / 3) >= 4);
});

test("controlling set sizes for equal validators", () => {
  const weights = equal(ids(10));
  assert.equal(controllingSetSize(weights, 1 / 3), 4);
  assert.equal(controllingSetSize(weights, 2 / 3), 7);
});

test("documented limit: the cap is per identity, so one operator with many identities keeps its combined share", () => {
  // Ten honest identities with 10 each. One operator splits 45 across nine identities with 5 each.
  // Each identity is far below the cap, so the cap does nothing, and the operator holds about 31% of weight.
  const stakes = new Map([...ids(10).map((id) => [id, 10]), ...ids(9, "sybil").map((id) => [id, 5])]);
  const weights = capWeights(stakes);
  const operatorShare = ids(9, "sybil").reduce((sum, id) => sum + weights.get(id), 0) / total(weights);
  assert.ok(operatorShare > 0.3, `operator share ${operatorShare}`);
  // Mitigation belongs in the design: minimum stake per validator, and identity costs (see the design document).
});
