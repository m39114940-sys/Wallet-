// SNN chain core: blocks, commit certificates, double-sign evidence and state transitions.
// Everything here is deterministic and shared by every node: the same genesis and the same
// certified blocks always produce the same state.
//
// State: { ledger, stakes: Map<publicKey, bigint>, jailed: Set<publicKey> }
// Stakes and weights are integers (micro-SNN units), so slashing and quorum use exact arithmetic.

import { validateWork, mine, nextTarget, PowError } from "./pow.js";
import { Ledger, LedgerError, TESTNET_FAUCET_UNITS, parseAmount, formatAmount } from "../js/ledger.js";
import { capWeights, DEFAULT_MAX_SHARE_BPS, hasQuorum, sumOf } from "./weights.js";
import { sha256Hex, canonicalJson, verifyText } from "./crypto.js";
import { compositeStateRoot } from "./stateroot.js";
import { EvmAccounts } from "../evm/state.js";
import { applyTransferEntry } from "../evm/transfer.js";
import { EVM_CHAIN_IDS } from "../evm/params.js";
import { EvmError } from "../evm/errors.js";
import { validateParams, feeForUtilisation, splitFee, issuanceFor, BPS_DENOMINATOR, EconError } from "../econ/rules.js";
import { addressFromPublicKey, fromHex } from "../js/signing.js";
import { validateTreasuryConfig, verifyWithdrawalBundle, applyWithdrawal, TreasuryError } from "../econ/treasury.js";
import { isValidAddress } from "../js/ledger.js";

export const GENESIS_PREV_HASH = "0".repeat(64);
export const SLASH_PERCENT = 5n; // double signing burns 5% of the stake and jails the validator
export const NIL = "nil"; // vote for "no block"
export const MAX_CLOCK_DRIFT_MS = 15_000; // a new block may not be stamped more than this far ahead of our clock
export const EVIDENCE_TYPES = ["prevote", "precommit"];

const HEX_64 = /^[0-9a-f]{64}$/;
const DECIMAL_STAKE = /^[1-9][0-9]*$/;

export class ChainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ChainError";
    this.code = code;
  }
}

// ---------- Transactions ----------

// Only these fields exist in a transaction. Amounts are rewritten to one canonical decimal form,
// so "2.5" and "2.50" cannot produce two different transaction ids for the same transfer.
export const WITHDRAWAL_TYPE = "treasury-withdraw";
export const isWithdrawal = (tx) => tx !== null && typeof tx === "object" && tx.type === WITHDRAWAL_TYPE;

// Treasury withdrawal: carries the proposal and its signer approvals. Verified in applyTreasuryWithdrawal.
function normalizeWithdrawal(tx) {
  if (!Number.isSafeInteger(tx.id) || tx.id <= 0) throw new ChainError("BAD_TX", "رقم السحب غير صالح.");
  if (typeof tx.to !== "string") throw new ChainError("BAD_TX", "مستلم السحب مطلوب.");
  if (typeof tx.units !== "string" || !/^[1-9][0-9]*$/.test(tx.units)) throw new ChainError("BAD_TX", "مبلغ السحب غير صالح.");
  if (!Number.isSafeInteger(tx.proposedAt) || !Number.isSafeInteger(tx.executeAfter)) throw new ChainError("BAD_TX", "ارتفاعات السحب غير صالحة.");
  if (!Array.isArray(tx.approvals)) throw new ChainError("BAD_TX", "قائمة موافقات السحب مطلوبة.");
  return {
    type: WITHDRAWAL_TYPE,
    id: tx.id,
    to: tx.to,
    units: tx.units,
    proposedAt: tx.proposedAt,
    executeAfter: tx.executeAfter,
    approvals: tx.approvals.map((a) => {
      if (a === null || typeof a !== "object") throw new ChainError("BAD_TX", "موافقة السحب غير صالحة.");
      return { signer: a.signer, signature: a.signature };
    }),
  };
}

export function normalizeTx(tx) {
  if (tx === null || typeof tx !== "object") throw new ChainError("BAD_TX", "المعاملة غير صالحة.");
  if (isWithdrawal(tx)) return normalizeWithdrawal(tx);
  return {
    from: tx.from,
    to: tx.to,
    amount: formatAmount(parseAmount(tx.amount)),
    nonce: tx.nonce,
    publicKey: tx.publicKey,
    signature: tx.signature,
  };
}

export const txId = (tx) => sha256Hex(canonicalJson(normalizeTx(tx)));

// Merkle root with the last leaf duplicated on odd levels. An empty list hashes the empty string.
export function merkleRoot(hashes) {
  if (hashes.length === 0) return sha256Hex("");
  let level = hashes;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] ?? left;
      next.push(sha256Hex(left + right));
    }
    level = next;
  }
  return level[0];
}

// ---------- Messages that validators sign ----------

// The chain id prevents replay on another network. The vote type is "prevote", "precommit", or NIL as target.
export const voteMessage = (chainId, type, height, round, blockHash) =>
  `SNN-VOTE-v1|${chainId}|${type}|${height}|${round}|${blockHash}`;

export const proposalMessage = (chainId, height, round, polkaRound, blockHash) =>
  `SNN-PROPOSAL-v1|${chainId}|${height}|${round}|${polkaRound}|${blockHash}`;

// ---------- Evidence of double signing ----------

// Two different votes of one type from one validator, for the same height and round.
// A prevote pair and a precommit pair are both punished the same way.
export function normalizeEvidence(ev) {
  if (ev === null || typeof ev !== "object") throw new ChainError("BAD_EVIDENCE", "دليل التوقيع المزدوج غير صالح.");
  const { type, validator, height, round, blockA, signatureA, blockB, signatureB } = ev;
  const ok =
    EVIDENCE_TYPES.includes(type) &&
    typeof validator === "string" &&
    Number.isInteger(height) &&
    height >= 0 &&
    Number.isInteger(round) &&
    round >= 0 &&
    typeof blockA === "string" &&
    typeof blockB === "string" &&
    typeof signatureA === "string" &&
    typeof signatureB === "string";
  if (!ok) throw new ChainError("BAD_EVIDENCE", "شكل دليل التوقيع المزدوج غير صالح.");
  return { type, validator, height, round, blockA, signatureA, blockB, signatureB };
}

export const evidenceKey = (ev) => `${ev.validator}|${ev.type}|${ev.height}|${ev.round}`;

// The caller decides the height limit, because the rule depends on which block would include the evidence.
export async function verifyEvidence(evRaw, chainId, state) {
  const ev = normalizeEvidence(evRaw);
  if (ev.blockA === ev.blockB) throw new ChainError("BAD_EVIDENCE", "الدليل لا يثبت تناقضاً.");
  if (!state.stakes.has(ev.validator) || state.jailed.has(ev.validator)) {
    throw new ChainError("BAD_EVIDENCE", "المدقق غير نشط.");
  }
  const okA = await verifyText(ev.validator, voteMessage(chainId, ev.type, ev.height, ev.round, ev.blockA), ev.signatureA);
  const okB = await verifyText(ev.validator, voteMessage(chainId, ev.type, ev.height, ev.round, ev.blockB), ev.signatureB);
  if (!okA || !okB) throw new ChainError("BAD_EVIDENCE", "توقيع دليل التوقيع المزدوج غير صحيح.");
  return ev;
}

// ---------- Genesis ----------

// validators: [{ publicKey (hex), stake (decimal string of micro-SNN units) }]
// maxShareBps: the largest weight one validator may carry, in basis points.
// rules: optional. Absent means the current Testnet rules, and the key is then not written at all, so
// existing Testnet genesis hashes do not change. 'hybrid-v1' adds the proof-of-work check (see docs/hybrid-consensus.md).
// powTarget: hex target for 'hybrid-v1' blocks. Fixed for now; difficulty retargeting is not wired in yet.
export function createGenesisConfig({ chainId, timestamp, allocations, validators, maxShareBps = DEFAULT_MAX_SHARE_BPS, rules, powTarget, powRetargetWindow, powBlockTimeMs, stateRootV1, evmChainId, evmAllocations, economics }) {
  const config = {
    chainId,
    timestamp,
    maxShareBps: Number(maxShareBps),
    allocations: [...allocations].sort(),
    validators: validators
      .map((v) => ({ publicKey: v.publicKey, stake: String(v.stake), tlsFingerprint: v.tlsFingerprint ?? null }))
      .sort((a, b) => (a.publicKey < b.publicKey ? -1 : 1)),
  };
  if (rules !== undefined) config.rules = rules;
  if (powTarget !== undefined) config.powTarget = powTarget;
  if (powRetargetWindow !== undefined) config.powRetargetWindow = powRetargetWindow;
  if (powBlockTimeMs !== undefined) config.powBlockTimeMs = powBlockTimeMs;
  if (stateRootV1 !== undefined) config.stateRootV1 = stateRootV1;
  if (evmChainId !== undefined) config.evmChainId = evmChainId;
  if (evmAllocations !== undefined) config.evmAllocations = evmAllocations;
  if (economics !== undefined) config.economics = economics;
  return config;
}

export const RULES_HYBRID = "hybrid-v1";

// Fields of one EVM transfer entry in a block. Nothing else is allowed, so the block hash cannot carry extra data.
export const EVM_ENTRY_FIELDS = ["gasLimit", "nonce", "r", "s", "to", "v", "value"];

// Chain id used for EVM signatures on this chain. The Testnet value applies when the genesis names none.
export const evmChainIdOf = (config) => config.evmChainId ?? Number(EVM_CHAIN_IDS.testnet);

// Strict shape check for one EVM entry, shared by the block rules and the node's mempool.
export function checkEvmEntryShape(entry) {
  if (entry === null || typeof entry !== "object" || Object.keys(entry).sort().join() !== EVM_ENTRY_FIELDS.join()) {
    throw new ChainError("BAD_EVM_TX", "حقول معاملة EVM غير مسموحة.");
  }
}

export const evmEntryId = (entry) => sha256Hex(canonicalJson(entry));

export function validateGenesis(config) {
  const bad = (msg) => new ChainError("BAD_GENESIS", msg);
  if (config === null || typeof config !== "object") throw bad("ملف التأسيس غير صالح.");
  if (typeof config.chainId !== "string" || config.chainId.length === 0) throw bad("معرّف الشبكة غير صالح.");
  if (!Number.isInteger(config.maxShareBps) || config.maxShareBps < 1 || config.maxShareBps > 10_000) {
    throw bad("حد الحصة يجب أن يكون عدداً صحيحاً بين 1 و 10000 نقطة أساس.");
  }
  if (!Array.isArray(config.validators) || config.validators.length === 0) throw bad("لا يوجد مدققون في التأسيس.");
  if (config.rules !== undefined && config.rules !== RULES_HYBRID) throw bad("قواعد الشبكة غير معروفة.");
  if (config.rules === RULES_HYBRID) {
    if (typeof config.powTarget !== "string" || !/^[0-9a-f]{1,64}$/.test(config.powTarget)) throw bad("هدف إثبات العمل غير صالح.");
    if (BigInt("0x" + config.powTarget) === 0n) throw bad("هدف إثبات العمل يجب ألا يكون صفراً.");
    const W = config.powRetargetWindow ?? 0;
    if (!Number.isInteger(W) || W < 0 || W > 10_000) throw bad("نافذة تعديل الصعوبة غير صالحة.");
    if (W > 0 && (!Number.isSafeInteger(config.powBlockTimeMs) || config.powBlockTimeMs <= 0)) {
      throw bad("زمن الكتلة المستهدف مطلوب مع تعديل الصعوبة.");
    }
  } else if (config.powTarget !== undefined || config.powRetargetWindow !== undefined || config.powBlockTimeMs !== undefined) {
    throw bad("هدف إثبات العمل يُستخدم فقط مع قواعد hybrid-v1.");
  }
  if (config.stateRootV1 !== undefined) {
    if (config.stateRootV1 !== true || config.rules !== RULES_HYBRID) {
      throw bad("جذر الحالة يتطلب قواعد hybrid-v1 ويُفعَّل بالقيمة true فقط.");
    }
  }
  const evmConfigured = config.evmChainId !== undefined || config.evmAllocations !== undefined;
  if (evmConfigured && config.stateRootV1 !== true) {
    throw bad("إعدادات EVM تتطلب جذر الحالة (stateRootV1) على سلسلة جديدة.");
  }
  if (config.evmChainId !== undefined && (!Number.isSafeInteger(config.evmChainId) || config.evmChainId <= 0)) {
    throw bad("معرّف سلسلة EVM غير صالح.");
  }
  if (config.evmAllocations !== undefined) {
    try {
      EvmAccounts.fromAllocations(config.evmAllocations);
    } catch (err) {
      throw bad(`تخصيصات EVM غير صالحة: ${err.message}`);
    }
  }
  if (config.economics !== undefined) {
    if (config.stateRootV1 !== true) throw bad("الاقتصاد يتطلب جذر الحالة (stateRootV1) على سلسلة جديدة.");
    if (config.allocations.length !== 0) throw bad("سلسلة الاقتصاد لا تستخدم صنبور التأسيس (allocations يجب أن تكون فارغة).");
    validateEconomics(config.economics, bad, config);
  }
  const seen = new Set();
  for (const v of config.validators) {
    if (!HEX_64.test(v.publicKey)) throw bad("مفتاح مدقق غير صالح.");
    if (seen.has(v.publicKey)) throw bad("مدقق مكرر في التأسيس.");
    if (!DECIMAL_STAKE.test(v.stake)) throw bad("حصة المدقق يجب أن تكون عدداً صحيحاً موجباً.");
    if (v.tlsFingerprint !== null && !HEX_64.test(v.tlsFingerprint ?? "")) {
      throw bad("بصمة شهادة TLS للمدقق غير صالحة.");
    }
    seen.add(v.publicKey);
  }
}

const allocationsRoot = (config) => merkleRoot(config.allocations.map((address) => sha256Hex(address)));

export function genesisBlock(config) {
  const block = {
    height: 0,
    timestamp: config.timestamp,
    prevHash: GENESIS_PREV_HASH,
    merkleRoot: sha256Hex(canonicalJson(config)), // commits the whole genesis configuration
    evidenceRoot: merkleRoot([]),
    txs: [],
    evidence: [],
    certificate: null,
  };
  block.hash = blockHashOf(block);
  return block;
}

export function genesisState(config) {
  validateGenesis(config);
  const ledger = new Ledger();
  for (const address of config.allocations) {
    // Testnet only: every allocation gets one faucet-sized credit.
    ledger.credit(address, TESTNET_FAUCET_UNITS);
  }
  const stakes = new Map(config.validators.map((v) => [v.publicKey, BigInt(v.stake)]));
  const state = { ledger, stakes, jailed: new Set() };
  // EVM accounts exist only on chains with stateRootV1. Their genesis funding is separate from the SNN allocations.
  if (config.stateRootV1 === true) state.evm = EvmAccounts.fromAllocations(config.evmAllocations ?? {});
  if (config.economics !== undefined) {
    // The whole supply is minted once at genesis, per allocation. Locks apply afterwards, by vesting rule.
    for (const a of config.economics.genesisAllocations) ledger.genesisMint(a.address, BigInt(a.units));
  }
  return state;
}

// ---------- State and validator set ----------

// ---------- Economics: fees, validator shares and issuance (only on chains whose genesis names `economics`) ----------
// Values are strings in genesis so the config stays canonical JSON. Rules are in econ/rules.js.
// Fee for a block comes from the PARENT block's fullness, so every node knows it before building the block.
// Fees are paid into feeAddress and fully distributed in the same block, leaving feeAddress at zero.

const DECIMAL = /^(0|[1-9][0-9]{0,30})$/;

// Total supply, fixed by the decision document: 100,000,000 SNN in micro-units.
export const ECON_MAX_SUPPLY = 100_000_000n * 1_000_000n;

function validateEconomics(e, bad, config) {
  if (e === null || typeof e !== "object") throw bad("إعدادات الاقتصاد غير صالحة.");
  const digits = (value, name) => {
    if (typeof value !== "string" || !DECIMAL.test(value)) throw bad(`${name} يجب أن يكون عدداً صحيحاً كنص.`);
    return value;
  };
  const params = economicsParamsOf(e, bad);
  if (e.treasury !== undefined) {
    try {
      validateTreasuryConfig(e.treasury);
    } catch (err) {
      throw bad(`إعدادات الخزينة غير صالحة: ${err.message}`);
    }
  }
  try {
    validateParams(params);
  } catch (err) {
    if (err instanceof EconError) throw bad(err.message);
    throw err;
  }
  if (BigInt(digits(e.blockCapacity, "سعة الكتلة")) === 0n) throw bad("سعة الكتلة يجب أن تكون أكبر من صفر.");
  if (BigInt(digits(e.blocksPerPeriod, "عدد الكتل لكل فترة")) === 0n) throw bad("عدد الكتل لكل فترة يجب أن يكون أكبر من صفر.");
  digits(e.securityTargetPerPeriod, "هدف الإصدار لكل فترة");
  // Post-emission rules: after `emissionBlocks` the reward target continues, funded by fees first, then by capped issuance.
  digits(e.emissionBlocks, "عدد كتل الإصدار");
  if (BigInt(digits(e.periodsPerYear, "عدد الفترات في السنة")) === 0n) throw bad("عدد الفترات في السنة يجب أن يكون أكبر من صفر.");
  digits(e.postTargetPerPeriod, "هدف ما بعد الإصدار لكل فترة");
  if (BigInt(digits(e.postCapBps, "سقف الإصدار بعد الإصدار الأولي")) > 10_000n) {
    throw bad("سقف الإصدار بعد الإصدار الأولي يجب ألا يتجاوز 10000 نقطة أساس.");
  }
  for (const name of ["feeAddress", "treasuryAddress", "poolAddress"]) {
    if (!isValidAddress(e[name])) throw bad(`عنوان ${name} غير صالح.`);
  }
  const addresses = new Set([e.feeAddress, e.treasuryAddress, e.poolAddress]);
  if (addresses.size !== 3) throw bad("حسابات الرسوم والخزينة والمجمع يجب أن تكون مختلفة.");
  // Genesis allocations: the whole supply, each entry with an explicit vesting rule. Nothing defaults.
  if (!Array.isArray(e.genesisAllocations) || e.genesisAllocations.length === 0) throw bad("توزيع التأسيس مطلوب.");
  const seenAddresses = new Set();
  let total = 0n;
  for (const a of e.genesisAllocations) {
    if (a === null || typeof a !== "object") throw bad("عنصر توزيع التأسيس غير صالح.");
    if (!isValidAddress(a.address)) throw bad("عنوان في توزيع التأسيس غير صالح.");
    if (seenAddresses.has(a.address)) throw bad("عنوان مكرر في توزيع التأسيس.");
    seenAddresses.add(a.address);
    const units = BigInt(digits(a.units, "مبلغ التوزيع"));
    if (units === 0n) throw bad("مبلغ التوزيع يجب أن يكون أكبر من صفر.");
    total += units;
    if (a.vesting === null || typeof a.vesting !== "object") throw bad("قاعدة الاستحقاق مطلوبة لكل توزيع.");
    digits(a.vesting.cliffBlocks, "مدة الانتظار");
    digits(a.vesting.durationBlocks, "مدة التحرير");
    if (BigInt(digits(a.vesting.cliffReleaseBps, "نسبة التحرير عند الانتظار")) > BPS_DENOMINATOR) {
      throw bad("نسبة التحرير عند الانتظار يجب ألا تتجاوز 10000 نقطة أساس.");
    }
  }
  if (total !== ECON_MAX_SUPPLY) throw bad("مجموع التوزيع يجب أن يساوي المعروض الأقصى بالضبط.");
  const pool = e.genesisAllocations.find((a) => a.address === e.poolAddress);
  if (pool === undefined || BigInt(pool.units) !== BigInt(e.issuancePool)) {
    throw bad("حساب المجمع يجب أن يُمنح في التوزيع بمبلغ مجمع الإصدار بالضبط.");
  }
  if (seenAddresses.has(e.feeAddress)) throw bad("حساب الرسوم لا يُمنح في التوزيع.");
}

// Vesting: an allocation is locked until its schedule releases it. Locked units stay owned by the account and are never burned.
// Release: nothing before cliffBlocks; then cliffReleaseBps at the cliff; the rest linearly over durationBlocks (0 = at once).
export function vestingOf(config) {
  const out = new Map();
  if (config.economics === undefined) return out;
  for (const a of config.economics.genesisAllocations) {
    out.set(a.address, {
      units: BigInt(a.units),
      cliff: BigInt(a.vesting.cliffBlocks),
      cliffBps: BigInt(a.vesting.cliffReleaseBps),
      duration: BigInt(a.vesting.durationBlocks),
    });
  }
  return out;
}

// Units still locked for one vesting entry at a block height.
export function lockedAt(entry, height) {
  const h = BigInt(height);
  if (h < entry.cliff) return entry.units;
  const cliffPart = (entry.units * entry.cliffBps) / BPS_DENOMINATOR;
  const rest = entry.units - cliffPart;
  const elapsed = h - entry.cliff;
  const linear = elapsed >= entry.duration ? rest : (rest * elapsed) / entry.duration;
  return entry.units - (cliffPart + linear);
}

// Total locked at a height, leaving out the listed accounts.
export function lockedTotal(config, height, exclude = []) {
  const skip = new Set(exclude);
  let sum = 0n;
  for (const [address, entry] of vestingOf(config)) {
    if (!skip.has(address)) sum += lockedAt(entry, height);
  }
  return sum;
}

// Converts the genesis strings into the integer parameters used by econ/rules.js.
export function economicsParamsOf(e, bad = (msg) => new ChainError("BAD_GENESIS", msg)) {
  const num = (value) => {
    if (typeof value !== "string" || !DECIMAL.test(value)) throw bad("قيمة اقتصادية غير صالحة.");
    return BigInt(value);
  };
  return {
    feeTiers: { quiet: num(e.feeTiers?.quiet), normal: num(e.feeTiers?.normal), congested: num(e.feeTiers?.congested) },
    tierThresholdsBps: { normal: num(e.tierThresholdsBps?.normal), congested: num(e.tierThresholdsBps?.congested) },
    feeSplitBps: {
      validators: num(e.feeSplitBps?.validators),
      securityTreasury: num(e.feeSplitBps?.securityTreasury),
      burn: num(e.feeSplitBps?.burn),
    },
    issuancePool: num(e.issuancePool),
  };
}

// Fee per transaction for the block that follows `parent`. Zero on chains without economics.
export function feeOf(parent, config) {
  const e = config.economics;
  if (e === undefined) return 0n;
  const util = (BigInt(parent.txs.length) * BPS_DENOMINATOR) / BigInt(e.blockCapacity);
  return feeForUtilisation(util, economicsParamsOf(e));
}

// Applies one user transfer and, on economics chains, moves its fee to feeAddress. Callers discard the state on error.
export async function applyUserTx(state, tx, config, fee, height) {
  if (isWithdrawal(tx)) return applyTreasuryWithdrawal(state, tx, config, height);
  if (config.economics !== undefined) {
    // Only the available part of a balance can be spent: balance minus what is still locked at this height.
    const entry = vestingOf(config).get(tx.from);
    const locked = entry === undefined ? 0n : lockedAt(entry, height);
    const amount = parseAmount(tx.amount);
    if (state.ledger.balanceOf(tx.from) - locked < amount + fee) {
      throw new ChainError("LOCKED_FUNDS", "الرصيد المتاح غير كافٍ بسبب أقفال الاستحقاق.");
    }
  }
  await state.ledger.transfer(tx);
  if (config.economics !== undefined && fee > 0n) {
    state.ledger.protocolMove({ from: tx.from, to: config.economics.feeAddress, amount: fee });
  }
}

// Splits `amount` among the parent block's certificate signers, by their weight at the current state.
// Signers with no weight now (for example, jailed in the parent block) receive nothing. With no recipients, the
// amount goes to the treasury. Remainder units go to the first signer in sorted order, so the split is exact.
async function recipientsFor(parent, state, config, amount) {
  if (amount === 0n) return [];
  const signers = [...new Set((parent.certificate?.signatures ?? []).map((s) => s.validator))].sort();
  const { weights } = validatorWeights(state, config.maxShareBps);
  const weighted = signers.map((key) => ({ key, weight: weights.get(key) ?? 0n })).filter((x) => x.weight > 0n);
  const total = weighted.reduce((sum, x) => sum + x.weight, 0n);
  if (total === 0n) return [{ address: config.economics.treasuryAddress, units: amount }];
  const out = weighted.map((x) => ({ key: x.key, units: (amount * x.weight) / total }));
  out[0].units += amount - out.reduce((sum, x) => sum + x.units, 0n);
  const result = [];
  for (const x of out) {
    if (x.units > 0n) result.push({ address: await addressFromPublicKey(fromHex(x.key)), units: x.units });
  }
  return result;
}

async function settleEconomics(next, block, parent, state, config, fee) {
  const e = config.economics;
  const params = economicsParamsOf(e);
  try {
    // Withdrawals pay no user fee, so only transfers count toward the fee pool.
    const feePayers = block.txs.filter((t) => !isWithdrawal(t)).length;
    const feesTotal = fee * BigInt(feePayers);
    const split = splitFee(feesTotal, params.feeSplitBps);
    // Validator share, then issuance. Both go to the parent's certificate signers. Without signers, the treasury gets them.
    const post = BigInt(block.height) > BigInt(e.emissionBlocks);
    const perPeriod = BigInt(post ? e.postTargetPerPeriod : e.securityTargetPerPeriod);
    const i = BigInt(block.height) % BigInt(e.blocksPerPeriod);
    const target = (((i + 1n) * perPeriod) / BigInt(e.blocksPerPeriod)) -
      ((i * perPeriod) / BigInt(e.blocksPerPeriod));
    let issuance;
    if (!post) {
      // Emission period: paid from the pool, topping validator income up to the target.
      issuance = issuanceFor({
        validatorFeeShare: split.validators,
        target,
        pool: next.ledger.balanceOf(e.poolAddress),
      }).issuance;
    } else {
      // After emission: new units, the shortfall after fees, capped at postCapBps of circulating supply per year.
      // Circulating = balances except pool, treasury and fee account, minus what is still locked. Taken before this block.
      const excluded = [e.poolAddress, e.treasuryAddress, e.feeAddress];
      const circulating = state.ledger.totalBalance(excluded) - lockedTotal(config, block.height, excluded);
      const blocksPerYear = BigInt(e.periodsPerYear) * BigInt(e.blocksPerPeriod);
      const cap = (circulating * BigInt(e.postCapBps)) / (BPS_DENOMINATOR * blocksPerYear);
      const shortfall = target > split.validators ? target - split.validators : 0n;
      issuance = shortfall < cap ? shortfall : cap;
    }
    // recipientsFor always sums to the amount it was given, so the validator share is paid exactly.
    for (const r of await recipientsFor(parent, state, config, split.validators)) {
      next.ledger.protocolMove({ from: e.feeAddress, to: r.address, amount: r.units });
    }
    if (split.securityTreasury > 0n) {
      next.ledger.protocolMove({ from: e.feeAddress, to: e.treasuryAddress, amount: split.securityTreasury });
    }
    if (split.burn > 0n) next.ledger.protocolMove({ from: e.feeAddress, to: null, amount: split.burn });
    for (const r of await recipientsFor(parent, state, config, issuance)) {
      if (post) next.ledger.issue(r.address, r.units);
      else next.ledger.protocolMove({ from: e.poolAddress, to: r.address, amount: r.units });
    }
    if (next.ledger.balanceOf(e.feeAddress) !== 0n) throw new Error("حساب الرسوم لم يُفرَّغ بالكامل.");
  } catch (err) {
    if (err instanceof ChainError) throw err;
    throw new ChainError("BAD_ECONOMICS", `تسوية الاقتصاد غير صالحة: ${err.message}`);
  }
}

// Applies an approved treasury withdrawal. Refused unless the bundle verifies, the id is new, and the
// amount fits the treasury's spendable balance. Withdrawals pay no user fee.
async function applyTreasuryWithdrawal(state, tx, config, height) {
  const e = config.economics;
  if (e === undefined || e.treasury === undefined) throw new ChainError("BAD_TX", "السحب من الخزينة غير مفعّل في هذه السلسلة.");
  if (state.ledger.hasWithdrawal(tx.id)) throw new ChainError("WITHDRAWAL_REPLAY", "هذا السحب نُفّذ بالفعل.");
  const units = BigInt(tx.units);
  try {
    await verifyWithdrawalBundle({
      config: e.treasury,
      id: tx.id,
      to: tx.to,
      units,
      proposedAt: tx.proposedAt,
      executeAfter: tx.executeAfter,
      height,
      approvals: tx.approvals,
    });
    const entry = vestingOf(config).get(e.treasuryAddress);
    const lockedUnits = entry === undefined ? 0n : lockedAt(entry, height);
    applyWithdrawal(state.ledger, {
      treasuryAddress: e.treasuryAddress,
      lockedUnits,
      instruction: { to: tx.to, units },
      withdrawalId: tx.id,
    });
  } catch (err) {
    if (err instanceof TreasuryError || err instanceof LedgerError) throw new ChainError(err.code, err.message);
    throw err;
  }
}

export async function cloneState(state) {
  return {
    ledger: await Ledger.fromSnapshot(JSON.parse(JSON.stringify(state.ledger))),
    stakes: new Map(state.stakes),
    jailed: new Set(state.jailed),
    ...(state.evm !== undefined ? { evm: state.evm.clone() } : {}),
  };
}

// Active validators are those that are not jailed. Weights are integers, capped at maxShareBps.
export function validatorWeights(state, maxShareBps) {
  const active = new Map();
  for (const [id, stake] of state.stakes) {
    if (!state.jailed.has(id)) active.set(id, stake);
  }
  let weights;
  try {
    weights = capWeights(active, BigInt(maxShareBps));
  } catch (err) {
    throw new ChainError("NOT_ENOUGH_VALIDATORS", err.message);
  }
  return { weights, total: sumOf(weights) };
}

// ---------- Blocks ----------

// The work field is hashed only when present, so blocks without it (Testnet) keep their hashes.
export const blockHashOf = (block) =>
  sha256Hex(
    canonicalJson({
      height: block.height,
      timestamp: block.timestamp,
      prevHash: block.prevHash,
      merkleRoot: block.merkleRoot,
      evidenceRoot: block.evidenceRoot,
      ...(block.work !== undefined ? { work: block.work } : {}),
      ...(block.stateRoot !== undefined ? { stateRoot: block.stateRoot } : {}),
      // The Merkle root covers only SNN transactions, so EVM entries must be hashed on their own.
      ...(block.evmTxs !== undefined ? { evmTxs: block.evmTxs } : {}),
    }),
  );

const evidenceRootOf = (evidence) => merkleRoot(evidence.map((e) => sha256Hex(canonicalJson(e))));

// Builds an unsigned block. Evidence is sorted by key, so the block bytes do not depend on arrival order.
export function buildBlock({ height, timestamp, prevHash, txs, evidence = [], work, evmTxs }) {
  const normalized = txs.map(normalizeTx);
  const sorted = evidence.map(normalizeEvidence).sort((a, b) => (evidenceKey(a) < evidenceKey(b) ? -1 : 1));
  if (evmTxs !== undefined && !Array.isArray(evmTxs)) throw new ChainError("BAD_EVM_TX", "حقل معاملات EVM يجب أن يكون قائمة.");
  const block = {
    height,
    timestamp,
    prevHash,
    merkleRoot: merkleRoot(normalized.map(txId)),
    evidenceRoot: evidenceRootOf(sorted),
    txs: normalized,
    evidence: sorted,
    certificate: null,
  };
  if (work !== undefined) block.work = work;
  if (evmTxs !== undefined) block.evmTxs = evmTxs.map((entry) => ({ ...entry }));
  block.hash = blockHashOf(block);
  return block;
}

const targetOfBlock = (block, config) => (block.work ? BigInt("0x" + block.work.target) : BigInt("0x" + config.powTarget));

// The target a block at `height` must carry. It depends only on ancestors, never on the miner's choice.
// Without a retarget window it is the target of the parent. At a window boundary it moves by the ratio of the
// time the last window took to the time it should have taken (clamped, and never easier than genesis).
// `chain` is the array of blocks indexed by height; it is needed only at window boundaries.
export function expectedTarget(config, parent, chain, height) {
  const prev = targetOfBlock(parent, config);
  const W = config.powRetargetWindow ?? 0;
  if (W === 0 || height % W !== 0) return prev;
  const start = Array.isArray(chain) ? chain[height - W] : undefined;
  if (!start) throw new ChainError("BAD_HISTORY", "تاريخ السلسلة غير متاح لحساب الصعوبة.");
  try {
    return nextTarget({
      previousTarget: prev,
      actualSeconds: BigInt(parent.timestamp - start.timestamp),
      expectedSeconds: BigInt(W) * BigInt(config.powBlockTimeMs),
      minTarget: 1n,
      maxTarget: BigInt("0x" + config.powTarget),
    });
  } catch (err) {
    if (err instanceof PowError) throw new ChainError(err.code, err.message);
    throw err;
  }
}

// Checks the proof of work of a 'hybrid-v1' block against the target its ancestors require. The header
// commits to the chain id, so work from another chain fails. A block that states another target fails too.
export function checkBlockWork(block, config, parent, chain = null) {
  const w = block.work;
  if (w === null || typeof w !== "object" || Object.keys(w).sort().join() !== "nonce,target") {
    throw new ChainError("POW_MISSING", "الكتلة بلا إثبات عمل صالح.");
  }
  if (typeof w.target !== "string" || !/^[0-9a-f]{1,64}$/.test(w.target)) {
    throw new ChainError("POW_BAD_TARGET", "الهدف في الترويسة غير صالح.");
  }
  const expected = expectedTarget(config, parent, chain, block.height);
  try {
    validateWork(
      {
        chainId: config.chainId,
        height: block.height,
        parentHash: block.prevHash,
        merkleRoot: block.merkleRoot,
        timestamp: block.timestamp,
        target: BigInt("0x" + w.target),
        nonce: w.nonce,
      },
      expected,
      config.chainId,
    );
  } catch (err) {
    if (err instanceof PowError) throw new ChainError(err.code, err.message);
    throw err;
  }
}

// Mines the work for a block under a 'hybrid-v1' chain and returns the block with work and hash set.
export function withWork(block, config, parent, chain = null, maxAttempts = 1_000_000) {
  const target = expectedTarget(config, parent, chain, block.height);
  const found = mine(
    { chainId: config.chainId, height: block.height, parentHash: block.prevHash, merkleRoot: block.merkleRoot, timestamp: block.timestamp, target, nonce: 0 },
    maxAttempts,
  );
  const out = { ...block, work: { nonce: found.nonce, target: target.toString(16) } };
  out.hash = blockHashOf(out);
  return out;
}

// Checks that the commit certificate was signed by validators holding more than two thirds of the weight
// that was active before this block. Unknown, jailed or repeated signers do not count.
export async function verifyCertificate(chainId, parentState, block, maxShareBps) {
  const cert = block.certificate;
  if (cert === null || typeof cert !== "object" || !Number.isInteger(cert.round) || cert.round < 0) {
    throw new ChainError("BAD_CERTIFICATE", "الكتلة بلا شهادة اعتماد صالحة.");
  }
  if (!Array.isArray(cert.signatures)) throw new ChainError("BAD_CERTIFICATE", "شكل شهادة الاعتماد غير صالح.");
  const { weights, total } = validatorWeights(parentState, maxShareBps);
  const message = voteMessage(chainId, "precommit", block.height, cert.round, block.hash);
  const seen = new Set();
  let power = 0n;
  for (const { validator, signature } of cert.signatures) {
    if (!weights.has(validator) || seen.has(validator)) {
      throw new ChainError("BAD_CERTIFICATE", "توقيع من مدقق غير معتمد أو مكرر.");
    }
    seen.add(validator);
    if (!(await verifyText(validator, message, signature))) {
      throw new ChainError("BAD_CERTIFICATE", "توقيع الاعتماد غير صحيح.");
    }
    power += weights.get(validator);
  }
  if (!hasQuorum(power, total)) throw new ChainError("NO_QUORUM", "شهادة الاعتماد لا تبلغ أكثر من الثلثين.");
}

// Validates one block against its parent and returns the state after it. Throws ChainError on any problem.
// It never modifies `state`. It does not check the certificate: see applyCommitted for that.
export async function applyBlock(state, block, parent, config, chain = null) {
  const next = await applyBlockBody(state, block, parent, config, chain);
  checkStateRoot(next, block, config);
  return next;
}

// Chains with stateRootV1 require a root equal to the state reached after this block.
// Other chains refuse blocks that carry one, so the current Testnet is unaffected.
export function checkStateRoot(next, block, config) {
  if (config.stateRootV1 === true) {
    if (block.stateRoot !== compositeStateRoot(next.ledger, next.evm.root())) {
      throw new ChainError("BAD_STATE_ROOT", "جذر الحالة لا يطابق الحالة الناتجة.");
    }
  } else if (block.stateRoot !== undefined) {
    throw new ChainError("BAD_STATE_ROOT", "جذر الحالة غير مسموح في هذه السلسلة.");
  }
}

// Producer side: applies the block, records the resulting state root, and recomputes the hash.
// Call this before withWork, because work and certificates cover the hash.
export async function attachStateRoot(state, block, parent, config, chain = null) {
  if (config.stateRootV1 !== true) return block;
  // Work is attached after this call, so the proof-of-work check is skipped here. applyBlock checks it later.
  const next = await applyBlockBody(state, block, parent, config, chain, false);
  const out = { ...block, stateRoot: compositeStateRoot(next.ledger, next.evm.root()) };
  out.hash = blockHashOf(out);
  return out;
}

async function applyBlockBody(state, block, parent, config, chain = null, requireWork = true) {
  if (block === null || typeof block !== "object" || !Array.isArray(block.txs) || !Array.isArray(block.evidence)) {
    throw new ChainError("BAD_BLOCK", "شكل الكتلة غير صالح.");
  }
  if (block.height !== parent.height + 1) throw new ChainError("BAD_HEIGHT", "ارتفاع الكتلة غير متسلسل.");
  if (block.prevHash !== parent.hash) throw new ChainError("BAD_PARENT", "الكتلة لا تشير إلى الكتلة السابقة الصحيحة.");
  if (block.hash !== blockHashOf(block)) throw new ChainError("BAD_HASH", "بصمة الكتلة لا تطابق محتواها.");
  if (config.rules === RULES_HYBRID && requireWork) checkBlockWork(block, config, parent, chain);
  for (const tx of block.txs) {
    if (canonicalJson(tx) !== canonicalJson(normalizeTx(tx))) {
      throw new ChainError("BAD_TX", "المعاملة تحتوي على حقول غير مسموحة.");
    }
  }
  if (block.merkleRoot !== merkleRoot(block.txs.map(txId))) {
    throw new ChainError("BAD_MERKLE", "جذر Merkle لا يطابق المعاملات.");
  }
  if (block.evidenceRoot !== evidenceRootOf(block.evidence)) {
    throw new ChainError("BAD_EVIDENCE_ROOT", "جذر الأدلة لا يطابق محتواها.");
  }
  // Timestamps must strictly increase along the chain, so history cannot be reordered or stamped out of time.
  if (!Number.isSafeInteger(block.timestamp) || !(block.timestamp > parent.timestamp)) {
    throw new ChainError("BAD_TIMESTAMP", "الطابع الزمني يجب أن يزيد عن طابع الكتلة السابقة.");
  }

  const next = await cloneState(state);
  let previousKey = null;
  for (const raw of block.evidence) {
    const ev = normalizeEvidence(raw);
    if (canonicalJson(raw) !== canonicalJson(ev)) throw new ChainError("BAD_EVIDENCE", "حقول دليل غير مسموحة.");
    const key = evidenceKey(ev);
    if (previousKey !== null && key <= previousKey) {
      throw new ChainError("BAD_EVIDENCE", "الأدلة غير مرتبة أو مكررة.");
    }
    previousKey = key;
    if (ev.height >= block.height) throw new ChainError("BAD_EVIDENCE", "الدليل يخص كتلة لم تُعتمد بعد.");
    // Checked against `next`, so a second piece of evidence for the same validator in this block fails.
    await verifyEvidence(ev, config.chainId, next);
    const stake = next.stakes.get(ev.validator);
    next.stakes.set(ev.validator, stake - (stake * SLASH_PERCENT) / 100n);
    next.jailed.add(ev.validator);
  }

  const fee = feeOf(parent, config);
  for (const tx of block.txs) {
    try {
      await applyUserTx(next, tx, config, fee, block.height);
    } catch (err) {
      throw new ChainError("BAD_TX", `معاملة غير صالحة داخل الكتلة: ${err.message}`);
    }
  }
  if (config.economics !== undefined) await settleEconomics(next, block, parent, state, config, fee);

  if (block.evmTxs !== undefined) {
    if (config.stateRootV1 !== true) throw new ChainError("BAD_EVM_TX", "معاملات EVM غير مسموحة في هذه السلسلة.");
    if (!Array.isArray(block.evmTxs)) throw new ChainError("BAD_EVM_TX", "حقل معاملات EVM يجب أن يكون قائمة.");
    // Testnet default when the genesis names no EVM chain id. The id is part of every signature, so a transfer
    // signed for another chain cannot be replayed here.
    const evmChainId = evmChainIdOf(config);
    for (const entry of block.evmTxs) {
      checkEvmEntryShape(entry);
      try {
        applyTransferEntry(next.evm, entry, evmChainId);
      } catch (err) {
        if (err instanceof EvmError) throw new ChainError("BAD_EVM_TX", `معاملة EVM غير صالحة داخل الكتلة: ${err.message}`);
        throw err;
      }
    }
  }
  return next;
}

// A block is accepted only with a valid certificate for the validator set that was active before it.
export async function applyCommitted(state, block, parent, config, chain = null) {
  await verifyCertificate(config.chainId, state, block, config.maxShareBps);
  return applyBlock(state, block, parent, config, chain);
}

// Rebuilds the full state from genesis. Used on startup and when syncing from a peer.
export async function replayChain(blocks, config) {
  if (!Array.isArray(blocks) || blocks.length === 0) throw new ChainError("EMPTY_CHAIN", "السلسلة فارغة.");
  const genesis = genesisBlock(config);
  if (canonicalJson(blocks[0]) !== canonicalJson(genesis)) {
    throw new ChainError("BAD_GENESIS", "الكتلة الأولى لا تطابق الكتلة التأسيسية.");
  }
  let state = genesisState(config);
  let parent = genesis;
  for (const block of blocks.slice(1)) {
    state = await applyCommitted(state, block, parent, config, blocks);
    parent = block;
  }
  return state;
}
