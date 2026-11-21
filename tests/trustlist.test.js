// Operator trust list: entries bind a node identity to its TLS fingerprint and are validated strictly.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTrustList, TrustListError, MAX_TRUST_ENTRIES } from "../node/trustlist.js";
import { createNodeIdentity } from "../node/identity.js";

const FP = "ab".repeat(32);

test("a well-formed entry is accepted and keyed by node id", async () => {
  const id = await createNodeIdentity();
  const map = parseTrustList([{ nodeId: id.nodeId, publicKey: id.publicKey, tlsFingerprint: FP }]);
  assert.deepEqual(map.get(id.nodeId), { publicKey: id.publicKey, tlsFingerprint: FP, url: null });
});

test("an optional https address is kept normalised, and a non-https one is refused", async () => {
  const id = await createNodeIdentity();
  const map = parseTrustList([{ nodeId: id.nodeId, publicKey: id.publicKey, tlsFingerprint: FP, url: "https://Peer.example:8443/" }]);
  assert.equal(map.get(id.nodeId).url, "https://peer.example:8443");
  assert.throws(() => parseTrustList([{ nodeId: id.nodeId, publicKey: id.publicKey, tlsFingerprint: FP, url: "http://x.example" }]), { code: "BAD_URL" });
});

test("a node id that does not match its public key is refused", async () => {
  const id = await createNodeIdentity();
  const other = await createNodeIdentity();
  assert.throws(
    () => parseTrustList([{ nodeId: other.nodeId, publicKey: id.publicKey, tlsFingerprint: FP }]),
    { code: "ID_MISMATCH" },
  );
});

test("malformed fingerprints and keys are refused", async () => {
  const id = await createNodeIdentity();
  assert.throws(() => parseTrustList([{ nodeId: id.nodeId, publicKey: id.publicKey, tlsFingerprint: "AB".repeat(32) }]), { code: "BAD_FINGERPRINT" });
  assert.throws(() => parseTrustList([{ nodeId: id.nodeId, publicKey: "xyz", tlsFingerprint: FP }]), { code: "BAD_KEY" });
});

test("duplicate entries and oversized lists are refused", async () => {
  const id = await createNodeIdentity();
  const entry = { nodeId: id.nodeId, publicKey: id.publicKey, tlsFingerprint: FP };
  assert.throws(() => parseTrustList([entry, entry]), { code: "DUPLICATE" });
  assert.throws(() => parseTrustList(new Array(MAX_TRUST_ENTRIES + 1).fill(entry)), { code: "TOO_LONG" });
  assert.throws(() => parseTrustList({}), TrustListError);
});
