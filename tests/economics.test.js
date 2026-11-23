import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EconError, validateParams, feeForUtilisation, splitFee, issuanceFor, settlePeriod, BPS_DENOMINATOR,
} from "../econ/rules.js";

// Test fixtures only. These are not approved economic values and are not used anywhere in the chain.
const PARAMS = {
  feeTiers: { quiet: 100n, normal: 200n, congested: 1000n },        // micro-SNN per tx
  tierThresholdsBps: { normal: 2500n, congested: 6000n },
  feeSplitBps: { validators: 8500n, securityTreasury: 1000n, burn: 500n },
  issuancePool: 30_000_000_000_000n,                                  // micro-SNN
};
const STATE0 = { pool: PARAMS.issuancePool, issued: 0n, burned: 0n, treasuryFromFees: 0n, validatorIncome: 0n };

test("rejects missing or malformed parameters", () => {
  assert.throws(() => validateParams(undefined), EconError);
  assert.throws(() => validateParams({ ...PARAMS, feeTiers: { quiet: 100, normal: 200n, congested: 1000n } }), EconError);
  assert.throws(() => validateParams({ ...PARAMS, feeTiers: { quiet: 300n, normal: 200n, congested: 1000n } }), EconError);
  assert.throws(() => validateParams({ ...PARAMS, tierThresholdsBps: { normal: 7000n, congested: 6000n } }), EconError);
  assert.throws(() => validateParams({ ...PARAMS, feeSplitBps: { validators: 8500n, securityTreasury: 1000n, burn: 600n } }), EconError);
  assert.throws(() => validateParams({ ...PARAMS, issuancePool: -1n }), EconError);
  assert.equal(validateParams(PARAMS), true);
});

test("fee tier follows utilisation thresholds, including boundaries", () => {
  assert.equal(feeForUtilisation(0n, PARAMS), 100n);
  assert.equal(feeForUtilisation(2499n, PARAMS), 100n);
  assert.equal(feeForUtilisation(2500n, PARAMS), 200n);
  assert.equal(feeForUtilisation(5999n, PARAMS), 200n);
  assert.equal(feeForUtilisation(6000n, PARAMS), 1000n);
  assert.equal(feeForUtilisation(20_000n, PARAMS), 1000n);
});

test("fee split sums exactly to the fee for many values", () => {
  let seed = 12345n;
  for (let i = 0; i < 2000; i++) {
    seed = (seed * 1103515245n + 12345n) % 2147483648n;
    const fee = seed * 37n;
    const s = splitFee(fee, PARAMS.feeSplitBps);
    assert.equal(s.validators + s.securityTreasury + s.burn, fee);
    assert.ok(s.validators >= 0n && s.securityTreasury >= 0n && s.burn >= 0n);
  }
});

test("fee split matches the configured percentages on a round amount", () => {
  assert.deepEqual(splitFee(10_000n, PARAMS.feeSplitBps), { validators: 8500n, securityTreasury: 1000n, burn: 500n });
});

test("issuance tops validator income up to the target and is capped by the pool", () => {
  assert.deepEqual(issuanceFor({ validatorFeeShare: 300n, target: 1000n, pool: 5000n }), { issuance: 700n, deficit: 0n });
  assert.deepEqual(issuanceFor({ validatorFeeShare: 1500n, target: 1000n, pool: 5000n }), { issuance: 0n, deficit: 0n });
  assert.deepEqual(issuanceFor({ validatorFeeShare: 0n, target: 1000n, pool: 400n }), { issuance: 400n, deficit: 600n });
  assert.deepEqual(issuanceFor({ validatorFeeShare: 0n, target: 1000n, pool: 0n }), { issuance: 0n, deficit: 1000n });
});

test("settlePeriod conserves value and never issues more than the pool", () => {
  const period = { demand: 3000n, capacity: 10_000n, securityTargetPerPeriod: 500_000n };
  const { state, report } = settlePeriod(STATE0, period, PARAMS);
  assert.equal(report.feesTotal, report.validatorFeeShare + report.securityTreasuryShare + report.burned);
  assert.equal(state.pool + state.issued, PARAMS.issuancePool);
  assert.equal(state.burned, report.burned);
  assert.equal(state.treasuryFromFees, report.securityTreasuryShare);
  assert.equal(state.validatorIncome, report.validatorFeeShare + report.issuance);
});

test("settlePeriod does not mutate its input and is deterministic", () => {
  const snapshot = { ...STATE0 };
  const period = { demand: 9000n, capacity: 10_000n, securityTargetPerPeriod: 500_000n };
  const a = settlePeriod(STATE0, period, PARAMS);
  const b = settlePeriod(STATE0, period, PARAMS);
  assert.deepEqual(STATE0, snapshot);
  assert.deepEqual(a, b);
});

test("settlePeriod processes at most capacity and prices congestion at the top tier", () => {
  const { report } = settlePeriod(STATE0, { demand: 50_000n, capacity: 10_000n, securityTargetPerPeriod: 0n }, PARAMS);
  assert.equal(report.processed, 10_000n);
  assert.equal(report.fee, 1000n);
  assert.equal(report.feesTotal, 10_000_000n);
});

test("settlePeriod reports a deficit when the pool is exhausted", () => {
  const empty = { ...STATE0, pool: 0n };
  const { state, report } = settlePeriod(empty, { demand: 0n, capacity: 10_000n, securityTargetPerPeriod: 1000n }, PARAMS);
  assert.equal(report.issuance, 0n);
  assert.equal(report.deficit, 1000n);
  assert.equal(state.pool, 0n);
});

test("settlePeriod rejects invalid period inputs", () => {
  assert.throws(() => settlePeriod(STATE0, { demand: 1n, capacity: 0n, securityTargetPerPeriod: 0n }, PARAMS), EconError);
  assert.throws(() => settlePeriod(STATE0, { demand: -1n, capacity: 10n, securityTargetPerPeriod: 0n }, PARAMS), EconError);
  assert.throws(() => settlePeriod({ ...STATE0, pool: -1n }, { demand: 1n, capacity: 10n, securityTargetPerPeriod: 0n }, PARAMS), EconError);
});

test("basis-point denominator is 10000", () => {
  assert.equal(BPS_DENOMINATOR, 10_000n);
});
