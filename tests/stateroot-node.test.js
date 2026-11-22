// A node on a stateRootV1 chain proposes blocks that carry a state root and pass the same validation a peer would run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChainNode } from "../node/node.js";
import { generateValidatorKey, DEFAULT_STAKE } from "../node/tools.js";
import { applyBlock, createGenesisConfig } from "../chain/core.js";
import { makeAccount } from "./helpers.js";

test("a stateRootV1 node proposes a block with a state root that peers accept", async () => {
  const dir = mkdtempSync(join(tmpdir(), "snn-stateroot-node-"));
  try {
    const alice = await makeAccount();
    const bob = await makeAccount();
    const keys = [];
    for (let i = 0; i < 4; i++) keys.push(await generateValidatorKey());
    const genesis = createGenesisConfig({
      chainId: "snn-stateroot-node",
      timestamp: Date.now(),
      allocations: [alice.address, bob.address],
      validators: keys.map((k) => ({ publicKey: k.publicKey, stake: DEFAULT_STAKE })),
      maxShareBps: 4000,
      rules: "hybrid-v1",
      powTarget: "0000" + "f".repeat(60),
      stateRootV1: true,
    });
    const node = new ChainNode({ dataDir: dir, genesis });
    await node.init();
    const block = await node.assemble([]);
    assert.equal(typeof block.stateRoot, "string");
    assert.ok(block.work, "hybrid blocks carry proof of work");
    // A peer validates the block with the same function a node uses on receipt.
    const next = await applyBlock(node.state, block, node.tip, genesis, node.blocks);
    assert.equal(next.ledger.balanceOf(bob.address), node.state.ledger.balanceOf(bob.address));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
