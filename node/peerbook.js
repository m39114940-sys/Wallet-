// Peer book: keeps learned addresses apart from trusted peers.
//
// Rules (see docs/peer-discovery.md):
// - Addresses learned over the network are CANDIDATES. They are never dialed for consensus,
//   broadcast to, or synced from until admitted.
// - A candidate is ADMITTED only when its node identity is in the operator's trust list
//   (nodeId -> publicKey). Admission happens after a successful challenge-response, done by the caller.
// - Both sets are bounded. A full candidate set drops new addresses instead of evicting old ones,
//   so an attacker cannot flush honest entries by flooding.
// - Addresses must be https URLs of reasonable length. Anything else is rejected.

const MAX_URL_LENGTH = 200;

export class PeerBookError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = "PeerBookError";
    this.code = code;
  }
}

export function normalizeUrl(url) {
  if (typeof url !== "string" || url.length === 0 || url.length > MAX_URL_LENGTH) {
    throw new PeerBookError("BAD_URL", "address must be a string of up to 200 characters");
  }
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new PeerBookError("BAD_URL", "address is not a valid URL");
  }
  if (parsed.protocol !== "https:") throw new PeerBookError("BAD_URL", "address must use https");
  if (parsed.username || parsed.password) throw new PeerBookError("BAD_URL", "address must not contain credentials");
  if (parsed.search || parsed.hash) throw new PeerBookError("BAD_URL", "address must not contain a query or fragment");
  return `https://${parsed.host}${parsed.pathname.replace(/\/+$/, "")}`;
}

export class PeerBook {
  // trusted: Map nodeId -> publicKey (PEM or DER string) from the operator's trust list.
  constructor({ trusted = new Map(), maxCandidates = 64, maxActive = 16, selfUrl = null } = {}) {
    this.trusted = new Map(trusted);
    this.maxCandidates = maxCandidates;
    this.maxActive = maxActive;
    this.selfUrl = selfUrl ? normalizeUrl(selfUrl) : null;
    this.candidates = new Set();
    this.active = new Map(); // url -> nodeId
  }

  // Gossip entry point. Returns how many new candidates were stored.
  learn(urls) {
    if (!Array.isArray(urls)) throw new PeerBookError("BAD_LIST", "peer list must be an array");
    let added = 0;
    for (const raw of urls.slice(0, 100)) {
      let url;
      try {
        url = normalizeUrl(raw);
      } catch {
        continue; // invalid entries are skipped, not fatal
      }
      if (url === this.selfUrl || this.active.has(url) || this.candidates.has(url)) continue;
      if (this.candidates.size >= this.maxCandidates) break;
      this.candidates.add(url);
      added += 1;
    }
    return added;
  }

  // Called by the caller after the challenge-response succeeded for this url.
  admit(url, nodeId) {
    const key = normalizeUrl(url);
    if (!this.trusted.has(nodeId)) throw new PeerBookError("UNTRUSTED_NODE", "node identity is not in the trust list");
    if (!this.active.has(key) && this.active.size >= this.maxActive) {
      throw new PeerBookError("FULL", "active peer set is full");
    }
    this.candidates.delete(key);
    this.active.set(key, nodeId);
    return key;
  }

  normalize(url) {
    return normalizeUrl(url);
  }

  drop(url) {
    this.active.delete(normalizeUrl(url));
  }

  isActive(url) {
    return this.active.has(normalizeUrl(url));
  }

  activeUrls() {
    return [...this.active.keys()];
  }

  candidateUrls() {
    return [...this.candidates];
  }
}
