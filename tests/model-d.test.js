import { test } from "node:test";
import assert from "node:assert/strict";
import { BLOCKS_PER_YEAR, EMISSION_BLOCKS, MODEL_D_VESTING, TREASURY_TIMELOCK_BLOCKS, modelDVesting } from "../econ/model-d.js";

test("block constants match the approved 10 s, 720-block epoch timing", () => {
  assert.equal(BLOCKS_PER_YEAR, 3_153_600);
  assert.equal(EMISSION_BLOCKS, 31_536_000);
});

test("founder, company and team: 0% in year one, 25% at the cliff, 75% linear over 3 years", () => {
  for (const name of ["founder", "company", "team"]) {
    const v = modelDVesting(name);
    assert.equal(v.cliffBlocks, 3_153_600);
    assert.equal(v.cliffReleaseBps, 2_500);
    assert.equal(v.durationBlocks, 9_460_800);
  }
});

test("treasury timelock is one week of blocks", () => {
  assert.equal(TREASURY_TIMELOCK_BLOCKS, 60_480);
});

test("liquidity locked for 12 months then fully released; entries are copies", () => {
  const v = modelDVesting("liquidity");
  assert.equal(v.cliffBlocks, 3_153_600);
  assert.equal(v.cliffReleaseBps, 10_000);
  v.cliffBlocks = 0;
  assert.equal(MODEL_D_VESTING.liquidity.cliffBlocks, 3_153_600);
});

test("unknown names are refused rather than defaulted", () => {
  assert.throws(() => modelDVesting("unknown"), /no vesting rule/);
});
