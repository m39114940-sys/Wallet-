// State root in block rules. Only chains created with stateRootV1: true carry a root. Other chains refuse blocks that carry one.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MerkleStateManager } from "@ethereumjs/statemanager";
import { generateValidatorKey, DEFAULT_STAKE } from "../node/tools.js";
import { TESTNET_FAUCET_UNITS } from "../js/ledger.js";
import {
  applyBlock,
  attachStateRoot,
  blockHashOf,
  buildBlock,
  createGenesisConfig,
  genesisBlock,
  genesisState,
  validateGenesis,
  withWork,
} from "../chain/core.js";
import { EMPTY_EVM_ROOT } from "../chain/stateroot.js";
import { createTestnetCommon } from "../evm/engine.js";
import { makeAccount, signedTransfer } from "./helpers.js";

const T0 = 1_700_000_000;
const EASY = "0000" + "f".repeat(60);

async function setup({ stateRoot = true, chainId = "snn-stateroot-test" } = {}) {
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
    rules: "hybrid-v1",
    powTarget: EASY,
    stateRootV1: stateRoot ? true : undefined,
  });
  return { alice, bob, config, genesis: genesisBlock(config), state0: genesisState(config) };
}

async function transferBlock(s, { root = true } = {}) {
  const pay = await signedTransfer(s.alice, s.bob.address, "3", 0);
  let block = buildBlock({ height: 1, timestamp: T0 + 10, prevHash: s.genesis.hash, txs: [pay] });
  if (root) block = await attachStateRoot(s.state0, block, s.genesis, s.config);
  return withWork(block, s.config, s.genesis);
}

test("genesis refuses stateRootV1 without hybrid-v1 rules", async () => {
  const keys = [await generateValidatorKey()];
  const config = createGenesisConfig({
    chainId: "snn-stateroot-bad",
    timestamp: T0,
    allocations: [],
    validators: keys.map((k) => ({ publicKey: k.publicKey, stake: DEFAULT_STAKE })),
    stateRootV1: true,
  });
  assert.throws(() => validateGenesis(config), (err) => err.code === "BAD_GENESIS");
});

test("the empty EVM root constant equals the root of an empty EVM state", async () => {
  const stateManager = new MerkleStateManager({ common: createTestnetCommon() });
  const root = await stateManager.getStateRoot();
  assert.equal(`0x${Buffer.from(root).toString("hex")}`, EMPTY_EVM_ROOT);
});

test("a block with the correct state root is applied and the transfer is visible", async () => {
  const s = await setup();
  const block = await transferBlock(s);
  assert.equal(typeof block.stateRoot, "string");
  const next = await applyBlock(s.state0, block, s.genesis, s.config);
  assert.equal(next.ledger.balanceOf(s.bob.address), TESTNET_FAUCET_UNITS + 3_000_000n);
});

test("a block whose state root does not match the resulting state is refused", async () => {
  const s = await setup();
  const block = await transferBlock(s);
  const tampered = { ...block, stateRoot: "0x" + "e".repeat(64) };
  tampered.hash = blockHashOf(tampered);
  await assert.rejects(applyBlock(s.state0, tampered, s.genesis, s.config), (err) => err.code === "BAD_STATE_ROOT");
});

test("a block without a state root is refused on a chain with stateRootV1", async () => {
  const s = await setup();
  const block = await transferBlock(s, { root: false });
  await assert.rejects(applyBlock(s.state0, block, s.genesis, s.config), (err) => err.code === "BAD_STATE_ROOT");
});

test("a chain without stateRootV1 refuses blocks that carry a state root", async () => {
  const s = await setup({ stateRoot: false });
  const block = await transferBlock(s, { root: false });
  const withRoot = { ...block, stateRoot: EMPTY_EVM_ROOT };
  withRoot.hash = blockHashOf(withRoot);
  await assert.rejects(applyBlock(s.state0, withRoot, s.genesis, s.config), (err) => err.code === "BAD_STATE_ROOT");
});

test("attachStateRoot leaves blocks unchanged on a chain without stateRootV1", async () => {
  const s = await setup({ stateRoot: false });
  const block = buildBlock({ height: 1, timestamp: T0 + 10, prevHash: s.genesis.hash, txs: [] });
  const out = await attachStateRoot(s.state0, block, s.genesis, s.config);
  assert.equal(out.stateRoot, undefined);
  assert.equal(out.hash, block.hash);
});
