// Determinism across independent nodes: four nodes, each with its own data directory and state object, validate the same
// certified block and must all reach the same state root, which must equal the root the proposer recorded.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChainNode } from "../node/node.js";
import { generateValidatorKey, DEFAULT_STAKE } from "../node/tools.js";
import { applyCommitted, attachStateRoot, buildBlock, createGenesisConfig, voteMessage, withWork } from "../chain/core.js";
import { signText } from "../chain/crypto.js";
import { compositeStateRoot, EMPTY_EVM_ROOT } from "../chain/stateroot.js";
import { makeAccount, signedTransfer } from "./helpers.js";

const T0 = Date.now() - 60_000;

async function certify(block, keys, chainId) {
  const signatures = [];
  for (const i of [0, 1, 2]) {
    signatures.push({
      validator: keys[i].publicKey,
      signature: await signText(keys[i].privateKeyDer, voteMessage(chainId, "precommit", block.height, 0, block.hash)),
    });
  }
  return { ...block, certificate: { round: 0, signatures } };
}

test("four independent nodes reach the same state root for the same certified block", async () => {
  const dirs = [];
  try {
    const alice = await makeAccount();
    const bob = await makeAccount();
    const keys = [];
    for (let i = 0; i < 4; i++) keys.push(await generateValidatorKey());
    const chainId = "snn-determinism-test";
    const genesis = createGenesisConfig({
      chainId,
      timestamp: T0,
      allocations: [alice.address, bob.address],
      validators: keys.map((k) => ({ publicKey: k.publicKey, stake: DEFAULT_STAKE })),
      maxShareBps: 4000,
      rules: "hybrid-v1",
      powTarget: "0000" + "f".repeat(60),
      stateRootV1: true,
    });

    const nodes = [];
    for (let i = 0; i < 4; i++) {
      const dir = mkdtempSync(join(tmpdir(), `snn-det-${i}-`));
      dirs.push(dir);
      const node = new ChainNode({ dataDir: dir, genesis });
      await node.init();
      nodes.push(node);
    }

    // The proposer builds the block, records the root, mines the work, then the block is certified.
    const proposer = nodes[0];
    const pay = await signedTransfer(alice, bob.address, "3", 0);
    let block = buildBlock({ height: 1, timestamp: T0 + 10, prevHash: proposer.tip.hash, txs: [pay] });
    block = await attachStateRoot(proposer.state, block, proposer.tip, genesis, proposer.blocks);
    block = withWork(block, genesis, proposer.tip);
    block = await certify(block, keys, chainId);

    // Every node validates the same certified block against its own state.
    const roots = [];
    for (const node of nodes) {
      const next = await applyCommitted(node.state, block, node.tip, genesis, node.blocks);
      roots.push(compositeStateRoot(next.ledger, EMPTY_EVM_ROOT));
    }
    for (const root of roots) assert.equal(root, block.stateRoot);
    assert.equal(new Set(roots).size, 1);
  } finally {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  }
});
