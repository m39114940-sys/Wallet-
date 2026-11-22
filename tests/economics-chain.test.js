// Economics on chains whose genesis names `economics`. Uses test fixtures only, not approved values.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateValidatorKey, DEFAULT_STAKE } from "../node/tools.js";
import { Ledger } from "../js/ledger.js";
import { addressFromPublicKey, fromHex } from "../js/signing.js";
import { signText } from "../chain/crypto.js";
import {
  applyBlock, applyUserTx, attachStateRoot, buildBlock, cloneState, createGenesisConfig, economicsParamsOf, feeOf,
  genesisBlock, genesisState, lockedAt, lockedTotal, replayChain, validateGenesis, voteMessage, withWork,
} from "../chain/core.js";
import { makeAccount, signedTransfer } from "./helpers.js";

const CHAIN = "snn-econ-test";
const T0 = 1_700_000_000;
const EASY = "0000" + "f".repeat(60);
const POOL = 30_000_000_000_000n; // micro-SNN, fixture
const TREASURY = 15_000_000_000_000n;
const FOUNDER = 5_000_000_000_000n;
const USER = 100_000_000n;       // 100 SNN
const FOREVER = "1000000000000"; // blocks: effectively locked for the test

const unlocked = { cliffBlocks: "0", cliffReleaseBps: "10000", durationBlocks: "0" };
const locked = { cliffBlocks: FOREVER, cliffReleaseBps: "0", durationBlocks: "0" };

async function setup({ economics = true, feeOverrides = {}, withGenesis = true } = {}) {
  const alice = await makeAccount();
  const bob = await makeAccount();
  const fee = await makeAccount();
  const treasury = await makeAccount();
  const pool = await makeAccount();
  const founder = await makeAccount();
  const ops = await makeAccount();
  const keys = [];
  for (let i = 0; i < 4; i++) keys.push(await generateValidatorKey());
  const genesisAllocations = [
    { address: alice.address, units: USER.toString(), vesting: unlocked },
    { address: bob.address, units: USER.toString(), vesting: unlocked },
    { address: pool.address, units: POOL.toString(), vesting: unlocked },
    { address: treasury.address, units: TREASURY.toString(), vesting: locked },
    // Founder: locked until block 5, then released linearly over 10 blocks.
    { address: founder.address, units: FOUNDER.toString(), vesting: { cliffBlocks: "5", cliffReleaseBps: "0", durationBlocks: "10" } },
    // Remainder of the 100,000,000 SNN supply, locked for the test.
    { address: ops.address, units: (100_000_000_000_000n - POOL - TREASURY - FOUNDER - 2n * USER).toString(), vesting: locked },
  ];
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
    genesisAllocations,
    ...feeOverrides,
  };
  const config = createGenesisConfig({
    chainId: CHAIN,
    timestamp: T0,
    allocations: economics ? [] : [alice.address, bob.address],
    validators: keys.map((k) => ({ publicKey: k.publicKey, stake: DEFAULT_STAKE })),
    maxShareBps: 4000,
    rules: "hybrid-v1",
    powTarget: EASY,
    stateRootV1: true,
    ...(economics ? { economics: econ } : {}),
  });
  // genesisState validates the config, so a refusal test asks for the raw config and validates it itself.
  if (!withGenesis) return { alice, bob, fee, treasury, pool, founder, ops, keys, config };
  return { alice, bob, fee, treasury, pool, founder, ops, keys, config, genesis: genesisBlock(config), state0: genesisState(config) };
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

test("genesis mints the whole supply per allocation; the pool gets exactly its share", async () => {
  const s = await setup();
  assert.equal(s.state0.ledger.balanceOf(s.pool.address), POOL);
  assert.equal(s.state0.ledger.totalBalance([]), 100_000_000_000_000n);
});

test("genesis refuses economics without stateRootV1", async () => {
  const s = await setup({ economics: true });
  const bad = { ...s.config };
  delete bad.stateRootV1;
  assert.throws(() => validateGenesis(bad), (err) => err.code === "BAD_GENESIS");
});

test("genesis refuses a fee split that does not total 100%", async () => {
  const s = await setup({ withGenesis: false, feeOverrides: { feeSplitBps: { validators: "8500", securityTreasury: "1000", burn: "600" } } });
  assert.throws(() => validateGenesis(s.config), (err) => err.code === "BAD_GENESIS");
});

test("genesis refuses fee, treasury and pool accounts that are not distinct", async () => {
  const s = await setup();
  const dup = { ...s.config, economics: { ...s.config.economics, treasuryAddress: s.config.economics.feeAddress } };
  assert.throws(() => validateGenesis(dup), (err) => err.code === "BAD_GENESIS");
});

test("genesis refuses an allocation total different from the 100,000,000 SNN supply", async () => {
  const s = await setup();
  const list = s.config.economics.genesisAllocations.map((a, i) => (i === 0 ? { ...a, units: "1" } : a));
  const bad = { ...s.config, economics: { ...s.config.economics, genesisAllocations: list } };
  assert.throws(() => validateGenesis(bad), (err) => err.code === "BAD_GENESIS");
});

test("genesis refuses faucet allocations on an economics chain", async () => {
  const s = await setup();
  const bad = { ...s.config, allocations: [s.alice.address] };
  assert.throws(() => validateGenesis(bad), (err) => err.code === "BAD_GENESIS");
});

test("fee per transaction follows the parent block's fullness", async () => {
  const s = await setup();
  assert.equal(feeOf(s.genesis, s.config), 100n);
  assert.equal(feeOf({ txs: new Array(3) }, s.config), 200n); // 3 of 10 = 3000 bps: normal tier
  assert.equal(feeOf({ txs: new Array(10) }, s.config), 1000n);
  const plain = await setup({ economics: false });
  assert.equal(feeOf(plain.genesis, plain.config), 0n);
});

test("a transfer pays its fee; the split goes to treasury and burn when the parent has no certificate", async () => {
  const s = await setup();
  const pay = await signedTransfer(s.alice, s.bob.address, "3", 0);
  const block1 = await sealed(s.state0, buildBlock({ height: 1, timestamp: T0 + 10, prevHash: s.genesis.hash, txs: [pay] }), s.genesis, s.config);
  const state1 = await applyBlock(s.state0, block1, s.genesis, s.config);
  const L = state1.ledger;
  assert.equal(L.balanceOf(s.bob.address), USER + 3_000_000n);
  assert.equal(L.balanceOf(s.alice.address), USER - 3_000_000n - 100n);
  // Fee 100 units: 85 goes to the treasury (no certificate in the genesis parent), 10 to the treasury, 5 burned.
  // Issuance at height 1 (pool era): target 1 SNN, minus the 85 validator share, leaves 999,915 from the pool.
  assert.equal(L.balanceOf(s.fee.address), 0n);
  assert.equal(L.balanceOf(s.treasury.address), TREASURY + 10n + 85n + 999_915n);
  assert.equal(L.balanceOf(s.pool.address), POOL - 999_915n);
});

test("supply falls only by the burned amount", async () => {
  const s = await setup();
  const before = s.state0.ledger;
  const pay = await signedTransfer(s.alice, s.bob.address, "3", 0);
  const block1 = await sealed(s.state0, buildBlock({ height: 1, timestamp: T0 + 10, prevHash: s.genesis.hash, txs: [pay] }), s.genesis, s.config);
  const after = (await applyBlock(s.state0, block1, s.genesis, s.config)).ledger;
  assert.equal(before.totalBalance([]) - after.totalBalance([]), 5n); // the burn
});

test("issuance is paid to the parent certificate's signers, exactly, by weight", async () => {
  const s = await setup();
  const pay = await signedTransfer(s.alice, s.bob.address, "3", 0);
  const block1 = await sealed(s.state0, buildBlock({ height: 1, timestamp: T0 + 10, prevHash: s.genesis.hash, txs: [pay] }), s.genesis, s.config);
  const certified1 = await certify(block1, s.keys, [0, 1, 2]);
  const state1 = await applyBlock(s.state0, certified1, s.genesis, s.config);
  const block2 = await sealed(state1, buildBlock({ height: 2, timestamp: T0 + 20, prevHash: certified1.hash, txs: [] }), certified1, s.config);
  const state2 = await applyBlock(state1, block2, certified1, s.config);
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
  // Circulating: balances except pool, treasury, fee, minus what is still locked, taken before block 3.
  const excluded = [s.pool.address, s.treasury.address, s.fee.address];
  const circulating = state2.ledger.totalBalance(excluded) - lockedTotal(s.config, 3, excluded);
  const cap = (circulating * 100n) / (10_000n * 16n);
  const expected = cap < 250_000n ? cap : 250_000n;
  assert.equal(state3.ledger.totalBalance([]) - state2.ledger.totalBalance([]), expected);
  assert.equal(state3.ledger.balanceOf(s.pool.address), state2.ledger.balanceOf(s.pool.address));

  const signers = [s.keys[0], s.keys[1], s.keys[2]].map((k) => k.publicKey);
  const addrs = await Promise.all(signers.map((k) => addressFromPublicKey(fromHex(k))));
  const received = addrs.reduce((sum, a) => sum + (state3.ledger.balanceOf(a) - state2.ledger.balanceOf(a)), 0n);
  assert.equal(received, expected);
});

test("locked units cannot be spent before release, and can after", async () => {
  const s = await setup();
  const trial = await cloneState(s.state0);
  const early = await signedTransfer(s.founder, s.bob.address, "1", 0);
  // Height 1: the founder's whole allocation is still locked, so even 1 SNN is refused.
  await assert.rejects(applyUserTx(trial, early, s.config, 0n, 1), (err) => err.code === "LOCKED_FUNDS");

  const later = await cloneState(s.state0);
  // Height 15: the schedule has released everything (cliff 5 + duration 10).
  await applyUserTx(later, early, s.config, 0n, 15);
  assert.equal(later.ledger.balanceOf(s.founder.address), FOUNDER - 1_000_000n);
});

test("lockedAt follows the cliff, the cliff release, and the linear part", async () => {
  const entry = { units: 100n, cliff: 5n, cliffBps: 2500n, duration: 10n };
  assert.equal(lockedAt(entry, 4), 100n);   // before the cliff
  assert.equal(lockedAt(entry, 5), 75n);    // at the cliff: 25% released
  assert.equal(lockedAt(entry, 10), 38n);   // 25 + 75 * 5 / 10 = 62 released, 38 locked (integer rounding)
  assert.equal(lockedAt(entry, 15), 0n);    // fully released
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
  // Genesis, protocol and issue records survive a snapshot round trip.
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
