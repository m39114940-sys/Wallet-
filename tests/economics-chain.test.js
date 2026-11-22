// Economics on chains whose genesis names `economics`. Uses test fixtures only, not approved values.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateValidatorKey, DEFAULT_STAKE } from "../node/tools.js";
import { Ledger } from "../js/ledger.js";
import {
  applyBlock, attachStateRoot, buildBlock, createGenesisConfig, economicsParamsOf, feeOf, genesisBlock,
  genesisState, replayChain, validateGenesis, voteMessage, withWork,
} from "../chain/core.js";
import { signText } from "../chain/crypto.js";
import { addressFromPublicKey, fromHex } from "../js/signing.js";
import { makeAccount, signedTransfer } from "./helpers.js";

const CHAIN = "snn-econ-test";
const T0 = 1_700_000_000;
const EASY = "0000" + "f".repeat(60);
const POOL = 30_000_000_000_000n; // micro-SNN, fixture

async function setup({ economics = true, feeOverrides = {} } = {}) {
  const alice = await makeAccount();
  const bob = await makeAccount();
  const fee = await makeAccount();
  const treasury = await makeAccount();
  const pool = await makeAccount();
  const keys = [];
  for (let i = 0; i < 4; i++) keys.push(await generateValidatorKey());
  const econ = {
    feeTiers: { quiet: "100", normal: "200", congested: "1000" },
    tierThresholdsBps: { normal: "2500", congested: "6000" },
    feeSplitBps: { validators: "8500", securityTreasury: "1000", burn: "500" },
    issuancePool: POOL.toString(),
    blockCapacity: "10",
    blocksPerPeriod: "4",
    securityTargetPerPeriod: "4000000",
    emissionBlocks: "2",          // fixture: blocks 1 and 2 are emission era, block 3 onward is post-emission
    periodsPerYear: "4",
    postTargetPerPeriod: "1000000",
    postCapBps: "100",            // 1% of circulating supply per year
    feeAddress: fee.address,
    treasuryAddress: treasury.address,
    poolAddress: pool.address,
    ...feeOverrides,
  };
  const config = createGenesisConfig({
    chainId: CHAIN,
    timestamp: T0,
    allocations: [alice.address, bob.address],
    validators: keys.map((k) => ({ publicKey: k.publicKey, stake: DEFAULT_STAKE })),
    maxShareBps: 4000,
    rules: "hybrid-v1",
    powTarget: EASY,
    stateRootV1: true,
    ...(economics ? { economics: econ } : {}),
  });
  return { alice, bob, fee, treasury, pool, keys, config, genesis: genesisBlock(config), state0: genesisState(config) };
}

// Adds a commit certificate signed by the validators at `signers`.
async function certify(block, keys, signers) {
  const signatures = [];
  for (const i of signers) {
    const message = voteMessage(CHAIN, "precommit", block.height, 0, block.hash);
    signatures.push({ validator: keys[i].publicKey, signature: await signText(keys[i].privateKeyDer, message) });
  }
  return { ...block, certificate: { round: 0, signatures } };
}

async function sealed(state, block, parent, config) {
  const withRoot = await attachStateRoot(state, block, parent, config);
  return withWork(withRoot, config, parent);
}

test("genesis mints the issuance pool into its own account", async () => {
  const s = await setup();
  assert.equal(s.state0.ledger.balanceOf(s.pool.address), POOL);
});

test("genesis refuses economics without stateRootV1", async () => {
  const s = await setup({ economics: true });
  const bad = { ...s.config };
  delete bad.stateRootV1;
  assert.throws(() => validateGenesis(bad), (err) => err.code === "BAD_GENESIS");
});

test("genesis refuses a fee split that does not total 100%", async () => {
  const s = await setup({ feeOverrides: { feeSplitBps: { validators: "8500", securityTreasury: "1000", burn: "600" } } });
  assert.throws(() => validateGenesis(s.config), (err) => err.code === "BAD_GENESIS");
});

test("genesis refuses fee, treasury and pool accounts that are not distinct", async () => {
  const s = await setup();
  const dup = { ...s.config, economics: { ...s.config.economics, treasuryAddress: s.config.economics.feeAddress } };
  assert.throws(() => validateGenesis(dup), (err) => err.code === "BAD_GENESIS");
});

test("fee per transaction follows the parent block's fullness", async () => {
  const s = await setup();
  assert.equal(feeOf(s.genesis, s.config), 100n);                          // empty parent: quiet
  assert.equal(feeOf({ txs: new Array(3) }, s.config), 200n);               // 3 of 10 = 3000 bps: normal tier
  assert.equal(feeOf({ txs: new Array(10) }, s.config), 1000n);            // full: congested
  const plain = await setup({ economics: false });
  assert.equal(feeOf(plain.genesis, plain.config), 0n);                    // no economics: no fee
});

test("a transfer pays its fee; the split goes to treasury and burn when the parent has no certificate", async () => {
  const s = await setup();
  const pay = await signedTransfer(s.alice, s.bob.address, "3", 0);
  const block1 = await sealed(s.state0, buildBlock({ height: 1, timestamp: T0 + 10, prevHash: s.genesis.hash, txs: [pay] }), s.genesis, s.config);
  const state1 = await applyBlock(s.state0, block1, s.genesis, s.config);
  const L = state1.ledger;
  assert.equal(L.balanceOf(s.bob.address), 100_000_000n + 3_000_000n);
  assert.equal(L.balanceOf(s.alice.address), 100_000_000n - 3_000_000n - 100n);
  // Fee 100 units: 85 would go to validators, but the genesis parent has no certificate, so the treasury takes it.
  // Treasury: 10 (its own share) + 85 (no signers) + issuance. Burn: 5.
  // Issuance: height 1, period index 1 of 4, target 1 SNN. Minus the 85 validator share, leaving 999,915 from the pool.
  assert.equal(L.balanceOf(s.fee.address), 0n);
  assert.equal(L.balanceOf(s.treasury.address), 10n + 85n + 999_915n);
  assert.equal(L.balanceOf(s.pool.address), POOL - 999_915n);
});

test("supply falls only by the burned amount", async () => {
  const s = await setup();
  const before = s.state0.ledger;
  const pay = await signedTransfer(s.alice, s.bob.address, "3", 0);
  const block1 = await sealed(s.state0, buildBlock({ height: 1, timestamp: T0 + 10, prevHash: s.genesis.hash, txs: [pay] }), s.genesis, s.config);
  const after = (await applyBlock(s.state0, block1, s.genesis, s.config)).ledger;
  const total = (L, addrs) => addrs.reduce((sum, a) => sum + L.balanceOf(a), 0n);
  const addrs = [s.alice.address, s.bob.address, s.fee.address, s.treasury.address, s.pool.address];
  assert.equal(total(before, addrs) - total(after, addrs), 5n); // the burn
});

test("issuance is paid to the parent certificate's signers, exactly, by weight", async () => {
  const s = await setup();
  const pay = await signedTransfer(s.alice, s.bob.address, "3", 0);
  const block1 = await sealed(s.state0, buildBlock({ height: 1, timestamp: T0 + 10, prevHash: s.genesis.hash, txs: [pay] }), s.genesis, s.config);
  const certified1 = await certify(block1, s.keys, [0, 1, 2]);
  const state1 = await applyBlock(s.state0, certified1, s.genesis, s.config);
  const block2 = await sealed(state1, buildBlock({ height: 2, timestamp: T0 + 20, prevHash: certified1.hash, txs: [] }), certified1, s.config);
  const state2 = await applyBlock(state1, block2, certified1, s.config);
  // Height 2 is period index 2 of 4: target 1 SNN for this block, no fees (block 2 is empty), so all 1 SNN is issuance.
  const signers = [s.keys[0], s.keys[1], s.keys[2]].map((k) => k.publicKey).sort();
  const addrs = await Promise.all(signers.map((k) => addressFromPublicKey(fromHex(k))));
  const paid = addrs.map((a) => state2.ledger.balanceOf(a) - state1.ledger.balanceOf(a));
  assert.equal(paid.reduce((a, b) => a + b, 0n), 1_000_000n);
  for (const p of paid) assert.ok(p === 333_333n || p === 333_334n);
  assert.equal(paid[0], 333_334n); // the remainder unit goes to the first signer in sorted order
});

test("a transfer that cannot pay its fee is rejected, even when the amount itself is covered", async () => {
  const s = await setup();
  const all = await signedTransfer(s.alice, s.bob.address, "100", 0); // amount equals the whole balance
  const block = buildBlock({ height: 1, timestamp: T0 + 10, prevHash: s.genesis.hash, txs: [all] });
  await assert.rejects(attachStateRoot(s.state0, block, s.genesis, s.config), (err) => err.code === "BAD_TX");
});

test("replay from genesis reproduces the state root and balances", async () => {
  const s = await setup();
  const pay = await signedTransfer(s.alice, s.bob.address, "3", 0);
  const block1 = await sealed(s.state0, buildBlock({ height: 1, timestamp: T0 + 10, prevHash: s.genesis.hash, txs: [pay] }), s.genesis, s.config);
  const certified1 = await certify(block1, s.keys, [0, 1, 2]);
  const state1 = await applyBlock(s.state0, certified1, s.genesis, s.config);
  const block2 = await sealed(state1, buildBlock({ height: 2, timestamp: T0 + 20, prevHash: certified1.hash, txs: [] }), certified1, s.config);
  const certified2 = await certify(block2, s.keys, [0, 1, 2]);
  const replayed = await replayChain([s.genesis, certified1, certified2], s.config);
  assert.equal(replayed.ledger.balanceOf(s.pool.address), (await applyBlock(state1, block2, certified1, s.config)).ledger.balanceOf(s.pool.address));
  // Ledger records (genesis, protocol) survive a snapshot round trip.
  const copy = await Ledger.fromSnapshot(JSON.parse(JSON.stringify(replayed.ledger)));
  assert.equal(copy.balanceOf(s.pool.address), replayed.ledger.balanceOf(s.pool.address));
  assert.equal(copy.balanceOf(s.treasury.address), replayed.ledger.balanceOf(s.treasury.address));
});

test("economicsParamsOf converts genesis strings to integers", async () => {
  const s = await setup();
  const p = economicsParamsOf(s.config.economics);
  assert.equal(p.feeTiers.congested, 1000n);
  assert.equal(p.feeSplitBps.burn, 500n);
  assert.equal(p.issuancePool, POOL);
});

test("after emission, the shortfall is minted up to the cap on circulating supply, paid to the parent's signers", async () => {
  const s = await setup();
  const pay = await signedTransfer(s.alice, s.bob.address, "3", 0);
  const block1 = await sealed(s.state0, buildBlock({ height: 1, timestamp: T0 + 10, prevHash: s.genesis.hash, txs: [pay] }), s.genesis, s.config);
  const certified1 = await certify(block1, s.keys, [0, 1, 2]);
  const state1 = await applyBlock(s.state0, certified1, s.genesis, s.config);
  const block2 = await sealed(state1, buildBlock({ height: 2, timestamp: T0 + 20, prevHash: certified1.hash, txs: [] }), certified1, s.config);
  const certified2 = await certify(block2, s.keys, [0, 1, 2]);
  const state2 = await applyBlock(state1, block2, certified1, s.config);
  const block3 = await sealed(state2, buildBlock({ height: 3, timestamp: T0 + 30, prevHash: certified2.hash, txs: [] }), certified2, s.config);
  const state3 = await applyBlock(state2, block3, certified2, s.config);

  // Block 3 of a 4-block period: target 250,000 units, no fee share, so the shortfall is the full target.
  // Cap: circulating (all balances except pool, treasury, fee) x 1% / (periods per year x blocks per period).
  const circulating = state2.ledger.totalBalance([s.pool.address, s.treasury.address, s.fee.address]);
  const cap = (circulating * 100n) / (10_000n * 16n);
  const expected = cap < 250_000n ? cap : 250_000n;
  assert.equal(state3.ledger.totalBalance([]) - state2.ledger.totalBalance([]), expected);  // minted, nothing else
  assert.equal(state3.ledger.balanceOf(s.pool.address), state2.ledger.balanceOf(s.pool.address)); // pool untouched

  const signers = [s.keys[0], s.keys[1], s.keys[2]].map((k) => k.publicKey);
  const addrs = await Promise.all(signers.map((k) => addressFromPublicKey(fromHex(k))));
  const received = addrs.reduce((sum, a) => sum + (state3.ledger.balanceOf(a) - state2.ledger.balanceOf(a)), 0n);
  assert.equal(received, expected);
});

