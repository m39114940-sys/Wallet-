// Stress: a long certified chain is built, then replayed from genesis. Every balance must match.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateValidatorKey, DEFAULT_STAKE } from "../node/tools.js";
import { buildBlock, createGenesisConfig, genesisBlock, replayChain, voteMessage } from "../chain/core.js";
import { signText } from "../chain/crypto.js";
import { makeAccount, signedTransfer } from "./helpers.js";

const CHAIN = "snn-stress";
const T0 = 1_700_000_000;
const BLOCKS = 300;

test(`a ${BLOCKS}-block certified chain replays from genesis with exact balances`, async () => {
  const alice = await makeAccount();
  const bob = await makeAccount();
  const keys = [];
  for (let i = 0; i < 4; i++) keys.push(await generateValidatorKey());
  const config = createGenesisConfig({
    chainId: CHAIN,
    timestamp: T0,
    allocations: [alice.address, bob.address],
    validators: keys.map((k) => ({ publicKey: k.publicKey, stake: DEFAULT_STAKE })),
    maxShareBps: 4000,
  });

  const chain = [genesisBlock(config)];
  for (let h = 1; h <= BLOCKS; h++) {
    const parent = chain[chain.length - 1];
    // Alice pays Bob 0.1 SNN per block (30 SNN in total, within her 100 SNN), with a fresh nonce each time.
    const tx = await signedTransfer(alice, bob.address, "0.1", h - 1);
    const block = buildBlock({ height: h, timestamp: T0 + h, prevHash: parent.hash, txs: [tx] });
    const signatures = [];
    for (const i of [0, 1, 2]) {
      const message = voteMessage(CHAIN, "precommit", h, 0, block.hash);
      signatures.push({ validator: keys[i].publicKey, signature: await signText(keys[i].privateKeyDer, message) });
    }
    chain.push({ ...block, certificate: { round: 0, signatures } });
  }

  const state = await replayChain(chain, config);
  // Bob started at 100 SNN from genesis and received 0.1 SNN per block.
  assert.equal(state.ledger.balanceOf(bob.address).toString(), String(100_000_000 + BLOCKS * 100_000));
});
