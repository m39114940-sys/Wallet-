// Treasury withdrawals inside chain validation (chain/core.js). Test fixtures only, not approved Genesis values.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateValidatorKey, DEFAULT_STAKE } from "../node/tools.js";
import { Ledger } from "../js/ledger.js";
import { createAccount, importSigningKey, toHex } from "../js/signing.js";
import { canonicalJson } from "../chain/crypto.js";
import { proposalMessage } from "../econ/treasury.js";
import {
  applyUserTx, cloneState, createGenesisConfig, genesisState, genesisBlock, normalizeTx, WITHDRAWAL_TYPE,
} from "../chain/core.js";
import { makeAccount } from "./helpers.js";

const CHAIN = "snn-treasury-chain-test";
const T0 = 1_700_000_000;
const EASY = "0000" + "f".repeat(60);
const POOL = 30_000_000_000_000n;
const TREASURY = 15_000_000_000_000n;
const FOUNDER = 5_000_000_000_000n;
const USER = 100_000_000n;
const FOREVER = "1000000000000";
const TIMELOCK = 10;
const WITHDRAW = 1_000_000n; // 1 SNN

const unlocked = { cliffBlocks: "0", cliffReleaseBps: "10000", durationBlocks: "0" };
const locked = { cliffBlocks: FOREVER, cliffReleaseBps: "0", durationBlocks: "0" };

async function signers(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = await createAccount();
    out.push({ pub: toHex(a.publicKey), key: await importSigningKey(a.privateKeyDer) });
  }
  return out;
}

// Builds a genesis with fixture economics. `treasuryVesting` decides whether the treasury balance is spendable.
// `withTreasury: false` builds a chain with no treasury block at all.
async function build({ treasuryVesting = unlocked, withTreasury = true } = {}) {
  const alice = await makeAccount();
  const fee = await makeAccount();
  const treasury = await makeAccount();
  const pool = await makeAccount();
  const founder = await makeAccount();
  const ops = await makeAccount();
  const keys = [];
  for (let i = 0; i < 4; i++) keys.push(await generateValidatorKey());
  const set = await signers(5);
  const genesisAllocations = [
    { address: alice.address, units: USER.toString(), vesting: unlocked },
    { address: pool.address, units: POOL.toString(), vesting: unlocked },
    { address: treasury.address, units: TREASURY.toString(), vesting: treasuryVesting },
    { address: founder.address, units: FOUNDER.toString(), vesting: locked },
    { address: ops.address, units: (100_000_000_000_000n - POOL - TREASURY - FOUNDER - USER).toString(), vesting: locked },
  ];
  const econ = {
    feeTiers: { quiet: "100", normal: "200", congested: "1000" },
    tierThresholdsBps: { normal: "2500", congested: "6000" },
    feeSplitBps: { validators: "8500", securityTreasury: "1000", burn: "500" },
    issuancePool: POOL.toString(),
    blockCapacity: "10",
    blocksPerPeriod: "4",
    securityTargetPerPeriod: "4000000",
    emissionBlocks: "2",
    periodsPerYear: "4",
    postTargetPerPeriod: "1000000",
    postCapBps: "100",
    feeAddress: fee.address,
    treasuryAddress: treasury.address,
    poolAddress: pool.address,
    genesisAllocations,
    ...(withTreasury ? { treasury: { signers: set.map((s) => s.pub), threshold: 3, timelockBlocks: TIMELOCK } } : {}),
  };
  const config = createGenesisConfig({
    chainId: CHAIN,
    timestamp: T0,
    allocations: [],
    validators: keys.map((k) => ({ publicKey: k.publicKey, stake: DEFAULT_STAKE })),
    maxShareBps: 4000,
    rules: "hybrid-v1",
    powTarget: EASY,
    stateRootV1: true,
    economics: econ,
  });
  return { alice, fee, treasury, config, set, state0: genesisState(config), genesis: genesisBlock(config) };
}

// A withdrawal transaction with `count` approvals from the first signers, executable at proposedAt + timelock.
async function withdrawal(env, { id = 1, count = 3, units = WITHDRAW, proposedAt = 1 } = {}) {
  const executeAfter = proposedAt + TIMELOCK;
  const to = env.alice.address;
  const approvals = [];
  for (const s of env.set.slice(0, count)) {
    const msg = proposalMessage({ id, to, units, executeAfter });
    approvals.push({ signer: s.pub, signature: toHex(new Uint8Array(await crypto.subtle.sign("Ed25519", s.key, msg))) });
  }
  return { type: WITHDRAWAL_TYPE, id, to, units: units.toString(), proposedAt, executeAfter, approvals };
}

test("a valid bundle after the timelock moves funds from the treasury to the recipient, with no fee", async () => {
  const env = await build();
  const state = await cloneState(env.state0);
  const tx = await withdrawal(env);
  await applyUserTx(state, tx, env.config, 500n, tx.executeAfter);
  assert.equal(state.ledger.balanceOf(env.alice.address), USER + WITHDRAW);
  assert.equal(state.ledger.balanceOf(env.treasury.address), TREASURY - WITHDRAW);
  assert.equal(state.ledger.balanceOf(env.fee.address), 0n, "withdrawals pay no user fee");
  assert.equal(state.ledger.hasWithdrawal(1), true);
});

test("the same withdrawal id cannot execute twice", async () => {
  const env = await build();
  const state = await cloneState(env.state0);
  const tx = await withdrawal(env);
  await applyUserTx(state, tx, env.config, 0n, tx.executeAfter);
  await assert.rejects(applyUserTx(state, tx, env.config, 0n, tx.executeAfter + 1), { code: "WITHDRAWAL_REPLAY" });
  assert.equal(state.ledger.balanceOf(env.treasury.address), TREASURY - WITHDRAW, "a refused replay moves nothing");
});

test("a withdrawal before the timelock is refused", async () => {
  const env = await build();
  const state = await cloneState(env.state0);
  const tx = await withdrawal(env);
  await assert.rejects(applyUserTx(state, tx, env.config, 0n, tx.executeAfter - 1), { code: "TIMELOCKED" });
});

test("two approvals are not enough", async () => {
  const env = await build();
  const state = await cloneState(env.state0);
  const tx = await withdrawal(env, { count: 2 });
  await assert.rejects(applyUserTx(state, tx, env.config, 0n, tx.executeAfter), { code: "NOT_ENOUGH_APPROVALS" });
});

test("a fully locked treasury cannot pay out", async () => {
  const env = await build({ treasuryVesting: locked });
  const state = await cloneState(env.state0);
  const tx = await withdrawal(env);
  await assert.rejects(applyUserTx(state, tx, env.config, 0n, tx.executeAfter), { code: "INSUFFICIENT_SPENDABLE" });
  assert.equal(state.ledger.hasWithdrawal(1), false);
});

test("a chain without a treasury block refuses withdrawals", async () => {
  const env = await build({ withTreasury: false });
  const state = await cloneState(env.state0);
  const tx = await withdrawal(env);
  await assert.rejects(applyUserTx(state, tx, env.config, 0n, tx.executeAfter), { code: "BAD_TX" });
});

test("a withdrawal is canonical: extra fields are not kept, so a block cannot smuggle them in", async () => {
  const env = await build();
  const tx = await withdrawal(env);
  assert.equal(canonicalJson(normalizeTx(tx)), canonicalJson(tx));
  assert.notEqual(canonicalJson({ ...tx, extra: "x" }), canonicalJson(normalizeTx({ ...tx, extra: "x" })));
});

test("withdrawal ids survive a snapshot reload, so a replay is still refused", async () => {
  const env = await build();
  const state = await cloneState(env.state0);
  const tx = await withdrawal(env);
  await applyUserTx(state, tx, env.config, 0n, tx.executeAfter);
  const reloaded = await Ledger.fromSnapshot(JSON.parse(JSON.stringify(state.ledger)));
  assert.equal(reloaded.hasWithdrawal(1), true);
  assert.equal(reloaded.balanceOf(env.treasury.address), TREASURY - WITHDRAW);
});
