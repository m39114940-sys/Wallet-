// Attack tests against the chain rules: tampering, forged signatures, replay, double spending,
// certificate reuse, duplicate signers, outsiders, and cross-chain replay.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateValidatorKey, DEFAULT_STAKE } from "../node/tools.js";
import {
  applyCommitted,
  buildBlock,
  createGenesisConfig,
  genesisBlock,
  genesisState,
  voteMessage,
} from "../chain/core.js";
import { signText } from "../chain/crypto.js";
import { makeAccount, signedTransfer } from "./helpers.js";

const CHAIN = "snn-attack";
const MAX_SHARE = 4000;
const T0 = 1_700_000_000;

async function setup(chainId = CHAIN, accounts = null) {
  const alice = accounts?.alice ?? (await makeAccount());
  const bob = accounts?.bob ?? (await makeAccount());
  const mallory = accounts?.mallory ?? (await makeAccount());
  const keys = [];
  for (let i = 0; i < 4; i++) keys.push(await generateValidatorKey());
  const config = createGenesisConfig({
    chainId,
    timestamp: T0,
    allocations: [alice.address, bob.address],
    validators: keys.map((k) => ({ publicKey: k.publicKey, stake: DEFAULT_STAKE })),
    maxShareBps: MAX_SHARE,
  });
  const genesis = genesisBlock(config);
  const parent = { height: 0, hash: genesis.hash, timestamp: T0 };
  return { alice, bob, mallory, keys, config, genesis, parent, state0: genesisState(config) };
}

async function certify(block, keys, round, signers, chainId = CHAIN, height = block.height, hash = block.hash) {
  const signatures = [];
  for (const i of signers) {
    const message = voteMessage(chainId, "precommit", height, round, hash);
    signatures.push({ validator: keys[i].publicKey, signature: await signText(keys[i].privateKeyDer, message) });
  }
  return { ...block, certificate: { round, signatures } };
}

test("tampering: changing an amount after certification breaks the block", async () => {
  const s = await setup();
  const pay = await signedTransfer(s.alice, s.bob.address, "3", 0);
  const block = buildBlock({ height: 1, timestamp: T0 + 10, prevHash: s.genesis.hash, txs: [pay] });
  const certified = await certify(block, s.keys, 0, [0, 1, 2]);
  const tampered = structuredClone(certified);
  tampered.txs[0].amount = "300";
  await assert.rejects(applyCommitted(s.state0, tampered, s.parent, s.config));
});

test("forgery: a transfer signed by someone else is rejected even with a valid certificate", async () => {
  const s = await setup();
  // Mallory signs a transfer that claims to come from Alice.
  const forged = await signedTransfer(s.mallory, s.bob.address, "50", 0);
  forged.from = s.alice.address;
  const block = buildBlock({ height: 1, timestamp: T0 + 10, prevHash: s.genesis.hash, txs: [forged] });
  await assert.rejects(applyCommitted(s.state0, await certify(block, s.keys, 0, [0, 1, 2]), s.parent, s.config));
});

test("replay: the same signed transfer cannot be applied twice on one chain", async () => {
  const s = await setup();
  const pay = await signedTransfer(s.alice, s.bob.address, "3", 0);
  const block1 = buildBlock({ height: 1, timestamp: T0 + 10, prevHash: s.genesis.hash, txs: [pay] });
  const state1 = await applyCommitted(s.state0, await certify(block1, s.keys, 0, [0, 1, 2]), s.parent, s.config);
  const parent1 = { height: 1, hash: block1.hash, timestamp: T0 + 10 };
  const block2 = buildBlock({ height: 2, timestamp: T0 + 20, prevHash: block1.hash, txs: [pay] });
  await assert.rejects(applyCommitted(state1, await certify(block2, s.keys, 0, [0, 1, 2]), parent1, s.config));
});

test("double spending: two transfers that together exceed the balance are rejected", async () => {
  const s = await setup();
  const first = await signedTransfer(s.alice, s.bob.address, "80", 0);
  const second = await signedTransfer(s.alice, s.bob.address, "80", 1);
  const block = buildBlock({ height: 1, timestamp: T0 + 10, prevHash: s.genesis.hash, txs: [first, second] });
  await assert.rejects(applyCommitted(s.state0, await certify(block, s.keys, 0, [0, 1, 2]), s.parent, s.config));
});

test("certificate reuse: a certificate for height 1 does not certify a different block at height 1", async () => {
  const s = await setup();
  const pay = await signedTransfer(s.alice, s.bob.address, "3", 0);
  const real = buildBlock({ height: 1, timestamp: T0 + 10, prevHash: s.genesis.hash, txs: [pay] });
  const other = buildBlock({ height: 1, timestamp: T0 + 11, prevHash: s.genesis.hash, txs: [pay] });
  const certifiedReal = await certify(real, s.keys, 0, [0, 1, 2]);
  const reattached = { ...other, certificate: certifiedReal.certificate };
  await assert.rejects(applyCommitted(s.state0, reattached, s.parent, s.config));
});

test("duplicate signers: one validator signing three times does not form a quorum", async () => {
  const s = await setup();
  const pay = await signedTransfer(s.alice, s.bob.address, "3", 0);
  const block = buildBlock({ height: 1, timestamp: T0 + 10, prevHash: s.genesis.hash, txs: [pay] });
  const once = await certify(block, s.keys, 0, [0]);
  const sig = once.certificate.signatures[0];
  const stuffed = { ...block, certificate: { round: 0, signatures: [sig, sig, sig] } };
  await assert.rejects(applyCommitted(s.state0, stuffed, s.parent, s.config), { code: "BAD_CERTIFICATE" });
});

test("outsiders: signatures from keys outside the validator set do not count", async () => {
  const s = await setup();
  const pay = await signedTransfer(s.alice, s.bob.address, "3", 0);
  const block = buildBlock({ height: 1, timestamp: T0 + 10, prevHash: s.genesis.hash, txs: [pay] });
  const outsiders = [await generateValidatorKey(), await generateValidatorKey(), await generateValidatorKey()];
  const message = voteMessage(CHAIN, "precommit", 1, 0, block.hash);
  const signatures = [];
  for (const k of outsiders) signatures.push({ validator: k.publicKey, signature: await signText(k.privateKeyDer, message) });
  const forged = { ...block, certificate: { round: 0, signatures } };
  await assert.rejects(applyCommitted(s.state0, forged, s.parent, s.config), { code: "BAD_CERTIFICATE" });
});

test("certificate for another block hash is not accepted for this block", async () => {
  const s = await setup();
  const pay = await signedTransfer(s.alice, s.bob.address, "3", 0);
  const block = buildBlock({ height: 1, timestamp: T0 + 10, prevHash: s.genesis.hash, txs: [pay] });
  const wrongHash = "ab".repeat(32);
  const cert = await certify(block, s.keys, 0, [0, 1, 2], CHAIN, 1, wrongHash);
  await assert.rejects(applyCommitted(s.state0, cert, s.parent, s.config), { code: "BAD_CERTIFICATE" });
});

test("cross-chain certificates: a certificate for chain A is rejected on chain B", async () => {
  const s = await setup(CHAIN);
  const pay = await signedTransfer(s.alice, s.bob.address, "3", 0);
  const block = buildBlock({ height: 1, timestamp: T0 + 10, prevHash: s.genesis.hash, txs: [pay] });
  const certifiedOnA = await certify(block, s.keys, 0, [0, 1, 2], "snn-other-chain");
  await assert.rejects(applyCommitted(s.state0, certifiedOnA, s.parent, s.config), { code: "BAD_CERTIFICATE" });
});

// KNOWN GAP, pinned as current behaviour on Testnet. A LEGACY (v1) transfer does not cover a chain id, so the
// same signed transfer is accepted on another chain with the same accounts. Testnet rules are kept unchanged,
// so this stays open there. Chain-bound (v2) transfers close it: see tests/chainbinding.test.js, and
// hybrid-v1 chains refuse legacy transfers outright.
test("KNOWN GAP: a transfer signed for chain A is currently accepted on chain B with the same accounts", async () => {
  const a = await setup("snn-chain-a");
  const b = await setup("snn-chain-b", a);
  const pay = await signedTransfer(a.alice, a.bob.address, "3", 0);
  const block = buildBlock({ height: 1, timestamp: T0 + 10, prevHash: b.genesis.hash, txs: [pay] });
  const result = await applyCommitted(b.state0, await certify(block, b.keys, 0, [0, 1, 2], "snn-chain-b"), b.parent, b.config);
  assert.equal(result.ledger.balanceOf(b.bob.address).toString(), "103000000");
});

// Partition: two validators on each side cannot reach two thirds of weight, so neither side can commit.
test("partition: a 2-2 split of four equal validators commits nothing on either side", async () => {
  const s = await setup();
  const pay = await signedTransfer(s.alice, s.bob.address, "3", 0);
  const block = buildBlock({ height: 1, timestamp: T0 + 10, prevHash: s.genesis.hash, txs: [pay] });
  await assert.rejects(applyCommitted(s.state0, await certify(block, s.keys, 0, [0, 1]), s.parent, s.config), { code: "NO_QUORUM" });
  await assert.rejects(applyCommitted(s.state0, await certify(block, s.keys, 0, [2, 3]), s.parent, s.config), { code: "NO_QUORUM" });
});

// Fuzz: random single mutations of a certified block must never be accepted.
test("fuzz: no single random mutation of a certified block is accepted", async () => {
  const s = await setup();
  const pay = await signedTransfer(s.alice, s.bob.address, "3", 0);
  const block = buildBlock({ height: 1, timestamp: T0 + 10, prevHash: s.genesis.hash, txs: [pay] });
  const certified = await certify(block, s.keys, 0, [0, 1, 2]);
  const hex = (h) => (h[0] === "0" ? "1" : "0") + h.slice(1);
  const mutations = [
    (b) => { b.height += 1; },
    (b) => { b.timestamp += 1; },
    (b) => { b.prevHash = hex(b.prevHash); },
    (b) => { b.hash = hex(b.hash); },
    (b) => { b.txs[0].amount = "4"; },
    (b) => { b.txs[0].nonce = 1; },
    (b) => { b.txs[0].to = hex(b.txs[0].to); },
    (b) => { b.txs[0].signature = hex(b.txs[0].signature); },
    (b) => { b.certificate.round += 1; },
    (b) => { b.certificate.signatures[0].signature = hex(b.certificate.signatures[0].signature); },
    (b) => { b.certificate.signatures.pop(); },
    (b) => { b.certificate.signatures.push(b.certificate.signatures[0]); },
  ];
  let accepted = 0;
  for (let i = 0; i < 200; i++) {
    const copy = structuredClone(certified);
    mutations[i % mutations.length](copy);
    try {
      await applyCommitted(s.state0, copy, s.parent, s.config);
      accepted++;
    } catch {
      // expected for every mutation
    }
  }
  assert.equal(accepted, 0, `${accepted} mutated blocks were accepted`);
});
