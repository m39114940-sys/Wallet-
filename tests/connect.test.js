// Dialing a peer: admission requires a successful challenge-response AND an identity from the trust list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ChainNode } from "../node/node.js";
import { createHttpServer } from "../node/node.js";
import { PeerGuard } from "../node/guard.js";
import { Handshake } from "../node/handshake.js";
import { PeerBook } from "../node/peerbook.js";
import { createNodeIdentity } from "../node/identity.js";
import { createTlsIdentity } from "../node/tls.js";

const CHAIN = "snn-connect-test";

async function startServer(activePeers = []) {
  const tls = createTlsIdentity("snn-connect-server");
  const identity = await createNodeIdentity();
  const client = createTlsIdentity("snn-connect-client");
  const peerBook = new PeerBook({ trusted: new Map([["dummy", "k"]]), maxActive: 100 });
  for (const url of activePeers) peerBook.admit(url, "dummy");
  const node = {
    genesis: { chainId: CHAIN },
    nodeIdentity: identity,
    handshake: new Handshake({ chainId: CHAIN, verifierId: identity.nodeId }),
    authenticatedPeers: new Map(),
    pins: new Set([client.fingerprint]),
    peerBook,
    status: () => ({ ok: true }),
    run: async (fn) => fn(),
    guard: new PeerGuard(),
  };
  const server = createHttpServer(node, { key: tls.key, cert: tls.cert });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, identity, tls, url: `https://127.0.0.1:${server.address().port}`, client };
}

// ChainNode.connectPeer only uses these fields, so it runs on a minimal object.
function dialer(identity, client, trusted) {
  return {
    genesis: { chainId: CHAIN },
    nodeIdentity: identity,
    tlsIdentity: { key: client.key, cert: client.cert },
    pins: new Set([...trusted.values()].map((e) => e.tlsFingerprint)),
    peers: new Set(),
    peerBook: new PeerBook({ trusted: new Map([...trusted].map(([id, e]) => [id, e.publicKey])) }),
  };
}

test("a peer in the trust list is admitted after the challenge-response", async () => {
  const { server, identity: serverId, tls, url, client } = await startServer();
  try {
    const me = await createNodeIdentity();
    const trusted = new Map([[serverId.nodeId, { publicKey: serverId.publicKey, tlsFingerprint: tls.fingerprint }]]);
    const d = dialer(me, client, trusted);
    const peerId = await ChainNode.prototype.connectPeer.call(d, url);
    assert.equal(peerId, serverId.nodeId);
    assert.equal(d.peerBook.isActive(url), true);
    assert.ok(d.peers.has(url));
  } finally {
    server.close();
  }
});

test("a peer whose identity is not in the trust list is refused", async () => {
  const { server, tls, url, client } = await startServer();
  try {
    const me = await createNodeIdentity();
    const stranger = await createNodeIdentity();
    // The server's certificate is pinned, but its identity is not in the trust list.
    const trusted = new Map([[stranger.nodeId, { publicKey: stranger.publicKey, tlsFingerprint: tls.fingerprint }]]);
    const d = dialer(me, client, trusted);
    await assert.rejects(ChainNode.prototype.connectPeer.call(d, url), { code: "UNTRUSTED_NODE" });
    assert.equal(d.peerBook.isActive(url), false);
    assert.equal(d.peers.size, 0);
  } finally {
    server.close();
  }
});

test("a trusted identity presenting a different TLS certificate is refused by pinning", async () => {
  const { server, identity: serverId, url, client } = await startServer();
  try {
    const me = await createNodeIdentity();
    const trusted = new Map([[serverId.nodeId, { publicKey: serverId.publicKey, tlsFingerprint: "cd".repeat(32) }]]);
    const d = dialer(me, client, trusted);
    await assert.rejects(ChainNode.prototype.connectPeer.call(d, url));
    assert.equal(d.peerBook.isActive(url), false);
  } finally {
    server.close();
  }
});

test("maintainPeers dials trusted entries that have an address, and skips entries without one", async () => {
  const { server, identity: serverId, tls, url, client } = await startServer();
  try {
    const me = await createNodeIdentity();
    const trusted = new Map([
      [serverId.nodeId, { publicKey: serverId.publicKey, tlsFingerprint: tls.fingerprint, url }],
      ["no-address", { publicKey: serverId.publicKey, tlsFingerprint: tls.fingerprint, url: null }],
    ]);
    const d = dialer(me, client, trusted);
    d.trustedNodes = trusted;
    d.connectPeer = ChainNode.prototype.connectPeer.bind(d);
    await ChainNode.prototype.maintainPeers.call(d);
    assert.equal(d.peerBook.isActive(url), true);
    assert.equal(d.peers.size, 1);
  } finally {
    server.close();
  }
});

test("gossip adds learned candidates, and candidates are admitted only if trusted", async () => {
  const stranger = await startServer();
  const deadUrl = "https://127.0.0.1:1";
  const server = await startServer([stranger.url, deadUrl]); // S knows an untrusted node and a dead address
  const { server: sv, identity: serverId, tls, url, client } = server;
  try {
    const me = await createNodeIdentity();
    const trusted = new Map([[serverId.nodeId, { publicKey: serverId.publicKey, tlsFingerprint: tls.fingerprint }]]);
    const d = dialer(me, client, trusted);
    d.trustedNodes = new Map();
    d.connectPeer = ChainNode.prototype.connectPeer.bind(d);
    d.selfUrl = null;
    // Step 1: dial S (it is trusted, so it is admitted), then gossip pulls its list.
    await d.connectPeer(url);
    const round = Object.assign(d, { pins: new Set([tls.fingerprint]), tlsIdentity: { key: client.key, cert: client.cert } });
    // Round 1 gossips and stores the two learned addresses as candidates.
    await ChainNode.prototype.maintainPeers.call(round);
    assert.equal(d.peerBook.candidateUrls().length, 2);
    // Round 2 tries the candidates: the untrusted node and the dead address are both dropped.
    await ChainNode.prototype.maintainPeers.call(round);
    assert.equal(d.peerBook.isActive(stranger.url), false);
    assert.equal(d.peerBook.isActive(deadUrl), false);
    assert.equal(d.peerBook.candidateUrls().length, 0);
    assert.equal(d.peerBook.isActive(url), true);
  } finally {
    sv.close();
    stranger.server.close();
  }
});
