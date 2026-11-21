// Peer guard: repeated invalid messages from a pinned peer lead to a ban, which is enforced at the socket.
import { test } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { PeerGuard } from "../node/guard.js";
import { createHttpServer } from "../node/node.js";
import { createTlsIdentity, peerRequest } from "../node/tls.js";
import { ChainError } from "../chain/core.js";

test("a peer is banned after the threshold within the window, and unbanned after the ban expires", () => {
  let t = 0;
  const g = new PeerGuard({ threshold: 3, windowMs: 1000, banMs: 5000, now: () => t });
  assert.equal(g.recordBad("p", "BAD_HASH"), false);
  assert.equal(g.recordBad("p", "BAD_HASH"), false);
  assert.equal(g.recordBad("p", "BAD_HASH"), true);
  assert.equal(g.isBanned("p"), true);
  t = 5000;
  assert.equal(g.isBanned("p"), false);
});

test("reports spread over longer than the window do not add up to a ban", () => {
  let t = 0;
  const g = new PeerGuard({ threshold: 3, windowMs: 1000, banMs: 5000, now: () => t });
  g.recordBad("p", "BAD_HASH");
  g.recordBad("p", "BAD_HASH");
  t = 2000;
  assert.equal(g.recordBad("p", "BAD_HASH"), false);
  assert.equal(g.isBanned("p"), false);
});

test("errors an honest peer can produce by accident are not counted", () => {
  const g = new PeerGuard({ threshold: 1 });
  assert.equal(g.recordBad("p", "BAD_TIMESTAMP"), false);
  assert.equal(g.recordBad("p", "DUPLICATE"), false);
  assert.equal(g.isBanned("p"), false);
});

test("a banned pinned peer is cut off at the socket, and other peers are still answered", async () => {
  const serverId = createTlsIdentity("snn-guard-server");
  const badClient = createTlsIdentity("snn-guard-bad");
  const goodClient = createTlsIdentity("snn-guard-good");
  let received = 0;
  const node = {
    genesis: { chainId: "snn-guard" },
    pins: new Set([badClient.fingerprint, goodClient.fingerprint]),
    status: () => ({ ok: true }),
    run: async (fn) => fn(),
    receiveBlock: async () => {
      received++;
      throw new ChainError("BAD_HASH", "bad block");
    },
    guard: new PeerGuard({ threshold: 3, banMs: 60_000 }),
  };
  const server = createHttpServer(node, { key: serverId.key, cert: serverId.cert });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `https://127.0.0.1:${server.address().port}`;
  const pins = new Set([serverId.fingerprint]);
  const bad = { key: badClient.key, cert: badClient.cert };
  try {
    for (let i = 0; i < 3; i++) {
      const r = await peerRequest({ url, method: "POST", path: "/block", body: {}, pins, identity: bad });
      assert.equal(r.status, 400);
      assert.equal(r.body.code, "BAD_HASH");
    }
    const before = received;
    await assert.rejects(peerRequest({ url, method: "POST", path: "/block", body: {}, pins, identity: bad }));
    assert.equal(received, before, "the banned peer's request never reaches the handler");

    // An honest peer on the same server is still answered.
    const ok = await peerRequest({ url, path: "/status", pins, identity: { key: goodClient.key, cert: goodClient.cert } });
    assert.equal(ok.status, 200);
  } finally {
    server.close();
  }
});
