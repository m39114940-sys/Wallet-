// Hybrid rules: blocks carry proof of work checked against the chain's fixed target. Testnet rules are unchanged.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateValidatorKey, DEFAULT_STAKE } from "../node/tools.js";
import {
  applyCommitted,
  blockHashOf,
  buildBlock,
  checkBlockWork,
  createGenesisConfig,
  genesisBlock,
  genesisState,
  validateGenesis,
  voteMessage,
  withWork,
} from "../chain/core.js";
import { signText } from "../chain/crypto.js";
import { makeAccount, signedTransfer } from "./helpers.js";

const T0 = 1_700_000_000;
const EASY = "0000" + "f".repeat(60); // 2^240 target: about one attempt in 65,536

async function setup(chainId, hybrid = true) {
  const alice = await makeAccount();
  const bob = await makeAccount();
  const keys = [];
  for (let i = 0; i < 4; i++) keys.push(await generateValidatorKey());
  const config = createGenesisConfig({
    chainId,
    timestamp: T0,
    allocations: [alice.address, bob.address],
    validators: keys.map((k) => ({ publicKey: k.publicKey, stake: DEFAULT_STAKE })),
    maxShareBps: 4000,
    rules: hybrid ? "hybrid-v1" : undefined,
    powTarget: hybrid ? EASY : undefined,
  });
  return { alice, bob, keys, config, genesis: genesisBlock(config), state0: genesisState(config) };
}

async function certify(block, keys, chainId) {
  const signatures = [];
  for (const i of [0, 1, 2]) {
    signatures.push({ validator: keys[i].publicKey, signature: await signText(keys[i].privateKeyDer, voteMessage(chainId, "precommit", block.height, 0, block.hash)) });
  }
  return { ...block, certificate: { round: 0, signatures } };
}

test("Testnet genesis config has no rules and no target keys, so its hashes are unchanged", async () => {
  const s = await setup("snn-testnet-check", false);
  assert.equal("rules" in s.config, false);
  assert.equal("powTarget" in s.config, false);
});

test("genesis rejects an unknown rule set, a missing or zero target, and a target without hybrid rules", async () => {
  const s = await setup("snn-g-check");
  assert.throws(() => validateGenesis({ ...s.config, rules: "pow-v9" }), { code: "BAD_GENESIS" });
  assert.throws(() => validateGenesis({ ...s.config, powTarget: undefined }), { code: "BAD_GENESIS" });
  assert.throws(() => validateGenesis({ ...s.config, powTarget: "0" }), { code: "BAD_GENESIS" });
  const testnet = await setup("snn-g-check-2", false);
  assert.throws(() => validateGenesis({ ...testnet.config, powTarget: EASY }), { code: "BAD_GENESIS" });
  validateGenesis(s.config); // the valid one passes
});

test("a hybrid block mined for its chain is accepted and certified", async () => {
  const s = await setup("snn-hybrid-ok");
  const pay = await signedTransfer(s.alice, s.bob.address, "3", 0);
  const block = withWork(buildBlock({ height: 1, timestamp: T0 + 10, prevHash: s.genesis.hash, txs: [pay] }), s.config, s.genesis);
  const parent = { height: 0, hash: s.genesis.hash, timestamp: T0 };
  const state1 = await applyCommitted(s.state0, await certify(block, s.keys, s.config.chainId), parent, s.config);
  assert.equal(state1.ledger.balanceOf(s.bob.address).toString(), "103000000");
});

test("a hybrid block without work is refused with POW_MISSING", async () => {
  const s = await setup("snn-hybrid-missing");
  const block = buildBlock({ height: 1, timestamp: T0 + 10, prevHash: s.genesis.hash, txs: [] });
  await assert.rejects(
    applyCommitted(s.state0, await certify(block, s.keys, s.config.chainId), { height: 0, hash: s.genesis.hash, timestamp: T0 }, s.config),
    { code: "POW_MISSING" },
  );
});

test("work with an invalid nonce is refused even when the block hash is consistent", async () => {
  const s = await setup("snn-hybrid-badnonce");
  const good = withWork(buildBlock({ height: 1, timestamp: T0 + 10, prevHash: s.genesis.hash, txs: [] }), s.config, s.genesis);
  // Find a nonce that does not meet the target, and recompute the hash so only the work is wrong.
  let nonce = 0;
  const target = BigInt("0x" + EASY);
  const { workHash, meetsTarget } = await import("../chain/pow.js");
  const header = (n) => ({ chainId: s.config.chainId, height: 1, parentHash: s.genesis.hash, merkleRoot: good.merkleRoot, timestamp: good.timestamp, target, nonce: n });
  while (meetsTarget(workHash(header(nonce)), target)) nonce++;
  const forged = { ...good, work: { nonce, target: EASY } };
  forged.hash = blockHashOf(forged);
  await assert.rejects(
    applyCommitted(s.state0, await certify(forged, s.keys, s.config.chainId), { height: 0, hash: s.genesis.hash, timestamp: T0 }, s.config),
    { code: "POW_INVALID" },
  );
});

test("a block that states an easier target than the chain requires is refused", async () => {
  const s = await setup("snn-hybrid-easy");
  const block = withWork(buildBlock({ height: 1, timestamp: T0 + 10, prevHash: s.genesis.hash, txs: [] }), s.config, s.genesis);
  const easier = { ...block, work: { nonce: block.work.nonce, target: "f".repeat(64) } };
  easier.hash = blockHashOf(easier);
  assert.throws(() => checkBlockWork(easier, s.config, s.genesis), { code: "POW_BAD_TARGET" });
});

test("work mined for another chain is refused on this chain", async () => {
  const a = await setup("snn-hybrid-chain-a");
  const b = await setup("snn-hybrid-chain-b");
  const mined = withWork(buildBlock({ height: 1, timestamp: T0 + 10, prevHash: a.genesis.hash, txs: [] }), a.config, a.genesis);
  // Same block bytes, checked against chain B: the header there names chain B, so the work must fail.
  assert.throws(() => checkBlockWork(mined, b.config, b.genesis), { code: "POW_INVALID" });
});

test("tampering with the work changes the block hash, so the block is refused before any work check", async () => {
  const s = await setup("snn-hybrid-tamper");
  const block = withWork(buildBlock({ height: 1, timestamp: T0 + 10, prevHash: s.genesis.hash, txs: [] }), s.config, s.genesis);
  const tampered = { ...block, work: { nonce: block.work.nonce + 1, target: EASY } };
  await assert.rejects(
    applyCommitted(s.state0, await certify(tampered, s.keys, s.config.chainId), { height: 0, hash: s.genesis.hash, timestamp: T0 }, s.config),
    { code: "BAD_HASH" },
  );
});
