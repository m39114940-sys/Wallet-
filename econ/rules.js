// Fee and issuance rules for SmartNode Network. Pure functions only.
//
// This module does not touch chain state, blocks, Genesis, Testnet, or Mainnet.
// It is not called by chain/, node/, or js/. Wiring it into consensus is a separate
// decision that needs its own approval.
//
// No economic value is defined here. Every amount, tier, split and target must be
// passed in explicitly, and missing or invalid values are rejected. Amounts are in
// micro-SNN (1 SNN = 1,000,000 units, as in js/ledger.js) and use BigInt, so no
// rounding loss occurs.

export const BPS_DENOMINATOR = 10_000n;

export class EconError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EconError";
    this.code = code;
  }
}

const fail = (message) => {
  throw new EconError("BAD_ECON_PARAMS", message);
};

const isUnits = (value) => typeof value === "bigint" && value >= 0n;
const isBps = (value) => typeof value === "bigint" && value >= 0n && value <= BPS_DENOMINATOR;

// params = {
//   feeTiers:          { quiet, normal, congested }        micro-SNN per transaction
//   tierThresholdsBps: { normal, congested }               utilisation in basis points
//   feeSplitBps:       { validators, securityTreasury, burn }  must sum to 10000
//   issuancePool:      micro-SNN still available for supplementary issuance
// }
export function validateParams(params) {
  if (!params || typeof params !== "object") fail("المعاملات مفقودة.");
  const { feeTiers, tierThresholdsBps, feeSplitBps } = params;
  if (!feeTiers || !isUnits(feeTiers.quiet) || !isUnits(feeTiers.normal) || !isUnits(feeTiers.congested)) {
    fail("فئات الرسوم يجب أن تكون قيماً صحيحة غير سالبة.");
  }
  if (!(feeTiers.quiet <= feeTiers.normal && feeTiers.normal <= feeTiers.congested)) {
    fail("فئات الرسوم يجب أن تكون مرتبة: هادئة ≤ طبيعية ≤ مزدحمة.");
  }
  if (!tierThresholdsBps || !isBps(tierThresholdsBps.normal) || !isBps(tierThresholdsBps.congested)) {
    fail("عتبات الازدحام يجب أن تكون بين 0 و10000 نقطة أساس.");
  }
  if (tierThresholdsBps.normal > tierThresholdsBps.congested) fail("عتبة الطبيعي يجب ألا تتجاوز عتبة المزدحم.");
  if (!feeSplitBps || !isBps(feeSplitBps.validators) || !isBps(feeSplitBps.securityTreasury) || !isBps(feeSplitBps.burn)) {
    fail("توزيع الرسوم يجب أن يكون نقاط أساس صحيحة.");
  }
  if (feeSplitBps.validators + feeSplitBps.securityTreasury + feeSplitBps.burn !== BPS_DENOMINATOR) {
    fail("توزيع الرسوم يجب أن يساوي 10000 نقطة أساس بالضبط.");
  }
  if (!isUnits(params.issuancePool)) fail("مجمع الإصدار يجب أن يكون قيمة صحيحة غير سالبة.");
  return true;
}

// Fee per transaction for a utilisation level in basis points (demand / capacity).
export function feeForUtilisation(utilisationBps, params) {
  validateParams(params);
  if (!isUnits(utilisationBps)) fail("نسبة الازدحام يجب أن تكون قيمة صحيحة غير سالبة.");
  const { feeTiers, tierThresholdsBps } = params;
  if (utilisationBps < tierThresholdsBps.normal) return feeTiers.quiet;
  if (utilisationBps < tierThresholdsBps.congested) return feeTiers.normal;
  return feeTiers.congested;
}

// Splits a total fee exactly. Validators receive the remainder, so the three parts always sum to the fee.
export function splitFee(fee, feeSplitBps) {
  if (!isUnits(fee)) fail("الرسم يجب أن يكون قيمة صحيحة غير سالبة.");
  const securityTreasury = (fee * feeSplitBps.securityTreasury) / BPS_DENOMINATOR;
  const burn = (fee * feeSplitBps.burn) / BPS_DENOMINATOR;
  const validators = fee - securityTreasury - burn;
  return { validators, securityTreasury, burn };
}

// Supplementary issuance: tops validator fee income up to the target, capped by the remaining pool.
export function issuanceFor({ validatorFeeShare, target, pool }) {
  if (!isUnits(validatorFeeShare) || !isUnits(target) || !isUnits(pool)) {
    fail("قيم الإصدار يجب أن تكون صحيحة غير سالبة.");
  }
  const shortfall = target > validatorFeeShare ? target - validatorFeeShare : 0n;
  const issuance = shortfall < pool ? shortfall : pool;
  return { issuance, deficit: shortfall - issuance };
}

// Settles one period. Returns a new state and does not modify the input.
//   state:   { pool, issued, burned, treasuryFromFees, validatorIncome }
//   period:  { demand, capacity, securityTargetPerPeriod } in micro-SNN for amounts, counts for demand
export function settlePeriod(state, period, params) {
  validateParams(params);
  for (const key of ["pool", "issued", "burned", "treasuryFromFees", "validatorIncome"]) {
    if (!isUnits(state[key])) fail(`الحالة ${key} غير صالحة.`);
  }
  if (!isUnits(period.demand) || !isUnits(period.capacity) || period.capacity === 0n) {
    fail("الطلب والسعة يجب أن يكونا قيمتين صحيحتين، والسعة أكبر من صفر.");
  }
  if (!isUnits(period.securityTargetPerPeriod)) fail("هدف الأمن يجب أن يكون قيمة صحيحة غير سالبة.");

  const processed = period.demand < period.capacity ? period.demand : period.capacity;
  const utilisationBps = (period.demand * BPS_DENOMINATOR) / period.capacity;
  const fee = feeForUtilisation(utilisationBps, params);
  const feesTotal = processed * fee;
  const split = splitFee(feesTotal, params.feeSplitBps);
  const { issuance, deficit } = issuanceFor({
    validatorFeeShare: split.validators,
    target: period.securityTargetPerPeriod,
    pool: state.pool,
  });

  return {
    state: {
      pool: state.pool - issuance,
      issued: state.issued + issuance,
      burned: state.burned + split.burn,
      treasuryFromFees: state.treasuryFromFees + split.securityTreasury,
      validatorIncome: state.validatorIncome + split.validators + issuance,
    },
    report: {
      processed,
      fee,
      feesTotal,
      validatorFeeShare: split.validators,
      securityTreasuryShare: split.securityTreasury,
      burned: split.burn,
      issuance,
      deficit,
    },
  };
}
