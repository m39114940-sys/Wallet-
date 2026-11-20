// SNN network node (Phase 3 basics): persistent chain, mempool, gossip, and sync over HTTP.
// Nothing here trusts a peer: every block and transaction is validated before it is accepted.
//
// Limits of this step (documented in docs/network.md):
// - One designated producer creates blocks. This is temporary; Phase 4 replaces it with multi-validator consensus.
// - Plain HTTP, no authentication, no rate limiting. Suitable for local and test networks only.
// - The producer's private key is read from a local file. Use a hardware or OS keystore before any real use.

import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import http from "node:http";
import { LedgerError } from "../js/ledger.js";
import {
  ChainError,
  applyBlock,
  buildBlock,
  cloneState,
  genesisBlock,
  genesisState,
  normalizeTx,
  replayChain,
  txId,
  canonicalJson,
} from "../chain/core.js";

const MAX_BODY_BYTES = 1_000_000;
const PEER_TIMEOUT_MS = 3000;
const MAX_MEMPOOL = 5000;

export class ChainNode {
  constructor({ dataDir, genesis, producer = null, selfUrl = null }) {
    this.dataDir = dataDir;
    this.genesis = genesis;
    this.producer = producer; // { privateKeyDer (hex), publicKey (hex) } or null for a follower
    this.selfUrl = selfUrl;
    this.peers = new Set();
    this.blocks = [];
    this.state = null;
    this.mempool = new Map();
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
    // A stored chain is accepted only if it replays from genesis. Otherwise the node refuses to start.
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
      producer: this.producer !== null,
      producerPublicKey: this.genesis.producerPublicKey,
      peers: [...this.peers],
      mempool: this.mempool.size,
    };
  }

  blocksFrom(height) {
    return this.blocks.filter((b) => b.height >= height);
  }

  balance(address) {
    return { address, units: this.state.balanceOf(address).toString(), nonce: this.state.nextNonce(address) };
  }

  // ---------- Peers and gossip ----------

  addPeer(url) {
    if (url === this.selfUrl) return;
    this.peers.add(url);
  }

  async post(peer, path, body, headers = {}) {
    const res = await fetch(`${peer}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-peer-url": this.selfUrl ?? "", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
    });
    return res.ok;
  }

  // Failures are ignored on purpose: a dead peer must never stop the local node.
  async broadcast(path, body, exceptUrl = null) {
    await Promise.all(
      [...this.peers]
        .filter((peer) => peer !== exceptUrl)
        .map((peer) => this.post(peer, path, body).catch(() => false)),
    );
  }

  // ---------- Transactions ----------

  async submitTx(raw) {
    const tx = normalizeTx(raw);
    const id = txId(tx);
    if (this.mempool.has(id)) return { txId: id, status: "known" };
    if (this.mempool.size >= MAX_MEMPOOL) throw new ChainError("MEMPOOL_FULL", "قائمة المعاملات المعلقة ممتلئة.");

    // Full check against the confirmed state. The nonce must be the sender's next confirmed nonce.
    const trial = await cloneState(this.state);
    await trial.transfer(tx); // throws LedgerError with a specific code if invalid

    this.mempool.set(id, tx);
    await this.broadcast("/tx", tx);
    return { txId: id, status: "accepted" };
  }

  // ---------- Blocks ----------

  async produce() {
    if (!this.producer) throw new ChainError("NOT_PRODUCER", "هذه العقدة ليست منتجة للكتل.");

    const trial = await cloneState(this.state);
    const included = [];
    for (const tx of this.mempool.values()) {
      try {
        await trial.transfer(tx);
        included.push(tx);
      } catch {
        // Invalid after earlier transactions in this block: leave it out. It is pruned below.
      }
    }

    const block = await buildBlock({
      height: this.tip.height + 1,
      timestamp: Math.floor(Date.now() / 1000),
      prevHash: this.tip.hash,
      txs: included,
      producer: this.genesis.producerPublicKey,
      privateKeyDerHex: this.producer.privateKeyDer,
    });
    this.commit(block, trial);
    await this.broadcast("/block", block);
    return { height: block.height, hash: block.hash, txs: block.txs.length };
  }

  commit(block, state) {
    this.blocks.push(block);
    this.state = state;
    for (const tx of block.txs) this.mempool.delete(txId(tx));
    this.pruneMempool();
    this.persist();
  }

  // Drops mempool entries that no longer apply after a block changed the state.
  async pruneMempool() {
    const trial = await cloneState(this.state);
    for (const [id, tx] of [...this.mempool]) {
      try {
        await trial.transfer(tx);
      } catch {
        this.mempool.delete(id);
      }
    }
  }

  // Accepts a block from a peer. Blocks that extend our tip are validated and applied.
  // A block far ahead or on a different fork triggers a full sync from that peer.
  async receiveBlock(block, fromUrl) {
    if (block === null || typeof block !== "object" || typeof block.height !== "number") {
      throw new ChainError("BAD_BLOCK", "شكل الكتلة غير صالح.");
    }
    if (block.height <= this.tip.height) {
      const known = this.blocks[block.height];
      if (known.hash === block.hash) return { accepted: false, reason: "known" };
      if (fromUrl) await this.sync(fromUrl).catch(() => null);
      return { accepted: false, reason: "conflicting block, sync requested" };
    }
    if (block.height > this.tip.height + 1) {
      if (fromUrl) await this.sync(fromUrl);
      return { accepted: false, reason: "behind, synced" };
    }

    const state = await applyBlock(this.state, block, this.tip, this.genesis.producerPublicKey);
    this.commit(block, state);
    await this.broadcast("/block", block, fromUrl);
    return { accepted: true, height: block.height };
  }

  // Downloads a peer's full chain and adopts it only if it replays from genesis and is longer than ours.
  async sync(url) {
    const res = await fetch(`${url}/blocks?from=0`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new ChainError("SYNC_FAILED", `فشل الاتصال بـ ${url}`);
    const blocks = await res.json();
    if (!Array.isArray(blocks) || blocks.length <= this.blocks.length) {
      return { adopted: false, height: this.tip.height };
    }
    const state = await replayChain(blocks, this.genesis);
    this.blocks = blocks;
    this.state = state;
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

export function createHttpServer(node) {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, "http://localhost");
      const { pathname } = url;

      if (req.method === "GET" && pathname === "/status") return sendJson(res, 200, node.status());
      if (req.method === "GET" && pathname === "/blocks") {
        const from = Number(url.searchParams.get("from") ?? 0);
        return sendJson(res, 200, node.blocksFrom(Number.isInteger(from) && from >= 0 ? from : 0));
      }
      if (req.method === "GET" && pathname === "/balance") {
        return sendJson(res, 200, node.balance(url.searchParams.get("address") ?? ""));
      }
      if (req.method === "POST" && pathname === "/tx") {
        const peerUrl = req.headers["x-peer-url"];
        const body = await readJson(req);
        const result = await node.submitTx(body);
        if (peerUrl) node.addPeer(peerUrl);
        return sendJson(res, 200, result);
      }
      if (req.method === "POST" && pathname === "/block") {
        const fromUrl = req.headers["x-peer-url"] || null;
        const body = await readJson(req);
        return sendJson(res, 200, await node.receiveBlock(body, fromUrl));
      }
      if (req.method === "POST" && pathname === "/produce") {
        return sendJson(res, 200, await node.produce());
      }
      if (req.method === "POST" && pathname === "/peers") {
        const body = await readJson(req);
        if (typeof body?.url !== "string" || !/^https?:\/\//.test(body.url)) {
          throw new ChainError("BAD_PEER", "عنوان النظير غير صالح.");
        }
        node.addPeer(body.url);
        return sendJson(res, 200, { peers: [...node.peers] });
      }
      if (req.method === "POST" && pathname === "/sync") {
        const body = await readJson(req);
        if (typeof body?.url !== "string" || !/^https?:\/\//.test(body.url)) {
          throw new ChainError("BAD_PEER", "عنوان النظير غير صالح.");
        }
        return sendJson(res, 200, await node.sync(body.url));
      }
      return sendJson(res, 404, { error: "not found" });
    } catch (err) {
      const known = err instanceof LedgerError || err instanceof ChainError;
      return sendJson(res, known ? 400 : 500, {
        error: known ? err.message : "internal error",
        code: known ? err.code : "INTERNAL",
      });
    }
  });
}
