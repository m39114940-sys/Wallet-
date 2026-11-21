// Peer guard: counts invalid messages per pinned peer identity and bans a peer that keeps sending them.
// Only errors that an honest validator cannot produce by accident are counted (bad signatures, bad hashes,
// bad certificates, bad work). Identity is the TLS client certificate fingerprint, which is pinned, so a
// ban cannot be dodged by changing an address, and cannot be triggered by a forged header.

export const COUNTED_CODES = new Set([
  "BAD_SIGNATURE", "BAD_CERTIFICATE", "BAD_HASH", "BAD_MERKLE", "BAD_EVIDENCE_ROOT",
  "POW_INVALID", "POW_MISSING", "POW_BAD_TARGET", "POW_WRONG_CHAIN", "REORG_BELOW_COMMITTED",
]);

export class PeerGuard {
  constructor({ threshold = 50, windowMs = 60_000, banMs = 300_000, now = () => Date.now() } = {}) {
    this.threshold = threshold;
    this.windowMs = windowMs;
    this.banMs = banMs;
    this.now = now;
    this.records = new Map(); // fingerprint -> { count, windowStart, bannedUntil }
  }

  isBanned(fingerprint) {
    const r = this.records.get(fingerprint);
    return r !== undefined && r.bannedUntil > this.now();
  }

  // Returns true if this report caused a ban.
  recordBad(fingerprint, code) {
    if (!COUNTED_CODES.has(code)) return false;
    const t = this.now();
    let r = this.records.get(fingerprint);
    if (r === undefined || t - r.windowStart > this.windowMs) {
      r = { count: 0, windowStart: t, bannedUntil: r?.bannedUntil ?? 0 };
      this.records.set(fingerprint, r);
    }
    r.count += 1;
    if (r.count >= this.threshold) {
      r.bannedUntil = t + this.banMs;
      r.count = 0;
      return true;
    }
    return false;
  }
}
