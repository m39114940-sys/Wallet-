// EVM value transfers inside blocks. They apply only on chains with stateRootV1, and a bad entry refuses the whole block.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateValidatorKey, DEFAULT_STAKE } from "../node/tools.js";
import {
  applyBlock,
  attachStateRoot,
  buildBlock,
  createGenesisConfig,
  genesisBlock,
  genesisState,
  validateGenesis,
  withWork,
} from "../chain/core.js";
import { compositeStateRoot } from "../chain/stateroot.js";
import { BASE_PER_SNN, EVM_CHAIN_IDS } from "../evm/params.js";
import { signTransfer } from "../evm/tx.js";
import { INTRINSIC_GAS } from "../evm/transfer.js";

const T0 = 1_700_000_000;
const EASY = "0000" + "f".repeat(60);
const KEY1 = new Uint8Array(32);
KEY1[31] = 1;
const KEY1_ADDRESS = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const TESTNET_ID = Number(EVM_CHAIN_IDS.testnet);

function entryFor({ nonce = 0, value = BASE_PER_SNN, chainId = EVM_CHAIN_IDS.testnet } = {}) {
  const tx = signTransfer({ privateKey: KEY1, nonce, gasLimit: INTRINSIC_GAS, to: RECIPIENT, value, chainId });
  return {
    nonce: tx.nonce.toString(),
    gasLimit: tx.gasLimit.toString(),
    to: tx.to.toString().toLowerCase(),
    value: tx.value.toString(),
    v: tx.v.toString(),
    r: tx.r.toString(),
    s: tx.s.toString(),
  };
}

async function setup({ stateRoot = true, evmAllocations = { [KEY1_ADDRESS]: (10n * BASE_PER_SNN).toString() } } = {}) {
  const keys = [];
  for (let i = 0; i < 4; i++) keys.push(await generateValidatorKey());
  const config = createGenesisConfig({
    chainId: "snn-evm-block-test",
    timestamp: T0,
    allocations: [],
    validators: keys.map((k) => ({ publicKey: k.publicKey, stake: DEFAULT_STAKE })),
    maxShareBps: 4000,
    rules: "hybrid-v1",
    powTarget: EASY,
    ...(stateRoot ? { stateRootV1: true, evmChainId: TESTNET_ID, evmAllocations } : {}),
  });
  return { config, genesis: genesisBlock(config), state0: genesisState(config) };
}

// Builds a block holding the given EVM entries, optionally attaches the state root, and mines its work.
async function blockWith(s, evmTxs, { attach = true } = {}) {
  let block = buildBlock({ height: 1, timestamp: T0 + 10, prevHash: s.genesis.hash, txs: [], evmTxs });
  if (attach) block = await attachStateRoot(s.state0, block, s.genesis, s.config);
  return withWork(block, s.config, s.genesis);
}

test("genesis funds the EVM accounts named in evmAllocations", async () => {
  const s = await setup();
  assert.equal(s.state0.evm.get(KEY1_ADDRESS).balance, 10n * BASE_PER_SNN);
  assert.equal(s.state0.evm.get(RECIPIENT).balance, 0n);
});

test("a block with a valid EVM transfer moves the value and commits to the resulting root", async () => {
  const s = await setup();
  const block = await blockWith(s, [entryFor()]);
  const next = await applyBlock(s.state0, block, s.genesis, s.config);
  assert.equal(next.evm.get(RECIPIENT).balance, BASE_PER_SNN);
  assert.equal(next.evm.get(KEY1_ADDRESS).nonce, 1);
  assert.equal(block.stateRoot, compositeStateRoot(next.ledger, next.evm.root()));
});

test("a block that repeats one EVM entry is refused as a whole", async () => {
  const s = await setup();
  const entry = entryFor();
  await assert.rejects(blockWith(s, [entry, entry]), (err) => err.code === "BAD_EVM_TX");
});

test("a refused block leaves the state it started from unchanged", async () => {
  const s = await setup();
  const before = s.state0.evm.root();
  const block = await blockWith(s, [entryFor(), entryFor({ nonce: 5 })], { attach: false });
  await assert.rejects(applyBlock(s.state0, block, s.genesis, s.config), (err) => err.code === "BAD_EVM_TX");
  assert.equal(s.state0.evm.root(), before);
});

test("an entry with a changed amount is refused", async () => {
  const s = await setup();
  const tampered = { ...entryFor(), value: (2n * BASE_PER_SNN).toString() };
  await assert.rejects(blockWith(s, [tampered]), (err) => err.code === "BAD_EVM_TX");
});

test("an entry signed for the mainnet chain id is refused on the testnet", async () => {
  const s = await setup();
  const foreign = entryFor({ chainId: EVM_CHAIN_IDS.mainnet });
  await assert.rejects(blockWith(s, [foreign]), (err) => err.code === "BAD_EVM_TX");
});

test("an entry with an extra field is refused even if the transfer itself is valid", async () => {
  const s = await setup();
  const extra = { ...entryFor(), data: "0x" };
  await assert.rejects(blockWith(s, [extra]), (err) => err.code === "BAD_EVM_TX");
});

test("a chain without stateRootV1 refuses blocks that carry EVM entries", async () => {
  const s = await setup({ stateRoot: false });
  const block = await blockWith(s, [entryFor()], { attach: false });
  await assert.rejects(applyBlock(s.state0, block, s.genesis, s.config), (err) => err.code === "BAD_EVM_TX");
});

test("genesis refuses EVM settings on a chain without stateRootV1", async () => {
  const s = await setup();
  const config = { ...s.config };
  delete config.stateRootV1;
  assert.throws(() => validateGenesis(config), (err) => err.code === "BAD_GENESIS");
});

test("genesis refuses malformed EVM allocations", async () => {
  const keys = [await generateValidatorKey()];
  const config = createGenesisConfig({
    chainId: "snn-evm-bad-genesis",
    timestamp: T0,
    allocations: [],
    validators: keys.map((k) => ({ publicKey: k.publicKey, stake: DEFAULT_STAKE })),
    rules: "hybrid-v1",
    powTarget: EASY,
    stateRootV1: true,
    evmChainId: TESTNET_ID,
    evmAllocations: { "0xABC": "1" },
  });
  assert.throws(() => validateGenesis(config), (err) => err.code === "BAD_GENESIS");
});
