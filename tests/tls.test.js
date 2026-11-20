// TLS identity and pinned requests: a wrong pin stops the request before any body is sent.
import { test } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { createTlsIdentity, peerRequest } from "../node/tls.js";

test("a pinned request succeeds, and a request with a wrong or missing pin never sends its body", async () => {
  const identity = createTlsIdentity("snn-test-pin");
  let requestsReached = 0;
  const server = https.createServer({ key: identity.key, cert: identity.cert }, (req, res) => {
    requestsReached++;
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `https://127.0.0.1:${server.address().port}`;
  try {
    const ok = await peerRequest({ url, path: "/", pins: new Set([identity.fingerprint]) });
    assert.deepEqual(ok.body, { ok: true });
    await assert.rejects(peerRequest({ url, path: "/", pins: new Set(["0".repeat(64)]) }), {
      code: "TLS_PIN_MISMATCH",
    });
    await assert.rejects(peerRequest({ url, path: "/", pins: null }), { code: "TLS_PIN_MISMATCH" });
    assert.equal(requestsReached, 1, "only the pinned request reached the server");
  } finally {
    server.close();
  }
});

test("a plain HTTP peer is refused before anything is sent", async () => {
  await assert.rejects(peerRequest({ url: "http://127.0.0.1:1", path: "/", pins: new Set() }), {
    code: "INSECURE_PEER",
  });
});

test("the fingerprint of a fresh identity is a 64-character hex digest", () => {
  const identity = createTlsIdentity("snn-test-format");
  assert.match(identity.fingerprint, /^[0-9a-f]{64}$/);
});
