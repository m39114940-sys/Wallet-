// Model F tests: isolated economy modules. Testnet only; no chain or node code is exercised here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveFlags, FLAG_NAMES } from "../econ/flags.js";
import { ModelFEconomy } from "../econ/economy.js";
import { splitFee } from "../econ/fees.js";
import { nextBaseFee } from "../econ/feecontroller.js";
import { issuanceAmount } from "../econ/issuance.js";
import { splitIssuance } from "../econ/ratio.js";
import { payValidators, distributeProportional, validatorQuorum } from "../econ/rewards.js";
import { TreasuryLedgers } from "../econ/ledgers.js";
import { EmergencyControl } from "../econ/emergency.js";
import { EconError } from "../econ/errors.js";
import { FEE_CONTROLLER, MAX_SUPPLY, UNIT } from "../econ/params.js";

const ALL_ON = Object.fromEntries(FLAG_NAMES.map((n) => [n, true]));
const SNN = (n) => BigInt(n) * UNIT;

function expectCode(fn, code) {
  assert.throws(fn, (err) => err instanceof EconError && err.code === code);
}

// Deterministic PRNG so the long run is reproducible.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s / 0x100000000;
  };
}

// ---- Flags ----

test("flags default to OFF and unknown or non-boolean values are refused", () => {
  const f = resolveFlags("testnet");
  assert.ok(FLAG_NAMES.every((n) => f[n] === false));
  expectCode(() => resolveFlags("testnet", { nope: true }), "UNKNOWN_FLAG");
  expectCode(() => resolveFlags("testnet", { feeEngine: "yes" }), "BAD_FLAG");
  expectCode(() => resolveFlags("devnet"), "BAD_NETWORK");
});

test("flag dependencies are enforced", () => {
  expectCode(() => resolveFlags("testnet", { feeEngine: true }), "FLAG_DEPENDENCY");
  expectCode(() => resolveFlags("testnet", { adaptiveIssuance: true, treasuryLedgers: true }), "FLAG_DEPENDENCY");
  assert.doesNotThrow(() => resolveFlags("testnet", ALL_ON));
});

test("Mainnet refuses any enabled flag and any initial supply", () => {
  expectCode(() => resolveFlags("mainnet", { validatorRewards: true }), "MAINNET_ACTIVATION_FORBIDDEN");
  expectCode(() => new ModelFEconomy({ network: "mainnet", initialCirculating: 1n }), "MAINNET_DISTRIBUTION_FORBIDDEN");
  expectCode(() => new ModelFEconomy({ network: "mainnet", issuanceBudget: 1n }), "MAINNET_DISTRIBUTION_FORBIDDEN");
  const inert = new ModelFEconomy({ network: "mainnet" });
  assert.equal(inert.issued, 0n);
});

// ---- Inert default ----

test("with every flag off the economy is inert and refuses fees it would ignore", () => {
  const e = new ModelFEconomy({ initialCirculating: SNN(1000) });
  const r = e.processBlock({ utilBps: 10_000n });
  assert.equal(r.issued, 0n);
  assert.equal(r.feesCollected, 0n);
  assert.equal(e.baseFee, FEE_CONTROLLER.minFee);
  assert.equal(e.circulating, SNN(1000));
  assert.equal(e.issued, SNN(1000));
  expectCode(() => e.processBlock({ txFees: [1n] }), "FEE_ENGINE_OFF");
});

// ---- Fee split ----

test("fee split is exact for many values and the remainder is burned", () => {
  const next = rng(7);
  for (let i = 0; i < 2000; i++) {
    const fee = BigInt(Math.floor(next() * 1e12));
    const s = splitFee(fee, { burnEnabled: true });
    assert.equal(s.validators + s.treasury + s.burn + s.operations, fee);
    assert.equal(s.operations, 0n);
    assert.ok(s.burn >= 0n && s.validators >= 0n && s.treasury >= 0n);
  }
});

test("with burn off the remainder goes to operations, not burned", () => {
  const s = splitFee(1_000_003n, { burnEnabled: false });
  assert.equal(s.burn, 0n);
  assert.equal(s.validators + s.treasury + s.operations, 1_000_003n);
  assert.ok(s.operations > 0n);
});

// ---- Dynamic fee ----

test("base fee rises at most 50% and falls at most 12.5% per step, inside bounds", () => {
  const start = SNN(1) / 2n;
  const up = nextBaseFee(start, 10_000n);
  assert.ok(up <= (start * 15_000n) / 10_000n && up > start);
  const down = nextBaseFee(start, 0n);
  assert.equal(down, (start * 8_750n) / 10_000n);
  assert.equal(nextBaseFee(start, FEE_CONTROLLER.targetUtilBps), start);
  assert.equal(nextBaseFee(FEE_CONTROLLER.maxFee, 10_000n), FEE_CONTROLLER.maxFee);
  assert.equal(nextBaseFee(FEE_CONTROLLER.minFee, 0n), FEE_CONTROLLER.minFee);
});

test("sustained full spam cannot push the base fee above the maximum", () => {
  const e = new ModelFEconomy({ network: "testnet", flags: ALL_ON, initialCirculating: SNN(1_000_000) });
  for (let i = 0; i < 300; i++) {
    const r = e.processBlock({ utilBps: 10_000n });
    assert.ok(r.baseFeeAfter <= FEE_CONTROLLER.maxFee);
    assert.ok(r.baseFeeAfter <= (r.baseFeeBefore * 15_000n) / 10_000n);
  }
  assert.equal(e.baseFee, FEE_CONTROLLER.maxFee);
});

test("an empty chain cannot push the base fee below the minimum", () => {
  const e = new ModelFEconomy({ network: "testnet", flags: ALL_ON, initialCirculating: SNN(1000) });
  for (let i = 0; i < 50; i++) e.processBlock({ utilBps: 0n });
  assert.equal(e.baseFee, FEE_CONTROLLER.minFee);
});

// ---- Ledgers ----

test("ledgers are separate: no transfer method, no unapproved or oversized spend", () => {
  const L = new TreasuryLedgers();
  L.credit("security", SNN(10));
  assert.equal(L.transfer, undefined);
  expectCode(() => L.debit("security", SNN(1), undefined), "UNAPPROVED_SPEND");
  expectCode(() => L.debit("security", SNN(1), { ledger: "operations", units: SNN(1), approvedBy: "board" }), "UNAPPROVED_SPEND");
  expectCode(() => L.debit("security", SNN(1), { ledger: "security", units: SNN(2), approvedBy: "board" }), "UNAPPROVED_SPEND");
  expectCode(() => L.debit("security", SNN(1), { ledger: "security", units: SNN(1), approvedBy: "" }), "UNAPPROVED_SPEND");
  expectCode(() => L.debit("security", SNN(11), { ledger: "security", units: SNN(11), approvedBy: "board" }), "INSUFFICIENT_LEDGER");
  L.debit("security", SNN(4), { ledger: "security", units: SNN(4), approvedBy: "board" });
  assert.equal(L.balance("security"), SNN(6));
  assert.equal(L.balance("development"), 0n);
  expectCode(() => L.credit("reserve", 1n), "BAD_LEDGER");
});

// ---- Issuance ----

test("issuance is the minimum of deficit, budget, 1% of circulating and remaining supply", () => {
  const base = { deficit: SNN(100), remainingBudget: SNN(100), circulating: SNN(10_000), remainingSupply: SNN(100) };
  assert.equal(issuanceAmount(base), SNN(100));
  assert.equal(issuanceAmount({ ...base, remainingBudget: SNN(3) }), SNN(3));
  assert.equal(issuanceAmount({ ...base, circulating: SNN(200) }), SNN(2));
  assert.equal(issuanceAmount({ ...base, remainingSupply: SNN(1) }), SNN(1));
  assert.equal(issuanceAmount({ ...base, deficit: 0n }), 0n);
  assert.equal(issuanceAmount({ ...base, remainingBudget: 0n }), 0n);
});

test("issuance never takes supply past the maximum, even with a huge budget", () => {
  const e = new ModelFEconomy({
    network: "testnet",
    flags: ALL_ON,
    initialCirculating: MAX_SUPPLY - SNN(10),
    issuanceBudget: SNN(10), // constructor forbids initial + budget above the ceiling, so the budget is exactly what remains
    securityBudgetPerBlock: SNN(1000),
    epochBlocks: 1,
  });
  for (let i = 0; i < 20; i++) e.processBlock({});
  assert.ok(e.issued <= MAX_SUPPLY);
  assert.equal(e.issued, MAX_SUPPLY);
});

test("a constructor cannot exceed the supply ceiling", () => {
  expectCode(() => new ModelFEconomy({ network: "testnet", initialCirculating: MAX_SUPPLY, issuanceBudget: 1n }), "SUPPLY_CEILING");
});

test("a security deficit with no budget is reported as underfunded, not silently filled", () => {
  const e = new ModelFEconomy({
    network: "testnet",
    flags: ALL_ON,
    initialCirculating: SNN(1000),
    issuanceBudget: 0n,
    securityBudgetPerBlock: SNN(2),
  });
  const r = e.processBlock({});
  assert.equal(r.deficit, SNN(2));
  assert.equal(r.issued, 0n);
});

test("PoW/PoS split is exact, and invalid ratios are refused", () => {
  const s = splitIssuance(1_000_001n, 5_000n);
  assert.equal(s.pow + s.pos, 1_000_001n);
  assert.deepEqual(splitIssuance(999n, 0n), { pow: 0n, pos: 999n });
  assert.deepEqual(splitIssuance(999n, 10_000n), { pow: 999n, pos: 0n });
  expectCode(() => splitIssuance(1n, 10_001n), "BAD_BPS");
});

// ---- Validator rewards and quorum ----

test("quorum is exactly two-thirds: met at the boundary, missed just below", () => {
  const at = [
    { id: "a", weight: 1n, signed: true },
    { id: "b", weight: 1n, signed: true },
    { id: "c", weight: 1n, signed: false },
  ];
  assert.equal(validatorQuorum(at).meetsQuorum, true);
  const below = [
    { id: "a", weight: 1n, signed: true },
    { id: "b", weight: 1n, signed: false },
    { id: "c", weight: 1n, signed: false },
  ];
  assert.equal(validatorQuorum(below).meetsQuorum, false);
  assert.equal(validatorQuorum([]).meetsQuorum, false);
});

test("below quorum nothing is paid and the whole pool is kept", () => {
  const r = payValidators(1000n, [
    { id: "a", weight: 1n, signed: true },
    { id: "b", weight: 2n, signed: false },
  ]);
  assert.equal(r.quorumMet, false);
  assert.equal(r.paidTotal, 0n);
  assert.equal(r.remainder, 1000n);
});

test("payouts are proportional to signed weight, rounding down with the remainder kept", () => {
  const d = distributeProportional(100n, [
    { id: "a", weight: 1n },
    { id: "b", weight: 1n },
    { id: "c", weight: 1n },
  ]);
  assert.equal(d.paidTotal, 99n);
  assert.equal(d.remainder, 1n);
  assert.equal(d.paidTotal + d.remainder, 100n);
});

test("duplicate ids and zero or missing weights are refused (basic Sybil and spam guard for the set)", () => {
  expectCode(() => validatorQuorum([{ id: "a", weight: 1n, signed: true }, { id: "a", weight: 1n, signed: true }]), "DUPLICATE_PARTICIPANT");
  expectCode(() => validatorQuorum([{ id: "a", weight: 0n, signed: true }]), "BAD_WEIGHT");
  expectCode(() => distributeProportional(10n, [{ id: "a", weight: 1 }]), "BAD_WEIGHT");
});

// ---- Emergency controls ----

test("only authorised parties can pause, and a pause halts issuance and fee updates", () => {
  const e = new ModelFEconomy({
    network: "testnet",
    flags: ALL_ON,
    initialCirculating: SNN(1000),
    issuanceBudget: SNN(100),
    securityBudgetPerBlock: SNN(1),
    epochBlocks: 1,
    emergencyAuthorizers: ["ops-1"],
  });
  expectCode(() => e.pause({ by: "mallory", reason: "x" }), "UNAUTHORIZED");
  expectCode(() => e.pause({ by: "ops-1", reason: "" }), "NO_REASON");
  e.pause({ by: "ops-1", reason: "drill" });
  const paused = e.processBlock({ utilBps: 10_000n });
  assert.equal(paused.paused, true);
  assert.equal(paused.issued, 0n);
  assert.equal(paused.baseFeeAfter, FEE_CONTROLLER.minFee);
  e.resume({ by: "ops-1", reason: "drill over" });
  const resumed = e.processBlock({ utilBps: 10_000n });
  // The deficit from the paused block is not lost: it is carried into the epoch that closes on resume.
  assert.equal(resumed.issued, SNN(2));
  assert.equal(e.epochDeficit, 0n);
});

test("issuance is decided once per epoch, not on every block", () => {
  const e = new ModelFEconomy({
    network: "testnet",
    flags: ALL_ON,
    initialCirculating: SNN(1000),
    issuanceBudget: SNN(100),
    securityBudgetPerBlock: SNN(2),
    epochBlocks: 5,
  });
  for (let i = 1; i <= 4; i++) {
    const r = e.processBlock({});
    assert.equal(r.issued, 0n);
    assert.equal(r.epochClosed, false);
  }
  const closing = e.processBlock({});
  assert.equal(closing.epochClosed, true);
  assert.equal(closing.issued, SNN(10)); // 5 blocks x 2 SNN deficit = 10 SNN, equal to 1% of 1000 SNN
  assert.equal(e.blocksInEpoch, 0);
});

test("the per-epoch cap bounds issuance even when the deficit is huge", () => {
  const e = new ModelFEconomy({
    network: "testnet",
    flags: ALL_ON,
    initialCirculating: SNN(1000),
    issuanceBudget: SNN(1_000_000),
    securityBudgetPerBlock: SNN(1_000_000),
    epochBlocks: 1,
  });
  const r = e.processBlock({});
  assert.equal(r.issued, SNN(10));
});

test("a rejected block changes no state at all", () => {
  const e = new ModelFEconomy({ network: "testnet", flags: ALL_ON, initialCirculating: SNN(1000), epochBlocks: 1 });
  const before = JSON.stringify(e.snapshot());
  expectCode(
    () => e.processBlock({
      txFees: [SNN(1)],
      validators: [{ id: "a", weight: 1n, signed: true }, { id: "a", weight: 1n, signed: true }],
    }),
    "DUPLICATE_PARTICIPANT",
  );
  assert.equal(JSON.stringify(e.snapshot()), before);
});

test("fees above circulating supply are rejected without touching state", () => {
  const e = new ModelFEconomy({ network: "testnet", flags: ALL_ON, initialCirculating: SNN(1000), epochBlocks: 1 });
  const before = JSON.stringify(e.snapshot());
  expectCode(() => e.processBlock({ txFees: [SNN(2000)] }), "FEES_EXCEED_CIRCULATING");
  assert.equal(JSON.stringify(e.snapshot()), before);
});

test("epochBlocks must be a positive integer", () => {
  expectCode(() => new ModelFEconomy({ network: "testnet", epochBlocks: 0 }), "BAD_EPOCH");
  expectCode(() => new ModelFEconomy({ network: "testnet", epochBlocks: 1.5 }), "BAD_EPOCH");
});

test("pause is refused when emergencyControls is off, and the control cannot move supply", () => {
  const off = new ModelFEconomy({ network: "testnet", emergencyAuthorizers: ["ops-1"] });
  expectCode(() => off.pause({ by: "ops-1", reason: "x" }), "FLAG_OFF");
  const em = new EmergencyControl(["ops-1"]);
  em.pause({ by: "ops-1", reason: "x" });
  assert.equal(em.paused, true);
  assert.equal(em.history.length, 1);
});

// ---- Full-economy invariants ----

test("a long randomised run keeps the supply invariant on every block", () => {
  const next = rng(42);
  const e = new ModelFEconomy({
    network: "testnet",
    flags: ALL_ON,
    initialCirculating: SNN(1_000_000),
    issuanceBudget: SNN(5_000_000),
    securityBudgetPerBlock: SNN(3),
    epochBlocks: 10,
    emergencyAuthorizers: ["ops-1"],
  });
  const validators = [1n, 2n, 3n, 4n, 5n].map((w, i) => ({ id: `v${i}`, weight: w, signed: false }));
  const miners = [{ id: "m1", weight: 2n }, { id: "m2", weight: 3n }];
  for (let block = 0; block < 500; block++) {
    const txCount = Math.floor(next() * 20);
    const txFees = Array.from({ length: txCount }, () => BigInt(Math.floor(next() * 5000)));
    const utilBps = BigInt(Math.floor(next() * 10_001));
    const vs = validators.map((v) => ({ ...v, signed: next() < 0.8 }));
    if (block === 250) e.pause({ by: "ops-1", reason: "mid-run drill" });
    if (block === 300) e.resume({ by: "ops-1", reason: "drill over" });
    const r = e.processBlock({ txFees, utilBps, validators: vs, miners });
    assert.ok(e.issued <= MAX_SUPPLY);
    assert.ok(r.baseFeeAfter >= FEE_CONTROLLER.minFee && r.baseFeeAfter <= FEE_CONTROLLER.maxFee);
    assert.equal(e.issued - e.burned, e.circulating + e.ledgers.total() + e.validatorPool + e.miningPool);
  }
  assert.ok(e.issued > SNN(1_000_000), "issuance should have occurred");
  assert.ok(e.burned > 0n, "burn should have occurred");
  assert.ok(e.ledgers.balance("security") > 0n, "security ledger should have been funded by fees");
});

test("snapshot exposes strings and no Number values for money", () => {
  const e = new ModelFEconomy({ network: "testnet", flags: ALL_ON, initialCirculating: SNN(5) });
  const s = e.snapshot();
  assert.equal(typeof s.issued, "string");
  assert.equal(typeof s.baseFee, "string");
  assert.equal(s.ledgers.security, "0");
});
