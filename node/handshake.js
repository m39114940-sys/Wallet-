// Challenge-response proof of node identity. A verifier issues a single-use nonce; the prover signs a
// message that binds the chain, the verifier's ID, the nonce and its own ID, and returns it. The
// verifier accepts only if the signature checks against the key whose digest is the claimed ID.
// Nonces expire quickly and are consumed on first use, whether the proof is valid or not.

import { randomBytes } from "node:crypto";
import { verifyText } from "../chain/crypto.js";
import { ChainError } from "../chain/core.js";
import { helloMessage, nodeIdOf, signHello } from "./identity.js";
import { peerRequest } from "./tls.js";

const HEX64 = /^[0-9a-f]{64}$/;
const HEX128 = /^[0-9a-f]{128}$/;

export class Handshake {
  constructor({ chainId, verifierId, ttlMs = 30_000, maxPending = 10_000, now = () => Date.now(), random = () => randomBytes(32).toString("hex") }) {
    this.chainId = chainId;
    this.verifierId = verifierId;
    this.ttlMs = ttlMs;
    this.maxPending = maxPending;
    this.now = now;
    this.random = random;
    this.pending = new Map(); // nonce -> expiry time
  }

  prune() {
    const t = this.now();
    for (const [nonce, expires] of this.pending) if (expires <= t) this.pending.delete(nonce);
  }

  challenge() {
    this.prune();
    if (this.pending.size >= this.maxPending) throw new ChainError("CHALLENGE_LIMIT", "عدد التحديات المعلقة بلغ الحد.");
    const nonce = this.random();
    this.pending.set(nonce, this.now() + this.ttlMs);
    return { nonce, expiresInMs: this.ttlMs };
  }

  // Returns { nodeId, publicKey } for a valid proof, otherwise throws a ChainError.
  async verify(body) {
    const { nodeId, publicKey, nonce, signature } = body ?? {};
    if (typeof nodeId !== "string" || !HEX64.test(nodeId)) throw new ChainError("BAD_HELLO", "معرف العقدة غير صالح.");
    if (typeof publicKey !== "string" || !HEX64.test(publicKey)) throw new ChainError("BAD_HELLO", "المفتاح العام غير صالح.");
    if (typeof nonce !== "string" || !HEX64.test(nonce)) throw new ChainError("BAD_HELLO", "التحدي غير صالح.");
    if (typeof signature !== "string" || !HEX128.test(signature)) throw new ChainError("BAD_HELLO", "التوقيع غير صالح.");

    // Consume the nonce before anything else, so one nonce can never be tried twice.
    const expires = this.pending.get(nonce);
    this.pending.delete(nonce);
    if (expires === undefined) throw new ChainError("NONCE_UNKNOWN", "التحدي غير معروف أو سبق استخدامه.");
    if (expires <= this.now()) throw new ChainError("NONCE_EXPIRED", "انتهت صلاحية التحدي.");

    if (nodeIdOf(publicKey) !== nodeId) throw new ChainError("ID_MISMATCH", "معرف العقدة لا يطابق المفتاح العام.");
    const ok = await verifyText(publicKey, helloMessage({ chainId: this.chainId, verifierId: this.verifierId, nonce, nodeId }), signature);
    if (!ok) throw new ChainError("BAD_SIGNATURE", "توقيع الإثبات غير صحيح.");
    return { nodeId, publicKey };
  }
}

// Client side: proves our identity to a peer. Checks that the peer runs the same chain and that its
// claimed ID is the digest of the key it reports, before sending our proof.
export async function introduce({ url, identity, chainId, pins, tlsIdentity = null }) {
  const info = await peerRequest({ url, path: "/identity", pins, identity: tlsIdentity });
  if (info.status !== 200 || info.body?.chainId !== chainId) throw new ChainError("WRONG_CHAIN", "النظير يعمل على سلسلة أخرى.");
  if (nodeIdOf(info.body.publicKey) !== info.body.nodeId) throw new ChainError("ID_MISMATCH", "هوية النظير لا تطابق مفتاحه.");
  const verifierId = info.body.nodeId;

  const challenge = await peerRequest({ url, path: "/challenge", pins, identity: tlsIdentity });
  if (challenge.status !== 200) throw new ChainError("CHALLENGE_FAILED", "تعذر الحصول على تحدٍّ من النظير.");
  const signature = await signHello(identity, { chainId, verifierId, nonce: challenge.body.nonce });
  const res = await peerRequest({
    url,
    method: "POST",
    path: "/hello",
    body: { nodeId: identity.nodeId, publicKey: identity.publicKey, nonce: challenge.body.nonce, signature },
    pins,
    identity: tlsIdentity,
  });
  if (res.status !== 200 || res.body?.authenticated !== identity.nodeId) throw new ChainError("HELLO_REJECTED", "رفض النظير الإثبات.");
  return { peerId: verifierId };
}
