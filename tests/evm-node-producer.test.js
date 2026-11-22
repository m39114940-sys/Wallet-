// A node on a stateRootV1 chain accepts signed EVM transfers, includes them in the blocks it proposes, and drops them after commit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChainNode } from "../node/node.js";
import { generateValidatorKey, DEFAULT_STAKE } from "../node/tools.js";
import { applyBlock, createGenesisConfig } from "../chain/core.js";
import { BASE_PER_SNN, EVM_CHAIN_IDS } from "../evm/params.js";
import { signTransfer } from "../evm/tx.js";
import { INTRINSIC_GAS } from "../evm/transfer.js";

const KEY1 = new Uint8Array(32);
KEY1[31] = 1;
const KEY1_ADDRESS = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const RECIPIENT = "0x1111111111111111111111111111111111111111";

function entryFor(nonce = 0) {
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

async function withNode({ stateRoot = true }, fn) {
  const dir = mkdtempSync(join(tmpdir(), "snn-evm-node-"));
  try {
    const keys = [];
    for (let i = 0; i < 4; i++) keys.push(await generateValidatorKey());
    const genesis = createGenesisConfig({
      chainId: "snn-evm-node",
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
    const node = new ChainNode({ dataDir: dir, genesis });
    await node.init();
    await fn(node, genesis);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a valid EVM transfer is accepted, then included in the next block and applied by peers", async () => {
  await withNode({}, async (node, genesis) => {
    const entry = entryFor(0);
    const accepted = await node.submitEvmTx(entry);
    assert.equal(accepted.status, "accepted");
    assert.equal(node.evmMempool.size, 1);
    const block = await node.assemble([]);
    assert.deepEqual(block.evmTxs, [entry]);
    const next = await applyBlock(node.state, block, node.tip, genesis, node.blocks);
    assert.equal(next.evm.get(RECIPIENT).balance, BASE_PER_SNN);
  });
});

test("the same EVM entry submitted twice is reported as known, not added twice", async () => {
  await withNode({}, async (node) => {
    await node.submitEvmTx(entryFor(0));
    const again = await node.submitEvmTx(entryFor(0));
    assert.equal(again.status, "known");
    assert.equal(node.evmMempool.size, 1);
  });
});

test("an EVM entry with a wrong nonce is refused at submission and never enters the mempool", async () => {
  await withNode({}, async (node) => {
    await assert.rejects(node.submitEvmTx(entryFor(5)), (err) => err.code === "BAD_EVM_TX");
    assert.equal(node.evmMempool.size, 0);
  });
});

test("a node on a chain without stateRootV1 refuses EVM submissions", async () => {
  await withNode({ stateRoot: false }, async (node) => {
    await assert.rejects(node.submitEvmTx(entryFor(0)), (err) => err.code === "EVM_DISABLED");
  });
});

test("after commit the included EVM entry leaves the mempool", async () => {
  await withNode({}, async (node, genesis) => {
    await node.submitEvmTx(entryFor(0));
    const block = await node.assemble([]);
    const next = await applyBlock(node.state, block, node.tip, genesis, node.blocks);
    await node.commitBlock(block, next);
    assert.equal(node.evmMempool.size, 0);
  });
});

test("a block with no EVM entries carries no evmTxs field", async () => {
  await withNode({}, async (node) => {
    const block = await node.assemble([]);
    assert.equal(block.evmTxs, undefined);
  });
});
