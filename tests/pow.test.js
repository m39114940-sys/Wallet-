// Proof of work: valid work is accepted, forged or reused work is rejected, and retargeting is bounded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mine, meetsTarget, medianTimePast, nextTarget, validateWork, workHash } from "../chain/pow.js";

const CHAIN = "snn-mainnet-test";
// 2^250: about one attempt in 64 meets it, so mining in tests is quick.
const EASY = 1n << 250n;
const MIN = 1n;
const MAX = (1n << 255n) - 1n;

const header = (over = {}) => ({
  chainId: CHAIN,
  height: 7,
  parentHash: "aa".repeat(32),
  merkleRoot: "bb".repeat(32),
  timestamp: 1_700_000_100,
  target: EASY,
  nonce: 0,
  ...over,
});

test("mined work validates against the target the rules require", () => {
  const mined = mine(header());
  assert.ok(meetsTarget(workHash(mined), EASY));
  assert.equal(validateWork(mined, EASY, CHAIN), workHash(mined));
});

test("forged work is rejected: a nonce that does not meet the target", () => {
  const mined = mine(header());
  const hash = workHash(mined);
  // Find a nonce that does not meet the target, so the forgery really is invalid.
  let bad = 0;
  while (meetsTarget(workHash({ ...mined, nonce: bad }), EASY)) bad++;
  assert.throws(() => validateWork({ ...mined, nonce: bad }, EASY, CHAIN), { code: "POW_INVALID" });
  assert.notEqual(hash, workHash({ ...mined, nonce: bad }));
});

test("work cannot be moved to another block: any changed field changes the hash", () => {
  const mined = mine(header());
  for (const change of [{ height: 8 }, { parentHash: "cc".repeat(32) }, { merkleRoot: "dd".repeat(32) }, { timestamp: 1_700_000_101 }]) {
    const moved = { ...mined, ...change };
    assert.notEqual(workHash(moved), workHash(mined));
  }
});

test("work from one chain is rejected on another chain", () => {
  const mined = mine(header());
  assert.throws(() => validateWork(mined, EASY, "snn-testnet"), { code: "POW_WRONG_CHAIN" });
});

test("a header that states an easier target than the rules require is rejected", () => {
  const easier = { ...mine(header({ target: EASY * 2n })), target: EASY * 2n };
  assert.throws(() => validateWork(easier, EASY, CHAIN), { code: "POW_BAD_TARGET" });
});

test("nonces outside the safe range are rejected", () => {
  const mined = mine(header());
  assert.throws(() => validateWork({ ...mined, nonce: -1 }, EASY, CHAIN), { code: "POW_BAD_NONCE" });
  assert.throws(() => validateWork({ ...mined, nonce: 1.5 }, EASY, CHAIN), { code: "POW_BAD_NONCE" });
});

test("the preimage separates fields, so a chain id containing a separator cannot forge another header", () => {
  const a = header({ chainId: "x|y", height: 1 });
  const b = header({ chainId: "x", height: 1, parentHash: "y|" + "aa".repeat(32) });
  assert.notEqual(workHash(a), workHash(b));
});

test("retarget: faster blocks lower the target (raise difficulty), slower blocks raise it", () => {
  const expected = 600n;
  const same = nextTarget({ previousTarget: EASY, actualSeconds: expected, expectedSeconds: expected, minTarget: MIN, maxTarget: MAX });
  assert.equal(same, EASY);
  const faster = nextTarget({ previousTarget: EASY, actualSeconds: 300n, expectedSeconds: expected, minTarget: MIN, maxTarget: MAX });
  assert.ok(faster < EASY);
  const slower = nextTarget({ previousTarget: EASY, actualSeconds: 1200n, expectedSeconds: expected, minTarget: MIN, maxTarget: MAX });
  assert.ok(slower > EASY);
});

test("retarget is clamped to a factor of 4 per window, and to the configured bounds", () => {
  const expected = 600n;
  const crazyFast = nextTarget({ previousTarget: EASY, actualSeconds: 1n, expectedSeconds: expected, minTarget: MIN, maxTarget: MAX });
  assert.equal(crazyFast, EASY / 4n);
  const crazySlow = nextTarget({ previousTarget: EASY, actualSeconds: 10n ** 9n, expectedSeconds: expected, minTarget: MIN, maxTarget: MAX });
  assert.equal(crazySlow, EASY * 4n);
  const capped = nextTarget({ previousTarget: EASY, actualSeconds: 10n ** 9n, expectedSeconds: expected, minTarget: MIN, maxTarget: EASY });
  assert.equal(capped, EASY);
});

test("retarget refuses a non-positive window", () => {
  assert.throws(() => nextTarget({ previousTarget: EASY, actualSeconds: 0n, expectedSeconds: 600n, minTarget: MIN, maxTarget: MAX }), {
    code: "POW_BAD_WINDOW",
  });
});

test("median time past is the middle timestamp", () => {
  assert.equal(medianTimePast([5, 1, 9, 3, 7]), 5);
  assert.throws(() => medianTimePast([]), { code: "POW_BAD_WINDOW" });
});
