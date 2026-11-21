// Consensus engine for one height at a time, in rounds: propose, prevote, precommit, commit.
//
// Safety rules (Tendermint-style):
// - A validator sends at most one prevote and one precommit per round. So honest validators never
//   create double-sign evidence against themselves.
// - When a validator sees a prevote quorum for block X in round r, it locks on X and precommits X.
// - It prevotes for a different block only when the proposal carries a polka (prevote quorum) from a
//   round at least as recent as its lock. Without this rule, two blocks could both commit.
// - A block is committed only with precommits from validators holding more than two thirds of weight.
//
// Hardening against hostile messages:
// - Votes and proposals more than MAX_ROUND_AHEAD rounds in the future are refused, which bounds memory.
// - The engine jumps to a later round only when validators holding more than one third of the weight
//   have already reached it. A single validator cannot drag the network through rounds.
// - Each validator's signature is checked before any state changes or any sync is requested.
//
// Liveness: a silent proposer causes a timeout, and the next round selects another proposer.
// The chain halts (it does not finalize unsafely) when too much weight is silent.
// Proposals are made only when there is pending work, so idle chains do not grow.

import { signText, verifyText } from "./crypto.js";
import {
  ChainError,
  MAX_CLOCK_DRIFT_MS,
  NIL,
  applyBlock,
  proposalMessage,
  validatorWeights,
  voteMessage,
} from "./core.js";
import { proposerFor, hasQuorum, hasOneThird } from "./weights.js";

const HASH = /^[0-9a-f]{64}$/;
const MAX_ROUND_AHEAD = 100;
// Our own proposal and votes are re-sent this often until the height commits, so a lost message
// cannot stall a round forever. Receivers ignore duplicates, so re-sending does not flood the network.
export const RESEND_MS = 2000;
const RESEND_ROUND_WINDOW = 8; // only the last few rounds are re-sent, which bounds the outbox
const isRound = (r) => Number.isInteger(r) && r >= 0;

export class Consensus {
  constructor({ node, keys, roundMs }) {
    this.node = node;
    this.keys = keys; // { publicKey, privateKeyDer } for a validator, or null for a relay
    this.roundMs = roundMs;
    this.height = null;
    this.vset = null;
    this.round = 0;
    this.outbox = new Map(); // `${kind}|${round}|${type}` -> { round, message } of our own messages
    this.lastResend = 0;
  }

  get chainId() {
    return this.node.genesis.chainId;
  }

  // Resets the per-height state whenever the chain tip moved (after a commit, a sync, or a gossiped block).
  ensureHeight() {
    const height = this.node.tip.height + 1;
    if (this.height === height) return;
    this.vset = validatorWeights(this.node.state, this.node.genesis.maxShareBps); // may throw: chain halts
    this.height = height;
    this.round = 0;
    this.roundStarted = Date.now();
    this.outbox = new Map();
    this.lock = null; // { round, block }
    this.valid = null; // { round, block, polka } : latest polka seen, re-proposed if we propose
    this.proposals = new Map(); // round -> proposal
    this.blocks = new Map(); // blockHash -> { block, state }
    this.votes = new Map(); // `${round}|${type}` -> Map(validator -> { blockHash, signature })
    this.seen = new Map(); // validator -> highest round it has spoken in at this height
    this.sent = new Set(); // `${round}|${type}` for our own votes
    this.proposed = new Set(); // rounds we proposed in
  }

  isCurrent() {
    return this.height === this.node.tip.height + 1;
  }

  isProposer(round) {
    return proposerFor(this.vset.weights, this.height, round) === this.keys.publicKey;
  }

  advance(round) {
    this.round = round;
    this.roundStarted = Date.now();
  }

  // Skip rule: move to the largest round r > current such that validators holding more than one third
  // of the weight have spoken in round r or later. At least one of them is honest, so the round is live.
  maybeSkip() {
    const { weights } = this.vset;
    const candidates = [...new Set([...this.seen.values()])]
      .filter((r) => r > this.round)
      .sort((a, b) => b - a);
    for (const r of candidates) {
      let power = 0n;
      for (const [validator, seenRound] of this.seen) {
        if (seenRound >= r) power += weights.get(validator);
      }
      if (hasOneThird(power, this.vset.total)) {
        this.advance(r);
        return;
      }
    }
  }

  noteSeen(validator, round) {
    if (!this.seen.has(validator) || this.seen.get(validator) < round) this.seen.set(validator, round);
  }

  async tick() {
    this.ensureHeight();
    if (this.keys && !this.proposed.has(this.round) && this.isProposer(this.round)) {
      if (this.node.hasPendingWork()) await this.propose();
    }
    await this.step();
    if (this.isCurrent() && Date.now() - this.roundStarted >= this.roundMs) await this.timeout();
    this.resend();
  }

  // Re-sends our recent messages for this height. Stops being needed once the height commits,
  // because ensureHeight then clears the outbox.
  resend() {
    if (!this.keys || this.outbox.size === 0) return;
    const now = Date.now();
    if (now - this.lastResend < RESEND_MS) return;
    this.lastResend = now;
    for (const [key, entry] of this.outbox) {
      if (entry.round < this.round - RESEND_ROUND_WINDOW) {
        this.outbox.delete(key);
        continue;
      }
      this.node.gossip("/consensus", entry.message);
    }
  }

  async timeout() {
    if (!this.isCurrent()) return;
    await this.vote("prevote", this.round, NIL);
    await this.vote("precommit", this.round, NIL);
    this.advance(this.round + 1);
    await this.step();
  }

  // ---------- Proposals ----------

  async propose() {
    const round = this.round;
    this.proposed.add(round);
    const height = this.height;

    let block;
    let polkaRound = -1;
    let polka = [];
    if (this.valid && this.valid.round < round) {
      // A polka exists for a block we already accepted: re-propose it, so the lock can be released.
      ({ block } = this.valid);
      polkaRound = this.valid.round;
      polka = this.valid.polka;
    } else {
      const evidence = await this.node.pendingEvidence(height);
      block = await this.node.assemble(evidence);
    }

    const signature = await signText(
      this.keys.privateKeyDer,
      proposalMessage(this.chainId, height, round, polkaRound, block.hash),
    );
    const proposal = { height, round, polkaRound, polka, block, from: this.keys.publicKey, signature };
    if ((await this.onProposal(proposal)) === "new") {
      const message = { kind: "proposal", payload: proposal };
      this.outbox.set(`proposal|${round}`, { round, message });
      this.node.gossip("/consensus", message);
    }
  }

  async onProposal(p) {
    this.ensureHeight();
    if (p.height > this.height) return "behind";
    if (p.height < this.height) return "stale";
    if (!isRound(p.round) || p.round > this.round + MAX_ROUND_AHEAD) {
      throw new ChainError("BAD_PROPOSAL", "رقم الجولة في الاقتراح غير صالح.");
    }
    if (!Number.isInteger(p.polkaRound) || p.polkaRound < -1 || p.polkaRound >= p.round) {
      throw new ChainError("BAD_PROPOSAL", "إثبات الأغلبية في الاقتراح غير صالح.");
    }
    if (p.block === null || typeof p.block !== "object" || typeof p.block.hash !== "string") {
      throw new ChainError("BAD_BLOCK", "الكتلة المقترحة غير صالحة.");
    }
    if (proposerFor(this.vset.weights, this.height, p.round) !== p.from) {
      throw new ChainError("BAD_PROPOSER", "المقترِح ليس مدقق هذه الجولة.");
    }
    const message = proposalMessage(this.chainId, p.height, p.round, p.polkaRound, p.block.hash);
    if (!(await verifyText(p.from, message, p.signature))) {
      throw new ChainError("BAD_SIGNATURE", "توقيع الاقتراح غير صحيح.");
    }
    if (this.proposals.has(p.round)) return "duplicate";
    if (p.polkaRound >= 0) await this.verifyPolka(p.block.hash, p.polkaRound, p.polka);

    if (!(p.block.timestamp <= Date.now() + MAX_CLOCK_DRIFT_MS)) {
      throw new ChainError("BAD_TIMESTAMP", "الكتلة مختومة بوقت أبعد من الساعة المسموحة.");
    }
    const state = await applyBlock(this.node.state, p.block, this.node.tip, this.node.genesis);
    this.proposals.set(p.round, p);
    this.blocks.set(p.block.hash, { block: p.block, state });
    this.noteSeen(p.from, p.round);
    this.maybeSkip();
    await this.step();
    return "new";
  }

  // A polka is a prevote quorum for one block in an earlier round. It is checked before anyone relies on it.
  async verifyPolka(blockHash, round, sigs) {
    if (!Array.isArray(sigs)) throw new ChainError("BAD_POLKA", "شكل إثبات الأغلبية غير صالح.");
    const { weights, total } = this.vset;
    const message = voteMessage(this.chainId, "prevote", this.height, round, blockHash);
    const seen = new Set();
    let power = 0n;
    for (const entry of sigs) {
      const validator = entry?.validator;
      if (!weights.has(validator) || seen.has(validator)) {
        throw new ChainError("BAD_POLKA", "إثبات الأغلبية يحتوي على مدقق غير معتمد أو مكرر.");
      }
      seen.add(validator);
      if (!(await verifyText(validator, message, entry.signature))) {
        throw new ChainError("BAD_POLKA", "توقيع إثبات الأغلبية غير صحيح.");
      }
      power += weights.get(validator);
    }
    if (!hasQuorum(power, total)) throw new ChainError("BAD_POLKA", "إثبات الأغلبية لا يبلغ الثلثين.");
  }

  // ---------- Votes ----------

  async onVote(v) {
    this.ensureHeight();
    if (!Number.isInteger(v.height)) throw new ChainError("BAD_VOTE", "ارتفاع التصويت غير صالح.");
    if (v.height > this.height) return "behind";
    if (v.height < this.height) return "stale";
    if ((v.type !== "prevote" && v.type !== "precommit") || !isRound(v.round)) {
      throw new ChainError("BAD_VOTE", "نوع التصويت أو رقم الجولة غير صالح.");
    }
    if (v.round > this.round + MAX_ROUND_AHEAD) throw new ChainError("BAD_VOTE", "رقم الجولة بعيد جداً.");
    if (v.blockHash !== NIL && !(typeof v.blockHash === "string" && HASH.test(v.blockHash))) {
      throw new ChainError("BAD_VOTE", "هدف التصويت غير صالح.");
    }
    if (!this.vset.weights.has(v.validator)) throw new ChainError("BAD_VOTER", "المصوِّت ليس مدققاً نشطاً.");
    const message = voteMessage(this.chainId, v.type, this.height, v.round, v.blockHash);
    if (!(await verifyText(v.validator, message, v.signature))) {
      throw new ChainError("BAD_SIGNATURE", "توقيع التصويت غير صحيح.");
    }
    const result = await this.record(v);
    if (result === "new") {
      this.noteSeen(v.validator, v.round);
      this.maybeSkip();
      await this.step();
    }
    return result;
  }

  // Stores a verified vote. A second, different vote of the same type from one validator in the same round
  // is double signing. The two signed votes become evidence, which the node gossips and includes in a block.
  async record(v) {
    const key = `${v.round}|${v.type}`;
    if (!this.votes.has(key)) this.votes.set(key, new Map());
    const map = this.votes.get(key);
    const prior = map.get(v.validator);
    if (prior) {
      if (prior.blockHash === v.blockHash) return "duplicate";
      try {
        await this.node.receiveEvidence({
          type: v.type,
          validator: v.validator,
          height: this.height,
          round: v.round,
          blockA: prior.blockHash,
          signatureA: prior.signature,
          blockB: v.blockHash,
          signatureB: v.signature,
        });
      } catch {
        /* evidence that does not verify is not stored */
      }
      return "conflict";
    }
    map.set(v.validator, { blockHash: v.blockHash, signature: v.signature });
    return "new";
  }

  // Our own vote: sent at most once per round and type.
  async vote(type, round, blockHash) {
    const key = `${round}|${type}`;
    if (this.sent.has(key)) return false;
    this.sent.add(key);
    if (!this.keys) return true; // relays do not sign, but the step is done
    const signature = await signText(
      this.keys.privateKeyDer,
      voteMessage(this.chainId, type, this.height, round, blockHash),
    );
    const vote = { type, height: this.height, round, blockHash, validator: this.keys.publicKey, signature };
    await this.record(vote);
    const message = { kind: "vote", payload: vote };
    this.outbox.set(`vote|${round}|${type}`, { round, message });
    this.node.gossip("/consensus", message);
    return true;
  }

  // Groups the votes of one round and type by target, with the total weight of each target.
  tally(round, type) {
    const map = this.votes.get(`${round}|${type}`) ?? new Map();
    const groups = new Map();
    for (const [validator, { blockHash, signature }] of map) {
      if (!groups.has(blockHash)) groups.set(blockHash, { blockHash, power: 0n, signatures: [] });
      const group = groups.get(blockHash);
      group.power += this.vset.weights.get(validator);
      group.signatures.push({ validator, signature });
    }
    return [...groups.values()];
  }

  quorum(round, type) {
    const { total } = this.vset;
    const group = this.tally(round, type).find((g) => hasQuorum(g.power, total));
    if (!group) return null;
    group.signatures.sort((a, b) => (a.validator < b.validator ? -1 : 1));
    return group;
  }

  // ---------- Locks and steps ----------

  canPrevote(proposal) {
    if (this.lock === null) return true;
    if (this.lock.block.hash === proposal.block.hash) return true;
    return proposal.polkaRound >= this.lock.round; // a newer or equal polka releases the lock
  }

  async step() {
    for (let i = 0; i < 1000; i++) {
      if (!this.isCurrent()) return;
      if (await this.tryCommit()) return;

      const r = this.round;
      let changed = false;

      const proposal = this.proposals.get(r);
      if (proposal && (await this.vote("prevote", r, this.canPrevote(proposal) ? proposal.block.hash : NIL))) {
        changed = true;
      }

      const polka = this.quorum(r, "prevote");
      if (polka && polka.blockHash === NIL) {
        if (await this.vote("precommit", r, NIL)) changed = true;
      } else if (polka && this.blocks.has(polka.blockHash)) {
        const { block } = this.blocks.get(polka.blockHash);
        if (!this.valid || this.valid.round < r) this.valid = { round: r, block, polka: polka.signatures };
        if (!this.lock || this.lock.round < r) this.lock = { round: r, block };
        if (await this.vote("precommit", r, polka.blockHash)) changed = true;
      }

      const nilPrecommits = this.quorum(r, "precommit");
      if (nilPrecommits && nilPrecommits.blockHash === NIL) {
        this.advance(r + 1);
        changed = true;
      }
      if (!changed) return;
    }
  }

  async tryCommit() {
    for (const key of this.votes.keys()) {
      const [round, type] = key.split("|");
      if (type !== "precommit") continue;
      const winner = this.quorum(Number(round), "precommit");
      if (!winner || winner.blockHash === NIL || !this.blocks.has(winner.blockHash)) continue;
      const { block, state } = this.blocks.get(winner.blockHash);
      const certified = {
        ...block,
        certificate: { round: Number(round), signatures: winner.signatures },
      };
      await this.node.commitBlock(certified, state);
      this.node.gossip("/block", certified);
      return true;
    }
    return false;
  }
}
