// Operator trust list: non-validator nodes that may join the peer set.
// Each entry binds a node identity to its TLS certificate fingerprint. Nothing from the network edits this list.
import { readFileSync } from "node:fs";
import { nodeIdOf } from "./identity.js";
import { normalizeUrl } from "./peerbook.js";

export const MAX_TRUST_ENTRIES = 256;
const HEX64 = /^[0-9a-f]{64}$/;
const HEX_KEY = /^[0-9a-f]{64,128}$/;

export class TrustListError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = "TrustListError";
    this.code = code;
  }
}

// Returns Map nodeId -> { publicKey, tlsFingerprint }. Throws TrustListError on any malformed entry.
export function parseTrustList(entries) {
  if (!Array.isArray(entries)) throw new TrustListError("BAD_LIST", "trust list must be an array");
  if (entries.length > MAX_TRUST_ENTRIES) throw new TrustListError("TOO_LONG", "trust list is too long");
  const map = new Map();
  for (const entry of entries) {
    const { nodeId, publicKey, tlsFingerprint, url = null } = entry ?? {};
    if (typeof publicKey !== "string" || !HEX_KEY.test(publicKey)) throw new TrustListError("BAD_KEY", "public key must be hex");
    if (nodeIdOf(publicKey) !== nodeId) throw new TrustListError("ID_MISMATCH", "node id does not match its public key");
    if (typeof tlsFingerprint !== "string" || !HEX64.test(tlsFingerprint)) {
      throw new TrustListError("BAD_FINGERPRINT", "TLS fingerprint must be 64 lowercase hex characters");
    }
    if (map.has(nodeId)) throw new TrustListError("DUPLICATE", "node id appears twice");
    // The address is optional. When present, the node dials it on its own schedule.
    map.set(nodeId, { publicKey, tlsFingerprint, url: url === null ? null : normalizeUrl(url) });
  }
  return map;
}

export function loadTrustList(path) {
  return parseTrustList(JSON.parse(readFileSync(path, "utf8")));
}
