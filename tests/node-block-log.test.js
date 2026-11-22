// Node block storage in "log" mode. Opt-in: the default "json" mode is covered by the existing node tests.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChainNode } from "../node/node.js";
import { generateValidatorKey, DEFAULT_STAKE } from "../node/tools.js";
import { createGenesisConfig } from "../chain/core.js";
import { RecordLog } from "../js/record-log.js";

async function genesis() {
  const keys = [];
  for (let i = 0; i < 4; i++) keys.push(await generateValidatorKey());
  return createGenesisConfig({
    chainId: "snn-block-log-test",
    timestamp: Date.now() - 60_000,
    allocations: [],
    validators: keys.map((k) => ({ publicKey: k.publicKey, stake: DEFAULT_STAKE })),
    maxShareBps: 4000,
    rules: "hybrid-v1",
    powTarget: "0000" + "f".repeat(60),
  });
}

async function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "snn-block-log-"));
  try {
    await fn(dir, await genesis());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a fresh log-mode node writes genesis to blocks-log and reopens to the same tip", async () => {
  await withDir(async (dir, g) => {
    const first = new ChainNode({ dataDir: dir, genesis: g, storage: "log" });
    await first.init();
    assert.equal(existsSync(join(dir, "blocks-log")), true);
    assert.equal(new RecordLog(join(dir, "blocks-log")).length, 1);
    const second = new ChainNode({ dataDir: dir, genesis: g, storage: "log" });
    await second.init();
    assert.equal(second.tip.hash, first.tip.hash);
    assert.equal(second.blocks.length, 1);
  });
});

test("the default json mode writes chain.json and no block log", async () => {
  await withDir(async (dir, g) => {
    const node = new ChainNode({ dataDir: dir, genesis: g });
    await node.init();
    assert.equal(existsSync(join(dir, "chain.json")), true);
    assert.equal(existsSync(join(dir, "blocks-log")), false);
  });
});

test("an existing json chain migrates to the log on the next persist", async () => {
  await withDir(async (dir, g) => {
    const legacy = new ChainNode({ dataDir: dir, genesis: g });
    await legacy.init();
    const migrating = new ChainNode({ dataDir: dir, genesis: g, storage: "log" });
    await migrating.init();
    migrating.persist();
    assert.equal(new RecordLog(join(dir, "blocks-log")).length, migrating.blocks.length);
    assert.equal(migrating.tip.hash, legacy.tip.hash);
  });
});

test("an unknown storage mode is refused", async () => {
  await withDir(async (dir, g) => {
    assert.throws(() => new ChainNode({ dataDir: dir, genesis: g, storage: "sqlite" }), /نوع التخزين/);
  });
});
