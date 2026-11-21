// Hybrid network: four validator processes running hybrid-v1 rules. Every proposal carries proof of work
// mined by the proposing node. Consensus must advance and the nodes must agree on the committed blocks.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { initNetwork } from "../node/tools.js";
import { makeAccount, signedTransfer } from "./helpers.js";
import { peerRequest } from "../node/tls.js";

const CLI = fileURLToPath(new URL("../node/cli.js", import.meta.url));
const PASS = "hybrid-test-passphrase";
const EASY_TARGET = "0000" + "f".repeat(60);
const TARGET_HEIGHT = 2;
const TIMEOUT_MS = 120_000;
const HYBRID_CHAIN = "snn-hybrid-net";

let dir;
let validators;
let alice;
let bob;
let pins;
const procs = [];

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "snn-hybrid-"));
  alice = await makeAccount();
  bob = await makeAccount();
  ({ validators } = await initNetwork(dir, HYBRID_CHAIN, [alice.address, bob.address], { passphrase: PASS, rules: "hybrid-v1", powTarget: EASY_TARGET }));
  pins = new Set(validators.map((v) => v.tls.fingerprint));
  const ports = [await freePort(), await freePort(), await freePort(), await freePort()];
  const urls = ports.map((p) => `https://127.0.0.1:${p}`);
  for (let i = 0; i < 4; i++) {
    const peers = urls.filter((_, j) => j !== i);
    const args = [CLI, "--port", String(ports[i]), "--data", join(dir, `n${i + 1}`), "--genesis", join(dir, "genesis.json"),
      "--validator-key", join(dir, `validator-${i + 1}.json`), "--round-ms", "1000"];
    for (const p of peers) args.push("--peer", p);
    procs.push(spawn(process.execPath, args, { stdio: ["ignore", "ignore", "ignore"], env: { ...process.env, SNN_VALIDATOR_PASSPHRASE: PASS } }));
  }
  globalThis.urls = urls;
  await new Promise((r) => setTimeout(r, 4000)); // let the nodes start listening
});

after(() => {
  for (const p of procs) p.kill("SIGTERM");
  rmSync(dir, { recursive: true, force: true });
});

async function status(url) {
  const res = await peerRequest({ url, path: "/status", pins, identity: { key: validators[0].tls.key, cert: validators[0].tls.cert }, timeoutMs: 2000 });
  return res.body;
}

const identity = () => ({ key: validators[0].tls.key, cert: validators[0].tls.cert });

// A validator only proposes when it has pending work, so one transaction is submitted per height.
// Each transaction goes to every node, so one slow node cannot hold it back.
async function submitEverywhere(nonce) {
  const tx = await signedTransfer(alice, bob.address, "1", nonce, HYBRID_CHAIN);
  for (const url of globalThis.urls) {
    await peerRequest({ url, method: "POST", path: "/tx", body: tx, pins, identity: identity(), timeoutMs: 3000 }).catch(() => {});
  }
}

async function waitForHeight(target, deadline) {
  let heights = [];
  while (Date.now() < deadline) {
    heights = await Promise.all(globalThis.urls.map((u) => status(u).then((s) => s.height).catch(() => -1)));
    if (heights.every((h) => h >= target)) return heights;
    await new Promise((r) => setTimeout(r, 500));
  }
  return heights;
}

test("four hybrid nodes commit proof-of-work blocks and agree on them", { timeout: TIMEOUT_MS * 2 + 10_000 }, async () => {
  await submitEverywhere(0);
  let heights = await waitForHeight(1, Date.now() + TIMEOUT_MS);
  assert.ok(heights.every((h) => h >= 1), `heights after block 1: ${heights}`);

  await submitEverywhere(1);
  heights = await waitForHeight(2, Date.now() + TIMEOUT_MS);
  assert.ok(heights.every((h) => h >= 2), `heights after block 2: ${heights}`);

  for (const height of [1, 2]) {
    const hashes = [];
    for (const url of globalThis.urls) {
      const res = await peerRequest({ url, path: `/blocks?from=${height}&limit=1`, pins, identity: identity() });
      hashes.push(res.body[0].hash);
    }
    assert.equal(new Set(hashes).size, 1, `all nodes agree on the block at height ${height}`);
  }
});
