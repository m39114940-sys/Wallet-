// Fork choice: committed blocks are never rewritten, and among valid candidates more work wins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { chainWork, decideAdoption, keepsCommittedPrefix, workOfBlock } from "../chain/forkchoice.js";

const HYBRID = { chainId: "snn-fc", rules: "hybrid-v1", powTarget: "f".repeat(64) };
const TESTNET = { chainId: "snn-fc-t" };
const block = (hash, target) => ({ hash, height: 0, ...(target === undefined ? {} : { work: { nonce: 0, target } }) });
const genesis = block("g");
const EASY = "0000" + "f".repeat(60);
const HARD = "0000" + "0".repeat(4) + "f".repeat(56); // a much smaller target, so much more work per block

test("work of a block is inversely proportional to its target", () => {
  assert.ok(workOfBlock(block("x", HARD), HYBRID) > workOfBlock(block("y", EASY), HYBRID));
  assert.equal(workOfBlock(genesis, HYBRID), 0n);
});

test("a candidate that rewrites a committed block is refused, even if it is longer and heavier", () => {
  const local = [genesis, block("a1", EASY), block("a2", EASY)];
  const forked = [genesis, block("b1", HARD), block("b2", HARD), block("b3", HARD), block("b4", HARD)];
  assert.equal(keepsCommittedPrefix(local, forked), false);
  assert.deepEqual(decideAdoption(local, forked, HYBRID), { adopt: false, reason: "diverges" });
});

test("under hybrid rules a valid extension with more work is adopted", () => {
  // Every block under hybrid rules carries positive work, so an extension that adds a block is heavier.
  const local = [genesis, block("a1", EASY)];
  const heavier = [genesis, block("a1", EASY), block("h2", HARD)];
  assert.ok(chainWork(heavier, HYBRID) > chainWork(local, HYBRID));
  assert.deepEqual(decideAdoption(local, heavier, HYBRID), { adopt: true, reason: "heavier" });
});

test("a candidate that drops a committed block is refused, even when it is longer", () => {
  // A candidate must contain every committed block, so a shorter one cannot replace the local chain.
  const local = [genesis, block("a1", EASY), block("a2", EASY), block("a3", EASY)];
  const shorter = [genesis, block("a1", EASY), block("h2", HARD)];
  assert.deepEqual(decideAdoption(local, shorter, HYBRID), { adopt: false, reason: "diverges" });
});

test("a candidate identical to the local chain is not adopted", () => {
  const local = [genesis, block("a1", EASY), block("a2", HARD)];
  assert.deepEqual(decideAdoption(local, local.slice(), HYBRID), { adopt: false, reason: "lighter" });
});

test("under Testnet rules length decides, as before", () => {
  const local = [genesis, block("a1"), block("a2")];
  assert.deepEqual(decideAdoption(local, [genesis, block("a1"), block("a2"), block("a3")], TESTNET), { adopt: true, reason: "heavier" });
  assert.deepEqual(decideAdoption(local, [genesis, block("a1"), block("a2")], TESTNET), { adopt: false, reason: "lighter" });
});

test("an equal-work tie does not replace the local chain", () => {
  const local = [genesis, block("a1", EASY)];
  const tie = [genesis, block("b1", EASY)];
  assert.deepEqual(decideAdoption(local, tie, HYBRID), { adopt: false, reason: "diverges" });
});
