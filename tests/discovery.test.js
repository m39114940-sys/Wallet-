// Multi-node discovery: three real non-validator nodes over HTTPS with mutual TLS.
// W2 is configured with W1's address only. W3 is in W2's trust list but has no address there.
// W2 must learn W3's address through gossip from W1, and admit W3 only after the challenge-response.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChainNode, createHttpServer } from "../node/node.js";
import { initNetwork } from "../node/tools.js";
import { createNodeIdentity } from "../node/identity.js";
import { createTlsIdentity } from "../node/tls.js";

const CHAIN = "snn-discovery-test";
const ADDRESS = "snn1" + "0".repeat(40);

async function startWatcher(name, genesis, dir) {
  const identity = await createNodeIdentity();
  const tls = createTlsIdentity(`snn-discovery-${name}`);
  return { name, identity, tls, dir: join(dir, name), node: null, server: null, url: null, trust: new Map() };
}

// Trust entries are filled in after every node is listening, because each address is only known then.
function trustEntry(w) {
  return { publicKey: w.identity.publicKey, tlsFingerprint: w.tls.fingerprint, url: null };
}

async function listen(w, genesis, trust) {
  w.node = new ChainNode({
    dataDir: w.dir,
    genesis,
    validator: null,
    tlsIdentity: { key: w.tls.key, cert: w.tls.cert },
    nodeIdentity: w.identity,
    trustedNodes: trust,
    selfUrl: null,
    log: () => {},
  });
  await w.node.init();
  w.server = createHttpServer(w.node, { key: w.tls.key, cert: w.tls.cert });
  await new Promise((resolve) => w.server.listen(0, "127.0.0.1", resolve));
  w.url = `https://127.0.0.1:${w.server.address().port}`;
  w.node.selfUrl = w.url;
}

test("a node learns a trusted peer's address from gossip and admits it only after the challenge-response", async () => {
  const dir = mkdtempSync(join(tmpdir(), "snn-discovery-"));
  const workers = [];
  try {
    const { genesis } = await initNetwork(join(dir, "net"), CHAIN, [ADDRESS]);
    const w1 = await startWatcher("w1", genesis, dir);
    const w2 = await startWatcher("w2", genesis, dir);
    const w3 = await startWatcher("w3", genesis, dir);
    workers.push(w1, w2, w3);

    // Trust lists. Trust entries are shared objects, so addresses can be filled in once they exist.
    const t1 = new Map([[w2.identity.nodeId, trustEntry(w2)], [w3.identity.nodeId, trustEntry(w3)]]);
    const t2 = new Map([[w1.identity.nodeId, trustEntry(w1)], [w3.identity.nodeId, trustEntry(w3)]]);
    const t3 = new Map([[w1.identity.nodeId, trustEntry(w1)], [w2.identity.nodeId, trustEntry(w2)]]);
    await listen(w1, genesis, t1);
    await listen(w2, genesis, t2);
    await listen(w3, genesis, t3);

    // W1 knows both addresses. W2 knows W1 only; W3 is trusted by W2 but its address is unknown to W2.
    t1.get(w2.identity.nodeId).url = w2.url;
    t1.get(w3.identity.nodeId).url = w3.url;
    t2.get(w1.identity.nodeId).url = w1.url;
    t3.get(w1.identity.nodeId).url = w1.url;
    t3.get(w2.identity.nodeId).url = w2.url;
    // (t2's entry for W3 keeps url null on purpose.)

    // Nodes are started without their own address in the peer book; the node must learn to skip itself.
    assert.equal(t2.get(w3.identity.nodeId).url, null, "W2 must not know W3's address before gossip");

    // Round 1 on W1: connects to W2 and W3 and admits both.
    await w1.node.maintainPeers();
    assert.equal(w1.node.peerBook.isActive(w2.url), true);
    assert.equal(w1.node.peerBook.isActive(w3.url), true);

    // Round 1 on W2: connects to W1, then asks W1 for its peers. W3's address arrives as a candidate only.
    await w2.node.maintainPeers();
    assert.equal(w2.node.peerBook.isActive(w1.url), true);
    assert.equal(w2.node.peerBook.isActive(w3.url), false, "gossip alone must not admit a peer");
    assert.ok(w2.node.peerBook.candidateUrls().includes(w3.url), "W3's address is learned as a candidate");
    // W1 reports W2's own address too. It must be dropped at once, not dialled and rejected later.
    assert.equal(w2.node.peerBook.candidateUrls().includes(w2.url), false, "own address is never a candidate");

    // Round 2 on W2: dials the learned candidate. Admission still needs the identity to be trusted.
    await w2.node.maintainPeers();
    assert.equal(w2.node.peerBook.isActive(w3.url), true, "W3 is admitted after the challenge-response");
    assert.equal(w2.node.peerBook.candidateUrls().includes(w3.url), false);

    // Self is never learned as a candidate.
    assert.equal(w2.node.peerBook.candidateUrls().includes(w2.url), false);
    assert.equal(w1.node.peerBook.candidateUrls().includes(w1.url), false);
  } finally {
    for (const w of workers) {
      w.node?.stop();
      await new Promise((resolve) => (w.server ? w.server.close(resolve) : resolve()));
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
