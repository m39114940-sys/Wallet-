// Model F economy: applies one block of fees, fee-controller update, epoch-based issuance, and reward payouts.
// Every movement is an explicit transfer between named pools, and the supply invariant is checked after each block:
//   issued - burned === circulating + ledgers + validatorPool + miningPool
// Inputs are validated before any state changes, so a rejected block leaves the state untouched.
// With every flag off, this object is inert: it accepts no fees and changes no state except the block counter.
import { EconError } from "./errors.js";
import { resolveFlags } from "./flags.js";
import { TreasuryLedgers } from "./ledgers.js";
import { splitFee } from "./fees.js";
import { nextBaseFee } from "./feecontroller.js";
import { issuanceAmount } from "./issuance.js";
import { splitIssuance } from "./ratio.js";
import { payValidators, distributeProportional, validatorQuorum } from "./rewards.js";
import { EmergencyControl } from "./emergency.js";
import { DEFAULT_EPOCH_BLOCKS, DEFAULT_POW_SHARE_BPS, FEE_CONTROLLER, MAX_SUPPLY } from "./params.js";
import { assertBps, assertUnits, sum } from "./units.js";

export class ModelFEconomy {
  constructor({
    network = "testnet",
    flags = {},
    initialCirculating = 0n,
    issuanceBudget = 0n,
    securityBudgetPerBlock = 0n,
    epochBlocks = DEFAULT_EPOCH_BLOCKS,
    powShareBps = DEFAULT_POW_SHARE_BPS,
    emergencyAuthorizers = [],
  } = {}) {
    this.network = network;
    this.flags = resolveFlags(network, flags);
    assertUnits(initialCirculating, "initialCirculating");
    assertUnits(issuanceBudget, "issuanceBudget");
    assertUnits(securityBudgetPerBlock, "securityBudgetPerBlock");
    assertBps(powShareBps, "powShareBps");
    if (!Number.isSafeInteger(epochBlocks) || epochBlocks < 1) {
      throw new EconError("BAD_EPOCH", "epochBlocks must be a positive integer");
    }
    if (network === "mainnet" && (initialCirculating > 0n || issuanceBudget > 0n)) {
      throw new EconError("MAINNET_DISTRIBUTION_FORBIDDEN", "no initial supply or issuance budget on Mainnet");
    }
    if (initialCirculating + issuanceBudget > MAX_SUPPLY) {
      throw new EconError("SUPPLY_CEILING", "initial supply plus issuance budget exceeds the maximum supply");
    }
    this.baseFee = FEE_CONTROLLER.minFee;
    this.issued = initialCirculating;
    this.circulating = initialCirculating;
    this.burned = 0n;
    this.issuanceRemaining = issuanceBudget;
    this.securityBudgetPerBlock = securityBudgetPerBlock;
    this.epochBlocks = epochBlocks;
    this.blocksInEpoch = 0;
    this.epochDeficit = 0n;
    this.powShareBps = powShareBps;
    this.validatorPool = 0n;
    this.miningPool = 0n;
    this.ledgers = new TreasuryLedgers();
    this.emergency = new EmergencyControl(emergencyAuthorizers);
    this.blocks = 0;
    this.assertSupplyInvariant();
  }

  get paused() {
    return this.flags.emergencyControls && this.emergency.paused;
  }

  pause(args) {
    if (!this.flags.emergencyControls) throw new EconError("FLAG_OFF", "emergencyControls is off");
    this.emergency.pause(args);
  }

  resume(args) {
    if (!this.flags.emergencyControls) throw new EconError("FLAG_OFF", "emergencyControls is off");
    this.emergency.resume(args);
  }

  // Every check that can fail runs here, before any state changes.
  #validateBlock({ txFees, utilBps, validators, miners }) {
    assertBps(utilBps, "utilBps");
    if (!this.flags.feeEngine && txFees.length > 0) {
      throw new EconError("FEE_ENGINE_OFF", "fees were supplied but feeEngine is off");
    }
    if (this.flags.feeEngine) {
      const total = sum(txFees);
      if (total > this.circulating) throw new EconError("FEES_EXCEED_CIRCULATING", "fees exceed circulating supply");
    }
    if (this.flags.validatorRewards) {
      validatorQuorum(validators);
      distributeProportional(0n, miners);
    }
  }

  processBlock({ txFees = [], utilBps = 0n, validators = [], miners = [] } = {}) {
    this.#validateBlock({ txFees, utilBps, validators, miners });
    const paused = this.paused;
    const report = {
      paused,
      feesCollected: 0n,
      burned: 0n,
      deficit: 0n,
      issued: 0n,
      epochClosed: false,
      validatorPaid: 0n,
      minerPaid: 0n,
      quorumMet: null,
      baseFeeBefore: this.baseFee,
      baseFeeAfter: this.baseFee,
    };
    this.blocks += 1;

    // 1. Fee collection (fees come out of circulating supply and are split exactly).
    let treasuryShare = 0n;
    if (this.flags.feeEngine) {
      const total = sum(txFees);
      const split = splitFee(total, { burnEnabled: this.flags.burn });
      this.circulating -= total;
      this.burned += split.burn;
      this.validatorPool += split.validators;
      this.ledgers.credit("security", split.treasury);
      this.ledgers.credit("operations", split.operations);
      treasuryShare = split.treasury;
      report.feesCollected = total;
      report.burned = split.burn;
    }

    // 2. Dynamic base fee, one step per block.
    if (this.flags.dynamicFee && !paused) {
      this.baseFee = nextBaseFee(this.baseFee, utilBps);
    }

    // 3. Security deficit for this block, accumulated over the epoch.
    if (this.flags.securityReward) {
      const blockDeficit = this.securityBudgetPerBlock > treasuryShare ? this.securityBudgetPerBlock - treasuryShare : 0n;
      report.deficit = blockDeficit;
      this.epochDeficit += blockDeficit;
    }

    // 4. Epoch-based issuance: one decision per epoch, capped at 1% of circulating supply for that epoch.
    //    If paused at the epoch boundary, the epoch stays open and closes on the first unpaused block.
    this.blocksInEpoch += 1;
    if (this.flags.securityReward && this.blocksInEpoch >= this.epochBlocks && !paused) {
      if (this.flags.adaptiveIssuance) {
        const amount = issuanceAmount({
          deficit: this.epochDeficit,
          remainingBudget: this.issuanceRemaining,
          circulating: this.circulating,
          remainingSupply: MAX_SUPPLY - this.issued,
        });
        if (amount > 0n) {
          const { pow, pos } = splitIssuance(amount, this.powShareBps);
          this.issued += amount;
          this.issuanceRemaining -= amount;
          this.miningPool += pow;
          this.validatorPool += pos;
          report.issued = amount;
        }
      }
      this.epochDeficit = 0n;
      this.blocksInEpoch = 0;
      report.epochClosed = true;
    }

    // 5. Reward payouts from pools that were actually funded. Unpaid amounts stay in the pool.
    if (this.flags.validatorRewards && !paused) {
      const v = payValidators(this.validatorPool, validators);
      this.validatorPool = v.remainder;
      this.circulating += v.paidTotal;
      report.validatorPaid = v.paidTotal;
      report.quorumMet = v.quorumMet;

      const m = distributeProportional(this.miningPool, miners);
      this.miningPool = m.remainder;
      this.circulating += m.paidTotal;
      report.minerPaid = m.paidTotal;
    }

    report.baseFeeAfter = this.baseFee;
    this.assertSupplyInvariant();
    return report;
  }

  assertSupplyInvariant() {
    const left = this.issued - this.burned;
    const right = this.circulating + this.ledgers.total() + this.validatorPool + this.miningPool;
    if (left !== right) throw new EconError("SUPPLY_INVARIANT", "supply accounting does not balance");
    if (this.issued > MAX_SUPPLY) throw new EconError("SUPPLY_CEILING", "issued supply exceeds the maximum");
    if (this.circulating < 0n || this.validatorPool < 0n || this.miningPool < 0n) {
      throw new EconError("NEGATIVE_POOL", "a pool went negative");
    }
  }

  snapshot() {
    return {
      network: this.network,
      flags: { ...this.flags },
      paused: this.paused,
      blocks: this.blocks,
      epochBlocks: this.epochBlocks,
      blocksInEpoch: this.blocksInEpoch,
      epochDeficit: this.epochDeficit.toString(),
      baseFee: this.baseFee.toString(),
      issued: this.issued.toString(),
      burned: this.burned.toString(),
      circulating: this.circulating.toString(),
      issuanceRemaining: this.issuanceRemaining.toString(),
      validatorPool: this.validatorPool.toString(),
      miningPool: this.miningPool.toString(),
      ledgers: this.ledgers.snapshot(),
    };
  }
}
