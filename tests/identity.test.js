// Node identity and challenge-response: identity creation and sealing, forged and replayed proofs,
// expired nonces, wrong verifier or chain, and the full exchange over pinned HTTPS.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNodeIdentity, loadNodeIdentity, nodeIdOf, saveNodeIdentity, signHello } from "../node/identity.js";
import { Handshake, introduce } from "../node/handshake.js";
import { createHttpServer } from "../node/node.js";
import { createTlsIdentity } from "../node/tls.js";
import { signText } from "../chain/crypto.js";

const CHAIN = "snn-identity-test";
const PASS = "identity-test-passphrase";

test("a node ID is the digest of its public key, and differs for different keys", async () => {
  const a = await createNodeIdentity();
  const b = await createNodeIdentity();
  assert.equal(a.nodeId, nodeIdOf(a.publicKey));
  assert.match(a.nodeId, /^[0-9a-f]{64}$/);
  assert.notEqual(a.nodeId, b.nodeId);
});

test("the identity file seals the private key and loads back with the right passphrase only", async () => {
  const dir = mkdtempSync(join(tmpdir(), "snn-id-"));
  try {
    const id = await createNodeIdentity();
    const path = join(dir, "identity.json");
    saveNodeIdentity(path, id, PASS);
    const text = readFileSync(path, "utf8");
    assert.equal(text.includes(id.privateKeyDer), false, "private key must not appear in the file");
    const loaded = loadNodeIdentity(path, PASS);
    assert.equal(loaded.nodeId, id.nodeId);
    assert.equal(loaded.privateKeyDer, id.privateKeyDer);
    assert.throws(() => loadNodeIdentity(path, "wrong passphrase"), { code: "BAD_PASSPHRASE" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an identity file whose node ID does not match its key is refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "snn-id-"));
  try {
    const id = await createNodeIdentity();
    const path = join(dir, "identity.json");
    saveNodeIdentity(path, id, PASS);
    const file = JSON.parse(readFileSync(path, "utf8"));
    file.nodeId = "ab".repeat(32);
    writeFileSync(path, JSON.stringify(file));
    // The sealed label binds the public key, not the node ID, so the key still opens; the ID check then refuses.
    assert.throws(() => loadNodeIdentity(path, PASS), { code: "BAD_IDENTITY" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function proofFor(id, verifier, chainId, nonce) {
  return signHello(id, { chainId, verifierId: verifier, nonce });
}

test("a valid proof is accepted once", async () => {
  const verifier = await createNodeIdentity();
  const prover = await createNodeIdentity();
  const hs = new Handshake({ chainId: CHAIN, verifierId: verifier.nodeId });
  const { nonce } = hs.challenge();
  const signature = await proofFor(prover, verifier.nodeId, CHAIN, nonce);
  const body = { nodeId: prover.nodeId, publicKey: prover.publicKey, nonce, signature };
  assert.deepEqual(await hs.verify(body), { nodeId: prover.nodeId, publicKey: prover.publicKey });
  await assert.rejects(hs.verify(body), { code: "NONCE_UNKNOWN" }, "replaying the same proof fails");
});

test("forged signatures are rejected", async () => {
  const verifier = await createNodeIdentity();
  const prover = await createNodeIdentity();
  const impostor = await createNodeIdentity();
  const hs = new Handshake({ chainId: CHAIN, verifierId: verifier.nodeId });
  // Each case uses its own nonce, because a nonce is consumed by the first attempt.

  // Claims the prover's ID with the impostor's key: the digest check refuses it.
  const c1 = hs.challenge().nonce;
  const sig1 = await proofFor(impostor, verifier.nodeId, CHAIN, c1);
  await assert.rejects(hs.verify({ nodeId: prover.nodeId, publicKey: impostor.publicKey, nonce: c1, signature: sig1 }), {
    code: "ID_MISMATCH",
  });

  // Claims the prover's own ID and key, but the signature was made by the impostor.
  const c2 = hs.challenge().nonce;
  const sig2 = await proofFor(impostor, verifier.nodeId, CHAIN, c2);
  await assert.rejects(hs.verify({ nodeId: prover.nodeId, publicKey: prover.publicKey, nonce: c2, signature: sig2 }), {
    code: "BAD_SIGNATURE",
  });

  // A signature with one byte changed, for the impostor's own ID and key.
  const c3 = hs.challenge().nonce;
  const good = await proofFor(impostor, verifier.nodeId, CHAIN, c3);
  const bad = good.replace(/^./, (c) => (c === "0" ? "1" : "0"));
  await assert.rejects(hs.verify({ nodeId: impostor.nodeId, publicKey: impostor.publicKey, nonce: c3, signature: bad }), {
    code: "BAD_SIGNATURE",
  });
});

test("a proof is bound to its verifier, chain and nonce, so it cannot be replayed elsewhere", async () => {
  const verifierA = await createNodeIdentity();
  const verifierB = await createNodeIdentity();
  const prover = await createNodeIdentity();
  const hsA = new Handshake({ chainId: CHAIN, verifierId: verifierA.nodeId });
  const hsB = new Handshake({ chainId: CHAIN, verifierId: verifierB.nodeId });
  const { nonce: nA } = hsA.challenge();
  const { nonce: nB } = hsB.challenge();
  // A proof made for verifier A, presented to verifier B with B's nonce.
  const forA = await proofFor(prover, verifierA.nodeId, CHAIN, nA);
  await assert.rejects(hsB.verify({ nodeId: prover.nodeId, publicKey: prover.publicKey, nonce: nB, signature: forA }), {
    code: "BAD_SIGNATURE",
  });
  // A proof made for chain X, presented on chain Y with the same verifier and nonce value.
  const hsOther = new Handshake({ chainId: "snn-other", verifierId: verifierA.nodeId });
  const { nonce: nO } = hsOther.challenge();
  const forChainX = await proofFor(prover, verifierA.nodeId, CHAIN, nO);
  await assert.rejects(hsOther.verify({ nodeId: prover.nodeId, publicKey: prover.publicKey, nonce: nO, signature: forChainX }), {
    code: "BAD_SIGNATURE",
  });
});

test("expired nonces are refused, and pending nonces are capped", async () => {
  const verifier = await createNodeIdentity();
  const prover = await createNodeIdentity();
  let t = 1_000;
  const hs = new Handshake({ chainId: CHAIN, verifierId: verifier.nodeId, ttlMs: 5_000, now: () => t, maxPending: 2 });
  const { nonce } = hs.challenge();
  const signature = await proofFor(prover, verifier.nodeId, CHAIN, nonce);
  t += 5_000;
  await assert.rejects(hs.verify({ nodeId: prover.nodeId, publicKey: prover.publicKey, nonce, signature }), { code: "NONCE_EXPIRED" });

  hs.challenge();
  hs.challenge();
  assert.throws(() => hs.challenge(), { code: "CHALLENGE_LIMIT" });
});

test("malformed proof fields are refused before any checking", async () => {
  const verifier = await createNodeIdentity();
  const hs = new Handshake({ chainId: CHAIN, verifierId: verifier.nodeId });
  await assert.rejects(hs.verify({ nodeId: "xyz", publicKey: "00", nonce: "00", signature: "00" }), { code: "BAD_HELLO" });
  await assert.rejects(hs.verify(null), { code: "BAD_HELLO" });
});

test("full exchange over pinned HTTPS: a node proves itself to another node and is recorded", async () => {
  const serverId = await createNodeIdentity();
  const clientId = await createNodeIdentity();
  const serverTls = createTlsIdentity("snn-id-server");
  const clientTls = createTlsIdentity("snn-id-client");
  const node = {
    genesis: { chainId: CHAIN },
    pins: new Set([clientTls.fingerprint]),
    status: () => ({}),
    nodeIdentity: serverId,
    handshake: new Handshake({ chainId: CHAIN, verifierId: serverId.nodeId }),
    authenticatedPeers: new Map(),
  };
  const server = createHttpServer(node, { key: serverTls.key, cert: serverTls.cert });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `https://127.0.0.1:${server.address().port}`;
  try {
    const { peerId } = await introduce({
      url,
      identity: clientId,
      chainId: CHAIN,
      pins: new Set([serverTls.fingerprint]),
      tlsIdentity: { key: clientTls.key, cert: clientTls.cert },
    });
    assert.equal(peerId, serverId.nodeId);
    assert.ok(node.authenticatedPeers.has(clientId.nodeId), "the server recorded the authenticated client");
  } finally {
    server.close();
  }
});

test("a peer on another chain is refused during introduction", async () => {
  const serverId = await createNodeIdentity();
  const clientId = await createNodeIdentity();
  const serverTls = createTlsIdentity("snn-id-server2");
  const clientTls = createTlsIdentity("snn-id-client2");
  const node = {
    genesis: { chainId: "snn-mainnet-other" },
    pins: new Set([clientTls.fingerprint]),
    status: () => ({}),
    nodeIdentity: serverId,
    handshake: new Handshake({ chainId: "snn-mainnet-other", verifierId: serverId.nodeId }),
    authenticatedPeers: new Map(),
  };
  const server = createHttpServer(node, { key: serverTls.key, cert: serverTls.cert });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(
      introduce({
        url: `https://127.0.0.1:${server.address().port}`,
        identity: clientId,
        chainId: CHAIN,
        pins: new Set([serverTls.fingerprint]),
        tlsIdentity: { key: clientTls.key, cert: clientTls.cert },
      }),
      { code: "WRONG_CHAIN" },
    );
  } finally {
    server.close();
  }
});
