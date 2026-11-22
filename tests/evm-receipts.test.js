// EVM receipts: available once the block is committed, derived from the chain, and the same after a restart.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLegacyTx } from "@ethereumjs/tx";
import { ChainNode } from "../node/node.js";
import { handleRpc, RPC_ERRORS } from "../node/jsonrpc.js";
import { generateValidatorKey, DEFAULT_STAKE } from "../node/tools.js";
import { applyBlock, buildBlock, createGenesisConfig } from "../chain/core.js";
import { receiptsOfBlock } from "../chain/receipts.js";
import { createTestnetCommon } from "../evm/engine.js";
import { BASE_PER_SNN, EVM_CHAIN_IDS, TESTNET_GAS_POLICY } from "../evm/params.js";
import { signTransfer } from "../evm/tx.js";
import { INTRINSIC_GAS } from "../evm/transfer.js";

const KEY1 = new Uint8Array(32);
KEY1[31] = 1;
const KEY1_ADDRESS = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const GAS_HEX = "0x" + INTRINSIC_GAS.toString(16);

// The signed transfer as the block stores it (decimal strings, lowercase recipient).
function entryFor(nonce) {
  const tx = signTransfer({ privateKey: KEY1, nonce, gasLimit: INTRINSIC_GAS, to: RECIPIENT, value: BASE_PER_SNN });
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

// The same transfer as a raw hex transaction, as a wallet would send it.
function rawOf(entry) {
  const tx = createLegacyTx(
    {
      nonce: BigInt(entry.nonce),
      gasPrice: TESTNET_GAS_POLICY.gasPriceBase,
      gasLimit: BigInt(entry.gasLimit),
      to: Uint8Array.from(Buffer.from(entry.to.slice(2), "hex")),
      value: BigInt(entry.value),
      data: new Uint8Array(0),
      v: BigInt(entry.v),
      r: BigInt(entry.r),
      s: BigInt(entry.s),
    },
    { common: createTestnetCommon() },
  );
  return "0x" + Buffer.from(tx.serialize()).toString("hex");
}

async function makeGenesis(stateRoot = true) {
  const keys = [];
  for (let i = 0; i < 4; i++) keys.push(await generateValidatorKey());
  return createGenesisConfig({
    chainId: "snn-receipts",
    timestamp: Date.now() - 60_000,
    allocations: [],
    validators: keys.map((k) => ({ publicKey: k.publicKey, stake: DEFAULT_STAKE })),
    maxShareBps: 4000,
    rules: "hybrid-v1",
    powTarget: "0000" + "f".repeat(60),
    ...(stateRoot
      ? { stateRootV1: true, evmChainId: Number(EVM_CHAIN_IDS.testnet), evmAllocations: { [KEY1_ADDRESS]: (10n * BASE_PER_SNN).toString() } }
      : {}),
  });
}

const rpc = (node, method, params) => handleRpc(node, { jsonrpc: "2.0", id: 1, method, params });

// Sends one raw transfer, mines and commits its block, and returns the hash the node reported.
async function sendAndCommit(node, genesis, entry) {
  const sent = rpc(node, "eth_sendRawTransaction", [rawOf(entry)]);
  const block = await node.assemble([]);
  const next = await applyBlock(node.state, block, node.tip, genesis, node.blocks);
  await node.commitBlock(block, next);
  return sent.result;
}

// Runs a test body with a fresh data directory, removed afterwards.
async function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "snn-receipts-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a committed transfer has a receipt that matches the hash the node reported", async () => {
  await withDir(async (dir) => {
    const genesis = await makeGenesis();
    const node = new ChainNode({ dataDir: dir, genesis });
    await node.init();
    const hash = await sendAndCommit(node, genesis, entryFor(0));
    const receipt = rpc(node, "eth_getTransactionReceipt", [hash]).result;
    assert.equal(receipt.transactionHash, hash);
    assert.equal(receipt.status, "0x1");
    assert.equal(receipt.blockNumber, "0x1");
    assert.equal(receipt.blockHash, node.tip.hash);
    assert.equal(receipt.transactionIndex, "0x0");
    assert.equal(receipt.gasUsed, GAS_HEX);
    assert.equal(receipt.cumulativeGasUsed, GAS_HEX);
    assert.equal(receipt.from, KEY1_ADDRESS);
    assert.equal(receipt.to, RECIPIENT);
    assert.deepEqual(receipt.logs, []);
  });
});

test("no receipt exists before the block is committed", async () => {
  await withDir(async (dir) => {
    const node = new ChainNode({ dataDir: dir, genesis: await makeGenesis() });
    await node.init();
    const hash = rpc(node, "eth_sendRawTransaction", [rawOf(entryFor(0))]).result;
    assert.equal(rpc(node, "eth_getTransactionReceipt", [hash]).result, null);
  });
});

test("an unknown hash returns null", async () => {
  await withDir(async (dir) => {
    const node = new ChainNode({ dataDir: dir, genesis: await makeGenesis() });
    await node.init();
    assert.equal(rpc(node, "eth_getTransactionReceipt", ["0x" + "ab".repeat(32)]).result, null);
  });
});

test("a malformed hash is refused as invalid params", async () => {
  await withDir(async (dir) => {
    const node = new ChainNode({ dataDir: dir, genesis: await makeGenesis() });
    await node.init();
    assert.equal(rpc(node, "eth_getTransactionReceipt", ["0x1234"]).error.code, RPC_ERRORS.INVALID_PARAMS);
  });
});

test("two transfers in one block get consecutive indexes and cumulative gas", () => {
  const block = buildBlock({
    height: 1,
    timestamp: 1_700_000_010_000,
    prevHash: "0".repeat(64),
    txs: [],
    evmTxs: [entryFor(0), entryFor(1)],
  });
  const [first, second] = receiptsOfBlock(block).map((x) => x.receipt);
  assert.equal(first.transactionIndex, "0x0");
  assert.equal(second.transactionIndex, "0x1");
  assert.equal(first.cumulativeGasUsed, GAS_HEX);
  assert.equal(second.cumulativeGasUsed, "0x" + (2n * INTRINSIC_GAS).toString(16));
});

test("a restarted node answers the same receipt from its stored chain", async () => {
  await withDir(async (dir) => {
    const genesis = await makeGenesis();
    const first = new ChainNode({ dataDir: dir, genesis });
    await first.init();
    const hash = await sendAndCommit(first, genesis, entryFor(0));
    const again = new ChainNode({ dataDir: dir, genesis });
    await again.init();
    const receipt = rpc(again, "eth_getTransactionReceipt", [hash]).result;
    assert.equal(receipt.transactionHash, hash);
    assert.equal(receipt.status, "0x1");
  });
});

test("receipts are refused on a chain without stateRootV1", async () => {
  await withDir(async (dir) => {
    const node = new ChainNode({ dataDir: dir, genesis: await makeGenesis(false) });
    await node.init();
    assert.equal(rpc(node, "eth_getTransactionReceipt", ["0x" + "ab".repeat(32)]).error.code, RPC_ERRORS.EVM_DISABLED);
  });
});
