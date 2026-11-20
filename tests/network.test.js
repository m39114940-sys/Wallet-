// Integration test: real node processes, real HTTP, real signatures.
// One producer and two followers run as separate OS processes. A follower is killed and restarted.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { initNetwork } from "../node/tools.js";
import { buildBlock, genesisBlock } from "../chain/core.js";
import { toHex } from "../js/signing.js";
import { makeAccount, signedTransfer } from "./helpers.js";

const CLI = fileURLToPath(new URL("../node/cli.js", import.meta.url));
const procs = [];
let dir;
let alice;
let bob;
let net_;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function startNode({ name, port, peers = [], producer = false }) {
  const args = [CLI, "--port", String(port), "--data", join(dir, name), "--genesis", join(dir, "genesis.json")];
  if (producer) args.push("--producer-key", join(dir, "producer.json"));
  for (const p of peers) args.push("--peer", p);
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", (d) => process.env.SNN_TEST_DEBUG && process.stderr.write(d));
  procs.push(child);
  return { name, port, url: `http://127.0.0.1:${port}`, child, args };
}

async function get(node, path) {
  const res = await fetch(`${node.url}${path}`);
  return { status: res.status, body: await res.json() };
}

async function post(node, path, body) {
  const res = await fetch(`${node.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function waitFor(predicate, label, timeoutMs = 15_000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await predicate();
      if (last) return last;
    } catch {
      /* node not up yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const height = async (node) => (await get(node, "/status")).body.height;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "snn-net-"));
  alice = await makeAccount();
  bob = await makeAccount();
  await initNetwork(dir, "snn-testnet-itest", [alice.address, bob.address]);
});

after(() => {
  for (const child of procs) child.kill("SIGTERM");
  rmSync(dir, { recursive: true, force: true });
});

test("three real processes reach the same chain, with gossip, forgery rejection and restart sync", async () => {
  const pPort = await freePort();
  const f1Port = await freePort();
  const f2Port = await freePort();
  const producer = startNode({ name: "producer", port: pPort, producer: true });
  const f1 = startNode({ name: "f1", port: f1Port, peers: [producer.url] });
  let f2 = startNode({ name: "f2", port: f2Port, peers: [producer.url] });
  net_ = { producer, f1, f2 };

  await waitFor(() => get(producer, "/status"), "producer up");
  await waitFor(() => get(f1, "/status"), "f1 up");
  await waitFor(() => get(f2, "/status"), "f2 up");

  // The producer learns about the followers, so blocks reach them.
  await post(producer, "/peers", { url: f1.url });
  await post(producer, "/peers", { url: f2.url });

  // 1. Alice pays Bob through follower f1. f1 gossips it to the producer.
  const pay = await signedTransfer(alice, bob.address, "3", 0);
  const accepted = await post(f1, "/tx", pay);
  assert.equal(accepted.status, 200);
  await waitFor(async () => (await get(producer, "/status")).body.mempool === 1, "tx gossiped to producer");

  // 2. The producer seals a block. Both followers receive it over HTTP.
  const produced = await post(producer, "/produce", {});
  assert.equal(produced.body.height, 1);
  await waitFor(async () => (await height(f1)) === 1 && (await height(f2)) === 1, "block 1 propagated");

  const bobOnF2 = await get(f2, `/balance?address=${bob.address}`);
  assert.equal(bobOnF2.body.units, "103000000"); // 100 from genesis plus the 3 sent
  assert.equal((await get(f2, "/status")).body.tipHash, (await get(producer, "/status")).body.tipHash);

  // 3. Replaying the same signed transfer is rejected by the nonce.
  const replay = await post(f2, "/tx", pay);
  assert.equal(replay.status, 400);
  assert.equal(replay.body.code, "NONCE_MISMATCH");

  // 4. A forged transfer is rejected by the signature check.
  const forged = await post(f1, "/tx", { ...pay, amount: "300" });
  assert.equal(forged.status, 400);
  assert.equal(forged.body.code, "BAD_SIGNATURE");

  // 5. A block signed by a non-producer key is rejected, even with valid internal structure.
  const attackerBlock = await buildBlock({
    height: 2,
    timestamp: Math.floor(Date.now() / 1000),
    prevHash: (await get(f1, "/status")).body.tipHash,
    txs: [],
    producer: toHex(alice.publicKey),
    privateKeyDerHex: toHex(alice.privateKeyDer),
  });
  const forgedBlock = await post(f1, "/block", attackerBlock);
  assert.equal(forgedBlock.status, 400);
  assert.equal(forgedBlock.body.code, "BAD_PRODUCER");
  assert.equal(await height(f1), 1);

  // 6. Follower f2 goes down. The producer keeps sealing blocks.
  f2.child.kill("SIGTERM");
  await new Promise((r) => f2.child.once("exit", r));
  const pay2 = await signedTransfer(bob, alice.address, "1", 0);
  assert.equal((await post(producer, "/tx", pay2)).status, 200);
  assert.equal((await post(producer, "/produce", {})).body.height, 2);
  assert.equal(await height(f1), 2);

  // 7. f2 restarts from its own disk and syncs the missing block from the producer.
  f2 = startNode({ name: "f2", port: f2Port, peers: [producer.url] });
  net_.f2 = f2;
  await waitFor(() => get(f2, "/status"), "f2 back up");
  await waitFor(async () => (await height(f2)) === 2, "f2 synced to height 2");
  assert.equal(
    (await get(f2, `/balance?address=${alice.address}`)).body.units,
    (await get(producer, `/balance?address=${alice.address}`)).body.units,
  );
});

test("a block from the producer with a tampered transaction is refused by the network", async () => {
  const status = (await get(net_.f1, "/status")).body;
  const tip = await get(net_.f1, `/blocks?from=${status.height}`);
  const genesis = genesisBlock({
    chainId: "snn-testnet-itest",
    timestamp: (await get(net_.f1, "/blocks?from=0")).body[0].timestamp,
    producerPublicKey: status.producerPublicKey,
    allocations: [alice.address, bob.address].sort(),
  });
  assert.equal(genesis.hash, (await get(net_.f1, "/blocks?from=0")).body[0].hash, "genesis agrees with the network");
  assert.ok(tip.body.length >= 1);

  // Build the next block honestly with the real producer key, then alter it before sending.
  const producerKey = JSON.parse(
    (await import("node:fs")).readFileSync(join(dir, "producer.json"), "utf8"),
  );
  const pay = await signedTransfer(alice, bob.address, "5", 1);
  const block = await buildBlock({
    height: status.height + 1,
    timestamp: Math.floor(Date.now() / 1000),
    prevHash: status.tipHash,
    txs: [pay],
    producer: status.producerPublicKey,
    privateKeyDerHex: producerKey.privateKeyDer,
  });
  block.txs[0] = { ...block.txs[0], amount: "500" };
  const res = await post(net_.f1, "/block", block);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "BAD_MERKLE");
  assert.equal(await height(net_.f1), status.height);
});
