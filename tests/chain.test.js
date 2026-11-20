// Unit tests for the chain rules: certificates, quorum, double-sign evidence, slashing, jailing and replay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateValidatorKey, DEFAULT_STAKE } from "../node/tools.js";
import {
  applyBlock,
  applyCommitted,
  buildBlock,
  createGenesisConfig,
  genesisBlock,
  genesisState,
  replayChain,
  validatorWeights,
  voteMessage,
} from "../chain/core.js";
import { signText } from "../chain/crypto.js";
import { makeAccount, signedTransfer } from "./helpers.js";

const CHAIN = "snn-unit";
const MAX_SHARE = 0.4;
const T0 = 1_700_000_000;

async function setup() {
  const alice = await makeAccount();
  const bob = await makeAccount();
  const keys = [];
  for (let i = 0; i < 4; i++) keys.push(await generateValidatorKey());
  const config = createGenesisConfig({
    chainId: CHAIN,
    timestamp: T0,
    allocations: [alice.address, bob.address],
    validators: keys.map((k) => ({ publicKey: k.publicKey, stake: DEFAULT_STAKE })),
    maxShare: MAX_SHARE,
  });
  return { alice, bob, keys, config };
}

// Adds a commit certificate signed by the validators at `signers` (indexes into keys).
async function certify(block, keys, round, signers, chainId = CHAIN) {
  const signatures = [];
  for (const i of signers) {
    const message = voteMessage(chainId, "precommit", block.height, round, block.hash);
    signatures.push({ validator: keys[i].publicKey, signature: await signText(keys[i].privateKeyDer, message) });
  }
  return { ...block, certificate: { round, signatures } };
}

test("a block needs a certificate above two thirds of validator weight", async () => {
  const { alice, bob, keys, config } = await setup();
  const genesis = genesisBlock(config);
  const state0 = genesisState(config);
  const parent = { height: 0, hash: genesis.hash };
  const pay = await signedTransfer(alice, bob.address, "3", 0);
  const block = buildBlock({ height: 1, timestamp: T0 + 10, prevHash: genesis.hash, txs: [pay] });

  await assert.rejects(applyCommitted(state0, await certify(block, keys, 0, [0, 1]), parent, config), {
    code: "NO_QUORUM",
  });
  const state1 = await applyCommitted(state0, await certify(block, keys, 0, [0, 1, 2]), parent, config);
  assert.equal(state1.ledger.balanceOf(bob.address).toString(), "103000000"); // 100 from genesis plus 3
});

test("signatures that do not count: repeats, outsiders, and a certificate for another block", async () => {
  const { alice, bob, keys, config } = await setup();
  const genesis = genesisBlock(config);
  const state0 = genesisState(config);
  const parent = { height: 0, hash: genesis.hash };
  const pay = await signedTransfer(alice, bob.address, "3", 0);
  const block = buildBlock({ height: 1, timestamp: T0 + 10, prevHash: genesis.hash, txs: [pay] });
  const good = await certify(block, keys, 0, [0, 1, 2]);

  const [s0, s1, s2] = good.certificate.signatures;
  const repeated = { ...good, certificate: { round: 0, signatures: [s0, s0, s1] } };
  await assert.rejects(applyCommitted(state0, repeated, parent, config), { code: "BAD_CERTIFICATE" });

  const outsider = await generateValidatorKey();
  const outsiderSig = await signText(outsider.privateKeyDer, voteMessage(CHAIN, "precommit", 1, 0, block.hash));
  const forged = {
    ...good,
    certificate: { round: 0, signatures: [{ validator: outsider.publicKey, signature: outsiderSig }, s1, s2] },
  };
  await assert.rejects(applyCommitted(state0, forged, parent, config), { code: "BAD_CERTIFICATE" });

  const other = buildBlock({ height: 1, timestamp: T0 + 11, prevHash: genesis.hash, txs: [] });
  const otherCert = await certify(other, keys, 0, [0, 1, 2]);
  const transplanted = { ...block, certificate: otherCert.certificate };
  await assert.rejects(applyCommitted(state0, transplanted, parent, config), { code: "BAD_CERTIFICATE" });
});

test("a transaction changed after certification is refused by the Merkle check", async () => {
  const { alice, bob, keys, config } = await setup();
  const genesis = genesisBlock(config);
  const pay = await signedTransfer(alice, bob.address, "3", 0);
  const block = buildBlock({ height: 1, timestamp: T0 + 10, prevHash: genesis.hash, txs: [pay] });
  const good = await certify(block, keys, 0, [0, 1, 2]);
  const tampered = { ...good, txs: [{ ...good.txs[0], amount: "500" }] };
  await assert.rejects(applyCommitted(genesisState(config), tampered, { height: 0, hash: genesis.hash }, config), {
    code: "BAD_MERKLE",
  });
});

test("two precommits for different blocks prove double signing: the validator is slashed and jailed", async () => {
  const { keys, config } = await setup();
  const genesis = genesisBlock(config);
  const b1 = buildBlock({ height: 1, timestamp: T0 + 10, prevHash: genesis.hash, txs: [] });
  const state1 = await applyCommitted(genesisState(config), await certify(b1, keys, 0, [0, 1, 2]), {
    height: 0,
    hash: genesis.hash,
  }, config);

  const blockA = "a".repeat(64);
  const blockB = "b".repeat(64);
  const culprit = keys[3];
  const sign = (target) => signText(culprit.privateKeyDer, voteMessage(CHAIN, "precommit", 1, 0, target));
  const evidence = {
    validator: culprit.publicKey,
    height: 1,
    round: 0,
    blockA,
    signatureA: await sign(blockA),
    blockB,
    signatureB: await sign(blockB),
  };

  const b2 = buildBlock({ height: 2, timestamp: T0 + 20, prevHash: b1.hash, txs: [], evidence: [evidence] });
  const state2 = await applyCommitted(state1, await certify(b2, keys, 0, [0, 1, 2]), { height: 1, hash: b1.hash }, config);
  assert.equal(state2.stakes.get(culprit.publicKey), 950000000n); // 5% burned from 1000 SNN
  assert.ok(state2.jailed.has(culprit.publicKey));
  assert.equal(validatorWeights(state2, MAX_SHARE).weights.size, 3);

  // A jailed validator's signature no longer counts toward a certificate.
  const b3 = buildBlock({ height: 3, timestamp: T0 + 30, prevHash: b2.hash, txs: [] });
  const withJailed = await certify(b3, keys, 0, [0, 1, 3]);
  await assert.rejects(applyCommitted(state2, withJailed, { height: 2, hash: b2.hash }, config), {
    code: "BAD_CERTIFICATE",
  });
});

test("evidence is refused when its signatures do not match or when both votes name the same block", async () => {
  const { keys, config } = await setup();
  const genesis = genesisBlock(config);
  const state0 = genesisState(config);
  const culprit = keys[2];
  const blockA = "c".repeat(64);
  const blockB = "d".repeat(64);
  const sigA = await signText(culprit.privateKeyDer, voteMessage(CHAIN, "precommit", 0, 0, blockA));
  const sigB = await signText(culprit.privateKeyDer, voteMessage(CHAIN, "precommit", 0, 0, blockB));
  const base = { validator: culprit.publicKey, height: 0, round: 0, blockA, signatureA: sigA, blockB, signatureB: sigB };

  const swapped = buildBlock({
    height: 1,
    timestamp: T0 + 10,
    prevHash: genesis.hash,
    txs: [],
    evidence: [{ ...base, signatureB: sigA }],
  });
  await assert.rejects(applyBlock(state0, swapped, { height: 0, hash: genesis.hash }, config), { code: "BAD_EVIDENCE" });

  const same = buildBlock({
    height: 1,
    timestamp: T0 + 10,
    prevHash: genesis.hash,
    txs: [],
    evidence: [{ ...base, blockB: blockA, signatureB: sigA }],
  });
  await assert.rejects(applyBlock(state0, same, { height: 0, hash: genesis.hash }, config), { code: "BAD_EVIDENCE" });
});

test("with two of four validators jailed, the weight rules cannot run and the chain halts", async () => {
  const { keys, config } = await setup();
  const state = genesisState(config);
  const jailed = { ...state, jailed: new Set([keys[2].publicKey, keys[3].publicKey]) };
  assert.throws(() => validatorWeights(jailed, MAX_SHARE), { code: "NOT_ENOUGH_VALIDATORS" });
});

test("replaying stored blocks rebuilds the state, and a tampered stored block is refused", async () => {
  const { alice, bob, keys, config } = await setup();
  const genesis = genesisBlock(config);
  const pay = await signedTransfer(alice, bob.address, "3", 0);
  const b1 = await certify(buildBlock({ height: 1, timestamp: T0 + 10, prevHash: genesis.hash, txs: [pay] }), keys, 0, [0, 1, 2]);

  const state = await replayChain([genesis, b1], config);
  assert.equal(state.ledger.balanceOf(bob.address).toString(), "103000000");

  const tampered = JSON.parse(JSON.stringify(b1));
  tampered.txs[0].amount = "500";
  await assert.rejects(replayChain([genesis, tampered], config), { code: "BAD_MERKLE" });
});
