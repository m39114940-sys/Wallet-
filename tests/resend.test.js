// Re-sending: our own votes are repeated until the height commits, rate-limited, and old rounds are pruned.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateValidatorKey, DEFAULT_STAKE } from "../node/tools.js";
import { Consensus } from "../chain/consensus.js";
import { createGenesisConfig, genesisBlock, genesisState } from "../chain/core.js";

async function fixture() {
  const keys = [];
  for (let i = 0; i < 4; i++) keys.push(await generateValidatorKey());
  const config = createGenesisConfig({
    chainId: "snn-resend",
    timestamp: 1_700_000_000,
    allocations: [],
    validators: keys.map((k) => ({ publicKey: k.publicKey, stake: DEFAULT_STAKE })),
    maxShareBps: 4000,
  });
  const sent = [];
  const node = {
    genesis: config,
    tip: { height: 0, hash: genesisBlock(config).hash, timestamp: config.timestamp },
    state: genesisState(config),
    gossip: (path, body) => sent.push(body),
    hasPendingWork: () => false,
    pendingEvidence: async () => [],
    assemble: async () => {
      throw new Error("not used");
    },
  };
  const consensus = new Consensus({ node, keys: keys[0], roundMs: 1e9 });
  consensus.ensureHeight();
  return { consensus, sent, keys };
}

const HASH = "ab".repeat(32);

test("our vote is re-sent after the interval, and not again inside it", async () => {
  const { consensus, sent } = await fixture();
  await consensus.vote("prevote", 0, HASH);
  assert.equal(sent.length, 1, "the first send happens immediately");

  consensus.lastResend = 0;
  consensus.resend();
  assert.equal(sent.length, 2, "the vote is repeated once the interval has passed");
  assert.deepEqual(sent[1], sent[0], "the repeat carries the same signed message");

  consensus.resend();
  assert.equal(sent.length, 2, "no repeat inside the interval");
});

test("messages from rounds far behind the current round are dropped from the outbox", async () => {
  const { consensus, sent } = await fixture();
  await consensus.vote("prevote", 0, HASH);
  consensus.round = 50;
  consensus.lastResend = 0;
  const before = sent.length;
  consensus.resend();
  assert.equal(sent.length, before, "old-round messages are not re-sent");
  assert.equal(consensus.outbox.size, 0, "and they are removed");
});
