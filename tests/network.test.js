// Integration test: four real validator processes over real HTTP, with real signatures.
// Covers: agreement on certified blocks, a crash that the chain survives, refused forged and tampered
// blocks, double-sign evidence that slashes and jails, a halt when too few validators are alive,
// and a restarted validator catching up from its own disk and its peers.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { initNetwork } from "../node/tools.js";
import { buildBlock, voteMessage } from "../chain/core.js";
import { signText } from "../chain/crypto.js";
import { makeAccount, signedTransfer } from "./helpers.js";

const CLI = fileURLToPath(new URL("../node/cli.js", import.meta.url));
const CHAIN = "snn-testnet-itest";
const ROUND_MS = 600;
const procs = new Map(); // name -> child process
let dir;
let alice;
let bob;
let validators;
let nodes;

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

function startNode(name, port, validatorIndex, peerUrls) {
  const args = [
    CLI,
    "--port", String(port),
    "--data", join(dir, name),
    "--genesis", join(dir, "genesis.json"),
    "--validator-key", join(dir, `validator-${validatorIndex}.json`),
    "--round-ms", String(ROUND_MS),
  ];
  for (const p of peerUrls) args.push("--peer", p);
  const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stderr.on("data", (d) => process.env.SNN_TEST_DEBUG && process.stderr.write(d));
  procs.set(name, child);
  return { name, url: `http://127.0.0.1:${port}` };
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

async function waitFor(predicate, label, timeoutMs = 30_000) {
  const started = Date.now();
  let last;
  while (Date.now() - started < timeoutMs) {
    try {
      last = await predicate();
      if (last) return last;
    } catch {
      /* node not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`timed out waiting for ${label}`);
}

const height = async (node) => (await get(node, "/status")).body.height;
const balanceUnits = async (node, address) => (await get(node, `/balance?address=${address}`)).body.units;

async function killNode(name) {
  const child = procs.get(name);
  child.kill("SIGTERM");
  await new Promise((r) => child.once("exit", r));
}

// A certificate signed by the given validator indexes, for a block the test builds itself.
async function certifiedBlock(block, round, signers) {
  const signatures = [];
  for (const i of signers) {
    const v = validators[i - 1];
    const message = voteMessage(CHAIN, "precommit", block.height, round, block.hash);
    signatures.push({ validator: v.publicKey, signature: await signText(v.privateKeyDer, message) });
  }
  return { ...block, certificate: { round, signatures } };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "snn-net-"));
  alice = await makeAccount();
  bob = await makeAccount();
  ({ validators } = await initNetwork(dir, CHAIN, [alice.address, bob.address]));
});

after(() => {
  for (const child of procs.values()) child.kill("SIGTERM");
  rmSync(dir, { recursive: true, force: true });
});

test("four validators agree on certified blocks, survive a crash, and punish double signing", async () => {
  const ports = await Promise.all([freePort(), freePort(), freePort(), freePort()]);
  const urls = ports.map((p) => `http://127.0.0.1:${p}`);
  // Full mesh: every validator knows every other one from the start.
  nodes = ports.map((port, i) =>
    startNode(`v${i + 1}`, port, i + 1, urls.filter((_, j) => j !== i)),
  );
  const [v1, v2, v3, v4] = nodes;
  for (const n of nodes) await waitFor(() => get(n, "/status"), `${n.name} up`);

  // 1. A transfer through validator 1 is gossiped, certified by a quorum, and seen by everyone.
  const pay = await signedTransfer(alice, bob.address, "3", 0);
  assert.equal((await post(v1, "/tx", pay)).status, 200);
  await waitFor(async () => (await balanceUnits(v4, bob.address)) === "103000000", "block 1 on v4");
  await waitFor(async () => (await height(v1)) === 1 && (await height(v2)) === 1 && (await height(v3)) === 1, "height 1 everywhere");
  const block1 = (await get(v3, "/blocks?from=1")).body[0];
  assert.ok(block1.certificate.signatures.length >= 3, "block carries a quorum certificate");
  assert.equal((await get(v1, "/status")).body.tipHash, (await get(v4, "/status")).body.tipHash);

  // 2. Forgeries are refused: a replayed transfer, a changed amount, and a block with one signature only.
  const replay = await post(v2, "/tx", pay);
  assert.equal(replay.status, 400);
  assert.equal(replay.body.code, "NONCE_MISMATCH");
  const forged = await post(v1, "/tx", { ...pay, amount: "300" });
  assert.equal(forged.body.code, "BAD_SIGNATURE");

  const tip = (await get(v1, "/status")).body;
  const honest = await certifiedBlock(
    buildBlock({ height: tip.height + 1, timestamp: Date.now(), prevHash: tip.tipHash, txs: [] }),
    0,
    [1, 2, 3],
  );
  const oneSigner = { ...honest, certificate: { round: 0, signatures: [honest.certificate.signatures[0]] } };
  const noQuorum = await post(v1, "/block", oneSigner);
  assert.equal(noQuorum.status, 400);
  assert.equal(noQuorum.body.code, "NO_QUORUM");
  assert.equal(await height(v1), tip.height, "refused blocks do not move the chain");

  // 3. Validator 4 goes down. Three of four is more than two thirds, so the chain keeps going.
  await killNode("v4");
  const pay2 = await signedTransfer(bob, alice.address, "1", 0);
  assert.equal((await post(v2, "/tx", pay2)).status, 200);
  await waitFor(async () => (await balanceUnits(v3, alice.address)) === "98000000", "payment with v4 down");
  assert.equal(await balanceUnits(v1, alice.address), "98000000");

  // 4. Double signing: validator 4 signs two different precommits for height 1. Evidence is gossiped,
  //    included in a block, and the validator loses 5% of its stake and is jailed.
  const culprit = validators[3];
  const sign = (target) => signText(culprit.privateKeyDer, voteMessage(CHAIN, "precommit", 1, 0, target));
  const blockA = "a".repeat(64);
  const blockB = "b".repeat(64);
  const evidence = {
    type: "precommit",
    validator: culprit.publicKey,
    height: 1,
    round: 0,
    blockA,
    signatureA: await sign(blockA),
    blockB,
    signatureB: await sign(blockB),
  };
  assert.equal((await post(v2, "/evidence", evidence)).status, 200);
  const jailed = async (node) => {
    const info = (await get(node, "/validators")).body.validators;
    return info.find((v) => v.publicKey === culprit.publicKey);
  };
  await waitFor(async () => (await jailed(v1))?.jailed === true, "validator 4 jailed on v1");
  await waitFor(async () => (await jailed(v3))?.jailed === true, "validator 4 jailed on v3");
  assert.equal((await jailed(v1)).stake, "950000000");

  // 5. With validator 4 jailed, three active validators remain, and all of them are needed.
  //    Stopping one of them leaves two, which is not enough, so the chain must halt, not split.
  await killNode("v3");
  const before_ = await height(v1);
  await new Promise((r) => setTimeout(r, 3_000));
  assert.equal(await height(v1), before_, "two active validators cannot finalize");

  // 6. Validator 3 restarts from its own disk and catches up with the peers.
  startNode("v3", ports[2], 3, [urls[0], urls[1]]);
  await waitFor(() => get(v3, "/status"), "v3 back up");
  const pay3 = await signedTransfer(alice, bob.address, "2", 1);
  assert.equal((await post(v1, "/tx", pay3)).status, 200);
  await waitFor(async () => (await balanceUnits(v3, bob.address)) === "104000000", "payment after restart on v3");
  await waitFor(async () => (await height(v2)) === (await height(v3)), "v2 and v3 at one height");
  assert.equal(await balanceUnits(v2, alice.address), "96000000");
  assert.equal((await get(v1, "/status")).body.tipHash, (await get(v2, "/status")).body.tipHash);

  // 7. Peers cannot be added from the network. A forged header adds nothing, /peers is gone,
  //    and /sync refuses any address that the operator did not configure.
  await fetch(`${v1.url}/status`, { headers: { "x-peer-url": "http://127.0.0.1:1" } });
  assert.ok(!(await get(v1, "/status")).body.peers.includes("http://127.0.0.1:1"));
  assert.equal((await post(v1, "/peers", { url: "http://127.0.0.1:1" })).status, 404);
  const foreignSync = await post(v1, "/sync", { url: "http://127.0.0.1:1" });
  assert.equal(foreignSync.status, 400);
  assert.equal(foreignSync.body.code, "PEER_NOT_ALLOWED");

  // 8. A flood from one address is throttled, and the node recovers once the bucket refills.
  const flood = await Promise.all(
    Array.from({ length: 600 }, () => fetch(`${v1.url}/status`).then((r) => r.status)),
  );
  assert.ok(flood.includes(429), "a burst above the limit is refused");
  await waitFor(async () => (await get(v1, "/status")).status === 200, "rate limit recovers", 10_000);
});
