// SNN network node: persistent chain, mempool, gossip, sync over HTTP, and multi-validator consensus.
// Nothing here trusts a peer: every block, proposal, vote and piece of evidence is verified before use.
//
// Limits (documented in docs/network.md):
// - Plain HTTP, no authentication, no rate limiting. Suitable for local and test networks only.
// - Validator keys are read from local JSON files in plain text. Use an OS or hardware keystore before real use.
// - Proposer order is predictable (no VRF yet), so a known proposer can be targeted.
// - Messages are not retransmitted. Liveness relies on round timeouts and fresh votes.
// - Each node sends the full chain on sync. There is no pruning or snapshot.

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
import https from "node:https";
import { peerRequest, isPinnedSocket, TLS_VERSION_OPTIONS } from "./tls.js";
import { Handshake } from "./handshake.js";
import { RULES_HYBRID, withWork } from "../chain/core.js";
import { decideAdoption, keepsCommittedPrefix } from "../chain/forkchoice.js";
import { PeerGuard } from "./guard.js";
import { peerFingerprintOf } from "./tls.js";

const MAX_AUTHENTICATED_PEERS = 1000;
import { LedgerError } from "../js/ledger.js";
import {
  ChainError,
  applyCommitted,
  buildBlock,
  cloneState,
  evidenceKey,
  genesisBlock,
  genesisState,
  normalizeEvidence,
  normalizeTx,
  replayChain,
  txId,
  verifyEvidence,
  MAX_CLOCK_DRIFT_MS,
} from "../chain/core.js";
import { Consensus } from "../chain/consensus.js";

const MAX_BODY_BYTES = 1_000_000;
const PEER_TIMEOUT_MS = 3000;
const MAX_MEMPOOL = 5000;
const TICK_MS = 50;
const SYNC_COOLDOWN_MS = 2000; // at most one automatic sync per peer in this window
const RATE_PER_SEC = 200; // requests per second refilled per remote address
const RATE_BURST = 400;
const MAX_PAGE = 200; // blocks per request, both when serving and when syncing
const MAX_SYNC_BLOCKS = 100_000;

const byEvidenceKey = (a, b) => (evidenceKey(a) < evidenceKey(b) ? -1 : 1);

export class ChainNode {
  // validator: { publicKey, privateKeyDer } or null. A node without a validator key relays and verifies only.
  constructor({ dataDir, genesis, validator = null, tlsIdentity = null, nodeIdentity = null, selfUrl = null, roundMs = 1000, lossRate = 0, log = () => {} }) {
    this.tlsIdentity = tlsIdentity; // { key, cert } PEM, presented to peers
    this.nodeIdentity = nodeIdentity; // { publicKey, privateKeyDer, nodeId }: Ed25519 identity of this node
    this.handshake = new Handshake({ chainId: genesis.chainId, verifierId: nodeIdentity?.nodeId ?? "none" });
    this.authenticatedPeers = new Map(); // nodeId -> { publicKey, at }: peers that proved their key
    this.lossRate = lossRate; // TESTING ONLY: fraction of outbound peer requests dropped at random
    this.dataDir = dataDir;
    this.genesis = genesis;
    this.validator = validator;
    this.selfUrl = selfUrl;
    this.log = log;
    this.peers = new Set();
    this.allowed = new Set(); // peers named by the operator; nothing learned from the network adds to this
    this.blocks = [];
    this.state = null;
    this.mempool = new Map();
    this.evidence = new Map(); // evidenceKey -> verified evidence, waiting for a block
    this.queue = Promise.resolve();
    this.consensus = new Consensus({ node: this, keys: validator, roundMs });
    this.timer = null;
    this.lastError = null;
    this.syncedAt = new Map(); // peer url -> time of the last automatic sync
    // Trust anchors: the TLS fingerprints of the genesis validators. A peer must present one of these.
    this.pins = new Set(genesis.validators.map((v) => v.tlsFingerprint).filter((f) => f !== null));
  }

  // Automatic syncs (triggered by a message from the future) are rate limited per peer.
  async syncIfDue(url) {
    if (!this.isAllowedPeer(url)) return { adopted: false, skipped: true };
    const last = this.syncedAt.get(url) ?? 0;
    if (Date.now() - last < SYNC_COOLDOWN_MS) return { adopted: false, skipped: true };
    this.syncedAt.set(url, Date.now());
    return this.sync(url);
  }

  // Every state change runs through this queue, so no two handlers interleave across awaits.
  run(fn) {
    const result = this.queue.then(fn);
    this.queue = result.catch(() => {});
    return result;
  }

  start() {
    this.timer = setInterval(() => {
      this.run(() => this.consensus.tick()).catch((err) => {
        // The same error would repeat every tick, so log it only when it changes.
        if (err.message !== this.lastError) this.log(`consensus: ${err.message}`);
        this.lastError = err.message;
      });
    }, TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // ---------- Startup and persistence ----------

  async init() {
    mkdirSync(this.dataDir, { recursive: true });
    const chainPath = join(this.dataDir, "chain.json");
    if (!existsSync(chainPath)) {
      this.blocks = [genesisBlock(this.genesis)];
      this.state = genesisState(this.genesis);
      this.persist();
      return;
    }
    const stored = JSON.parse(readFileSync(chainPath, "utf8"));
    // A stored chain is accepted only if it replays from genesis with valid certificates.
    this.state = await replayChain(stored.blocks, this.genesis);
    this.blocks = stored.blocks;
  }

  persist() {
    const path = join(this.dataDir, "chain.json");
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ blocks: this.blocks }));
    renameSync(tmp, path); // atomic replace on the same filesystem
  }

  get tip() {
    return this.blocks[this.blocks.length - 1];
  }

  status() {
    return {
      chainId: this.genesis.chainId,
      height: this.tip.height,
      tipHash: this.tip.hash,
      validator: this.validator !== null,
      validatorPublicKey: this.validator?.publicKey ?? null,
      round: this.consensus.height === this.tip.height + 1 ? this.consensus.round : null,
      peers: [...this.peers],
      mempool: this.mempool.size,
      evidence: this.evidence.size,
    };
  }

  validatorsInfo() {
    return {
      validators: [...this.state.stakes].map(([publicKey, stake]) => ({
        publicKey,
        stake: stake.toString(),
        jailed: this.state.jailed.has(publicKey),
      })),
    };
  }

  blocksFrom(height, limit = MAX_PAGE) {
    return this.blocks.slice(height, height + Math.min(limit, MAX_PAGE));
  }

  balance(address) {
    return {
      address,
      units: this.state.ledger.balanceOf(address).toString(),
      nonce: this.state.ledger.nextNonce(address),
    };
  }

  // ---------- Peers and gossip ----------

  // Peers come only from the operator's configuration (--peer). Nothing received over the network adds one.
  addPeer(url) {
    if (url === this.selfUrl) return;
    this.allowed.add(url);
    this.peers.add(url);
  }

  isAllowedPeer(url) {
    return this.allowed.has(url);
  }

  // Every peer request is HTTPS and pinned to the validator fingerprints of the genesis configuration.
  async post(peer, path, body, headers = {}) {
    if (this.lossRate > 0 && Math.random() < this.lossRate) return false;
    const res = await peerRequest({
      url: peer,
      method: "POST",
      path,
      body,
      headers: { "x-peer-url": this.selfUrl ?? "", ...headers },
      pins: this.pins,
      identity: this.tlsIdentity,
      timeoutMs: PEER_TIMEOUT_MS,
    });
    return res.status === 200;
  }

  // Failures are ignored on purpose: a dead peer must never stop the local node.
  async broadcast(path, body, exceptUrl = null) {
    await Promise.all(
      [...this.peers]
        .filter((peer) => peer !== exceptUrl)
        .map((peer) => this.post(peer, path, body).catch(() => false)),
    );
  }

  // Fire and forget: the queue never waits for the network.
  gossip(path, body, exceptUrl = null) {
    this.broadcast(path, body, exceptUrl).catch(() => {});
  }

  // ---------- Transactions ----------

  async submitTx(raw) {
    const tx = normalizeTx(raw);
    const id = txId(tx);
    if (this.mempool.has(id)) return { txId: id, status: "known" };
    if (this.mempool.size >= MAX_MEMPOOL) throw new ChainError("MEMPOOL_FULL", "قائمة المعاملات المعلقة ممتلئة.");

    // Full check against the confirmed state. The nonce must be the sender's next confirmed nonce.
    const trial = await cloneState(this.state);
    await trial.ledger.transfer(tx); // throws LedgerError with a specific code if invalid

    this.mempool.set(id, tx);
    this.gossip("/tx", tx);
    return { txId: id, status: "accepted" };
  }

  hasPendingWork() {
    return this.mempool.size > 0 || this.evidence.size > 0;
  }

  // Builds the next block from the mempool, keeping only transactions that apply in order.
  async assemble(evidence) {
    const trial = await cloneState(this.state);
    const included = [];
    for (const tx of this.mempool.values()) {
      try {
        await trial.ledger.transfer(tx);
        included.push(tx);
      } catch {
        // Invalid after earlier transactions in this block. It is pruned after the commit.
      }
    }
    const block = buildBlock({
      height: this.tip.height + 1,
      timestamp: Math.max(Date.now(), this.tip.timestamp + 1), // milliseconds, strictly increasing
      prevHash: this.tip.hash,
      txs: included,
      evidence,
    });
    // Under hybrid rules every block carries proof of work. Mining happens here, on the node that proposes.
    return this.genesis.rules === RULES_HYBRID ? withWork(block, this.genesis, this.tip, this.blocks) : block;
  }

  // ---------- Evidence ----------

  // Evidence that can be included in a block at `height`: one per validator, and only while still active.
  async pendingEvidence(height) {
    const chosen = [];
    const seen = new Set();
    for (const ev of [...this.evidence.values()].sort(byEvidenceKey)) {
      if (seen.has(ev.validator) || ev.height >= height) continue;
      try {
        await verifyEvidence(ev, this.genesis.chainId, this.state);
      } catch {
        continue;
      }
      seen.add(ev.validator);
      chosen.push(ev);
    }
    return chosen;
  }

  async receiveEvidence(raw, fromUrl = null) {
    const ev = normalizeEvidence(raw);
    const key = evidenceKey(ev);
    if (this.evidence.has(key)) return { status: "known" };
    if (ev.height > this.tip.height + 1) throw new ChainError("BAD_EVIDENCE", "الدليل يخص ارتفاعاً مستقبلياً.");
    await verifyEvidence(ev, this.genesis.chainId, this.state);
    this.evidence.set(key, ev);
    this.gossip("/evidence", ev, fromUrl);
    return { status: "accepted" };
  }

  // ---------- Consensus messages from peers ----------

  async receiveConsensus(kind, payload, fromUrl) {
    if (kind === "proposal") {
      const result = await this.consensus.onProposal(payload);
      if (result === "behind" && fromUrl) await this.syncIfDue(fromUrl).catch(() => null);
      if (result === "new") this.gossip("/consensus", { kind, payload }, fromUrl);
      return { result };
    }
    if (kind === "vote") {
      const result = await this.consensus.onVote(payload);
      if (result === "behind" && fromUrl) await this.syncIfDue(fromUrl).catch(() => null);
      if (result === "new") this.gossip("/consensus", { kind, payload }, fromUrl);
      return { result };
    }
    throw new ChainError("BAD_KIND", "نوع رسالة الإجماع غير معروف.");
  }

  // Called by the consensus engine when a block gets a quorum of precommits.
  async commitBlock(block, state) {
    this.blocks.push(block);
    this.state = state;
    for (const tx of block.txs) this.mempool.delete(txId(tx));
    for (const ev of block.evidence) this.evidence.delete(evidenceKey(ev));
    for (const [key, ev] of this.evidence) {
      if (state.jailed.has(ev.validator)) this.evidence.delete(key);
    }
    this.persist();
    await this.pruneMempool();
  }

  // Drops mempool entries that no longer apply after a block changed the state.
  async pruneMempool() {
    const trial = await cloneState(this.state);
    for (const [id, tx] of [...this.mempool]) {
      try {
        await trial.ledger.transfer(tx);
      } catch {
        this.mempool.delete(id);
      }
    }
  }

  // ---------- Certified blocks from peers ----------

  // Accepts a certified block that extends our tip. Certificates are checked by applyCommitted.
  async receiveBlock(block, fromUrl) {
    if (block === null || typeof block !== "object" || typeof block.height !== "number") {
      throw new ChainError("BAD_BLOCK", "شكل الكتلة غير صالح.");
    }
    if (block.height <= this.tip.height) {
      if (this.blocks[block.height].hash === block.hash) return { accepted: false, reason: "known" };
      if (fromUrl) await this.sync(fromUrl).catch(() => null);
      return { accepted: false, reason: "conflicting block, sync requested" };
    }
    if (block.height > this.tip.height + 1) {
      if (fromUrl) await this.syncIfDue(fromUrl).catch(() => null);
      return { accepted: false, reason: "behind, synced" };
    }
    if (!(block.timestamp <= Date.now() + MAX_CLOCK_DRIFT_MS)) {
      throw new ChainError("BAD_TIMESTAMP", "الكتلة مختومة بوقت أبعد من الساعة المسموحة.");
    }
    const state = await applyCommitted(this.state, block, this.tip, this.genesis, this.blocks);
    await this.commitBlock(block, state);
    this.gossip("/block", block, fromUrl);
    return { accepted: true, height: block.height };
  }

  // Downloads a peer's full chain and adopts it only if it replays from genesis and is longer than ours.
  async sync(url) {
    if (!this.isAllowedPeer(url)) throw new ChainError("PEER_NOT_ALLOWED", "هذا العنوان ليس نظيراً معتمداً.");
    const blocks = [];
    for (let from = 0; ; ) {
      const res = await peerRequest({
        url,
        path: `/blocks?from=${from}&limit=${MAX_PAGE}`,
        pins: this.pins,
        identity: this.tlsIdentity,
        timeoutMs: 10_000,
      });
      if (res.status !== 200) throw new ChainError("SYNC_FAILED", `فشل الاتصال بـ ${url}`);
      const page = res.body;
      if (!Array.isArray(page) || page.length > MAX_PAGE) throw new ChainError("SYNC_FAILED", "استجابة المزامنة غير صالحة.");
      blocks.push(...page);
      if (blocks.length > MAX_SYNC_BLOCKS) throw new ChainError("SYNC_FAILED", "السلسلة المعروضة أكبر من الحد المسموح.");
      if (page.length < MAX_PAGE) break;
      from += page.length;
    }
    if (!Array.isArray(blocks) || blocks.length === 0) return { adopted: false, height: this.tip.height };
    // Finality: a chain that rewrites a committed block is refused before any other check.
    if (!keepsCommittedPrefix(this.blocks, blocks)) {
      throw new ChainError("REORG_BELOW_COMMITTED", "السلسلة المعروضة تعيد كتابة كتل معتمدة عندنا.");
    }
    // Cheap refusal under Testnet rules: a candidate that is not longer cannot win, so it is not replayed.
    if (this.genesis.rules !== RULES_HYBRID && blocks.length <= this.blocks.length) {
      return { adopted: false, height: this.tip.height };
    }
    const state = await replayChain(blocks, this.genesis);
    // Preference is decided only after the whole candidate has been validated.
    if (!decideAdoption(this.blocks, blocks, this.genesis).adopt) return { adopted: false, height: this.tip.height };
    this.blocks = blocks;
    this.state = state;
    for (const [key, ev] of this.evidence) {
      if (state.jailed.has(ev.validator)) this.evidence.delete(key);
    }
    this.persist();
    await this.pruneMempool();
    return { adopted: true, height: this.tip.height };
  }

  async syncFromPeers() {
    for (const peer of this.peers) {
      await this.sync(peer).catch(() => null);
    }
  }
}

// ---------- HTTP interface ----------

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new ChainError("TOO_LARGE", "الطلب أكبر من الحد المسموح.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8") || "null");
  } catch {
    throw new ChainError("BAD_JSON", "الطلب ليس JSON صالحاً.");
  }
}

function requirePeerUrl(body) {
  if (typeof body?.url !== "string" || !/^https?:\/\//.test(body.url)) {
    throw new ChainError("BAD_PEER", "عنوان النظير غير صالح.");
  }
  return body.url;
}

// Token bucket per remote address. The address comes from the socket, not from a header a peer can set.
function makeLimiter() {
  const buckets = new Map();
  return (key) => {
    const now = Date.now();
    if (buckets.size > 10_000) {
      for (const [k, v] of buckets) if (now - v.at > 60_000) buckets.delete(k);
    }
    const b = buckets.get(key) ?? { tokens: RATE_BURST, at: now };
    b.tokens = Math.min(RATE_BURST, b.tokens + ((now - b.at) * RATE_PER_SEC) / 1000);
    b.at = now;
    buckets.set(key, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

// tlsOptions: { key, cert } PEM. Without it the server is plain HTTP, which only tests should use.
export function createHttpServer(node, tlsOptions = null) {
  const allow = makeLimiter();
  const guard = node.guard ?? (node.guard = new PeerGuard());
  const handler = async (req, res) => {
    const fingerprint = peerFingerprintOf(req.socket);
    // A banned pinned peer gets no answer at all.
    if (fingerprint !== null && guard.isBanned(fingerprint)) {
      req.socket.destroy();
      return;
    }
    try {
      if (!allow(req.socket.remoteAddress ?? "unknown")) {
        return sendJson(res, 429, { error: "rate limited", code: "RATE_LIMITED" });
      }
      const url = new URL(req.url, "http://localhost");
      const { pathname } = url;
      // Sent by peers, used only to skip them when re-gossiping. It never adds a peer.
      const fromUrl = req.headers["x-peer-url"] || null;

      if (req.method === "GET" && pathname === "/status") return sendJson(res, 200, node.status());
      if (req.method === "GET" && pathname === "/identity") {
        if (!node.nodeIdentity) return sendJson(res, 404, { error: "no identity", code: "NO_IDENTITY" });
        return sendJson(res, 200, { chainId: node.genesis.chainId, nodeId: node.nodeIdentity.nodeId, publicKey: node.nodeIdentity.publicKey });
      }
      if (req.method === "GET" && pathname === "/challenge") {
        if (!node.nodeIdentity) return sendJson(res, 404, { error: "no identity", code: "NO_IDENTITY" });
        return sendJson(res, 200, node.handshake.challenge());
      }
      if (req.method === "POST" && pathname === "/hello") {
        if (!node.nodeIdentity) return sendJson(res, 404, { error: "no identity", code: "NO_IDENTITY" });
        const peer = await node.handshake.verify(await readJson(req));
        if (!node.authenticatedPeers.has(peer.nodeId) && node.authenticatedPeers.size >= MAX_AUTHENTICATED_PEERS) {
          node.authenticatedPeers.delete(node.authenticatedPeers.keys().next().value);
        }
        node.authenticatedPeers.set(peer.nodeId, { publicKey: peer.publicKey, at: Date.now() });
        return sendJson(res, 200, { authenticated: peer.nodeId });
      }
      if (req.method === "GET" && pathname === "/validators") return sendJson(res, 200, node.validatorsInfo());
      if (req.method === "GET" && pathname === "/blocks") {
        const from = Number(url.searchParams.get("from") ?? 0);
        const limit = Number(url.searchParams.get("limit") ?? MAX_PAGE);
        return sendJson(res, 200, node.blocksFrom(Number.isInteger(from) && from >= 0 ? from : 0, limit));
      }
      if (req.method === "GET" && pathname === "/balance") {
        return sendJson(res, 200, node.balance(url.searchParams.get("address") ?? ""));
      }
      if (req.method === "POST" && pathname === "/tx") {
        const body = await readJson(req);
        return sendJson(res, 200, await node.run(() => node.submitTx(body)));
      }
      if (req.method === "POST" && pathname === "/block") {
        const body = await readJson(req);
        return sendJson(res, 200, await node.run(() => node.receiveBlock(body, fromUrl)));
      }
      if (req.method === "POST" && pathname === "/consensus") {
        const body = await readJson(req);
        return sendJson(res, 200, await node.run(() => node.receiveConsensus(body?.kind, body?.payload, fromUrl)));
      }
      if (req.method === "POST" && pathname === "/evidence") {
        const body = await readJson(req);
        return sendJson(res, 200, await node.run(() => node.receiveEvidence(body, fromUrl)));
      }
      if (req.method === "POST" && pathname === "/sync") {
        const body = await readJson(req);
        const peer = requirePeerUrl(body);
        return sendJson(res, 200, await node.run(() => node.sync(peer)));
      }
      return sendJson(res, 404, { error: "not found" });
    } catch (err) {
      const known = err instanceof LedgerError || err instanceof ChainError;
      if (known && fingerprint !== null) guard.recordBad(fingerprint, err.code);
      return sendJson(res, known ? 400 : 500, {
        error: known ? err.message : "internal error",
        code: known ? err.code : "INTERNAL",
      });
    }
  };
  if (!tlsOptions) return http.createServer(handler);
  // Mutual TLS: the server asks for a client certificate, and drops any connection whose
  // certificate fingerprint is not a validator pin, before any HTTP bytes are parsed.
  const server = https.createServer(
    { ...tlsOptions, ...TLS_VERSION_OPTIONS, requestCert: true, rejectUnauthorized: false },
    handler,
  );
  server.prependListener("secureConnection", (socket) => {
    if (!isPinnedSocket(socket, node.pins)) socket.destroy();
  });
  return server;
}
