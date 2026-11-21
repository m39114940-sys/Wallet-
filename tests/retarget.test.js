// Difficulty retargeting under hybrid-v1: the target at a window boundary is computed from ancestors,
// clamped, never easier than genesis, and a block that keeps the old target is refused.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateValidatorKey, DEFAULT_STAKE } from "../node/tools.js";
import {
  applyCommitted,
  buildBlock,
  createGenesisConfig,
  blockHashOf,
  expectedTarget,
  genesisBlock,
  genesisState,
  validateGenesis,
  voteMessage,
  withWork,
} from "../chain/core.js";
import { mine } from "../chain/pow.js";
import { signText } from "../chain/crypto.js";
import { makeAccount } from "./helpers.js";

const T0 = 1_700_000_000_000; // milliseconds, like the node's block timestamps
const EASY = "0000" + "f".repeat(60);
const EASY_N = BigInt("0x" + EASY);
const W = 4;
const BLOCK_MS = 1_000;

async function setup(chainId, opts = {}) {
  const retargetWindow = "retargetWindow" in opts ? opts.retargetWindow : W;
  const blockTimeMs = "blockTimeMs" in opts ? opts.blockTimeMs : BLOCK_MS;
  const alice = await makeAccount();
  const keys = [];
  for (let i = 0; i < 4; i++) keys.push(await generateValidatorKey());
  const config = createGenesisConfig({
    chainId,
    timestamp: T0,
    allocations: [alice.address],
    validators: keys.map((k) => ({ publicKey: k.publicKey, stake: DEFAULT_STAKE })),
    maxShareBps: 4000,
    rules: "hybrid-v1",
    powTarget: EASY,
    powRetargetWindow: retargetWindow,
    powBlockTimeMs: blockTimeMs,
  });
  return { keys, config, genesis: genesisBlock(config), state0: genesisState(config) };
}

async function certify(block, keys, chainId) {
  const signatures = [];
  for (const i of [0, 1, 2]) {
    signatures.push({ validator: keys[i].publicKey, signature: await signText(keys[i].privateKeyDer, voteMessage(chainId, "precommit", block.height, 0, block.hash)) });
  }
  return { ...block, certificate: { round: 0, signatures } };
}

// Commits blocks 1..n, spaced `spacingMs` apart, each mined by withWork under the chain's own rules.
async function build(s, n, spacingMs) {
  const chain = [s.genesis];
  let state = s.state0;
  for (let h = 1; h <= n; h++) {
    const parent = chain[chain.length - 1];
    const block = withWork(buildBlock({ height: h, timestamp: T0 + spacingMs * h, prevHash: parent.hash, txs: [] }), s.config, parent, chain);
    const certified = await certify(block, s.keys, s.config.chainId);
    state = await applyCommitted(state, certified, parent, s.config, chain);
    chain.push(certified);
  }
  return { chain, state };
}

test("fast blocks tighten the target at the window boundary, and blocks before it keep the old target", async () => {
  const s = await setup("snn-retarget-fast");
  const { chain } = await build(s, 3, 500); // three blocks at half the target time
  assert.equal(BigInt("0x" + chain[3].work.target), EASY_N, "blocks before the boundary keep the parent target");
  const atBoundary = expectedTarget(s.config, chain[3], chain, 4);
  assert.ok(atBoundary < EASY_N, "a faster-than-target window lowers the target (raises difficulty)");
  // ratio 1500/4000 = 0.375, so the new target is 0.375 of the old one
  assert.equal(atBoundary, (EASY_N * 1500n) / 4000n);
});

test("the block at the boundary is accepted with the computed target, and refused with the old one", async () => {
  const s = await setup("snn-retarget-check");
  const { chain, state } = await build(s, 3, 500);
  const parent = chain[3];
  const newTarget = expectedTarget(s.config, parent, chain, 4);

  // Correct: mined for the computed target.
  const good = withWork(buildBlock({ height: 4, timestamp: T0 + 2_000, prevHash: parent.hash, txs: [] }), s.config, parent, chain);
  assert.equal(good.work.target, newTarget.toString(16));
  await applyCommitted(state, await certify(good, s.keys, s.config.chainId), parent, s.config, chain);

  // Refused: mined for the old, easier target that the rules no longer allow at this height.
  const oldBlock = buildBlock({ height: 4, timestamp: T0 + 2_000, prevHash: parent.hash, txs: [] });
  const mined = mine({ chainId: s.config.chainId, height: 4, parentHash: parent.hash, merkleRoot: oldBlock.merkleRoot, timestamp: oldBlock.timestamp, target: EASY_N, nonce: 0 });
  const stale = { ...oldBlock, work: { nonce: mined.nonce, target: EASY } };
  stale.hash = blockHashOf(stale);
  await assert.rejects(applyCommitted(state, await certify(stale, s.keys, s.config.chainId), parent, s.config, chain), { code: "POW_BAD_TARGET" });
});

test("slow blocks raise the target, but never above the genesis ceiling", async () => {
  const s = await setup("snn-retarget-slow");
  const { chain } = await build(s, 3, 10_000); // ten times the target time
  assert.equal(expectedTarget(s.config, chain[3], chain, 4), EASY_N, "capped at the genesis target");
});

test("a retarget boundary without the history it needs is an error, not a guess", async () => {
  const s = await setup("snn-retarget-history");
  const { chain } = await build(s, 3, 500);
  assert.throws(() => expectedTarget(s.config, chain[3], null, 4), { code: "BAD_HISTORY" });
});

test("with no retarget window the target stays fixed", async () => {
  const s = await setup("snn-retarget-off", { retargetWindow: 0, blockTimeMs: undefined });
  const { chain } = await build(s, 4, 100);
  assert.equal(expectedTarget(s.config, chain[4], chain, 5), EASY_N);
});

test("a retarget window needs a target block time in genesis", async () => {
  // Built directly: setup() validates genesis, and this config is meant to be invalid.
  const keys = [await generateValidatorKey(), await generateValidatorKey()];
  const config = createGenesisConfig({
    chainId: "snn-retarget-config",
    timestamp: T0,
    allocations: [],
    validators: keys.map((k) => ({ publicKey: k.publicKey, stake: DEFAULT_STAKE })),
    rules: "hybrid-v1",
    powTarget: EASY,
    powRetargetWindow: W,
  });
  assert.throws(() => validateGenesis(config), { code: "BAD_GENESIS" });
});
