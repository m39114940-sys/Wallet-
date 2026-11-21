# Model F: implementation report (isolated, Testnet-only)

Branch: `feature/model-f-economics` (from `main` at a51de73).
Status: modules implemented and unit-tested in isolation. **Not wired into chain or node code. Not activated on any network.**

## Scope and guarantees

- All Model F code lives in `econ/`. Nothing in `chain/`, `node/`, `js/` or the Genesis imports it.
- Every feature flag defaults to OFF (`econ/flags.js`).
- Mainnet refuses any enabled flag (`MAINNET_ACTIVATION_FORBIDDEN`) and refuses any initial supply or issuance budget (`MAINNET_DISTRIBUTION_FORBIDDEN`). This is a code-level refusal only; activation on Mainnet still needs explicit written owner approval outside the code.
- No real token supply is created. The default `initialCirculating` and `issuanceBudget` are zero.
- Testnet, Genesis, and the two-thirds validator participation rule are unchanged.

## Modules

| File | Purpose |
|---|---|
| `econ/errors.js` | `EconError` with a machine-readable `code`. |
| `econ/units.js` | BigInt helpers: non-negative amount checks, basis-point checks, exact sums. |
| `econ/params.js` | Proposed parameters: 100M SNN ceiling, fee split, fee-controller bounds, issuance cap, experimental 50/50 PoW/PoS split. |
| `econ/flags.js` | Feature flags, dependency rules, Mainnet refusal. |
| `econ/fees.js` | Fee split. Validators get 85%, treasury 10%, and the exact remainder is burned (or routed to operations when `burn` is off). |
| `econ/feecontroller.js` | Dynamic base fee: at most +50% up and -12.5% down per block, clamped to [0.001, 1] SNN. |
| `econ/issuance.js` | Issuance = min(epoch deficit, remaining budget, 1% of circulating per epoch, remaining supply). Decided once per epoch, not per block. |
| `econ/ratio.js` | PoW/PoS split of issued rewards. |
| `econ/rewards.js` | Proportional payouts. Validator payouts require signed weight of at least two-thirds of total weight. Remainders stay in the pool. |
| `econ/ledgers.js` | Separate `security`, `development`, `operations`, `emergency` ledgers. No transfer method. Spending needs an approval naming the ledger, the exact amount and an approver. |
| `econ/emergency.js` | Pause and resume by named authorizers. Can halt issuance, payouts and fee updates; cannot move funds or change supply. |
| `econ/economy.js` | `ModelFEconomy`: processes one block and checks the supply invariant after every block. |

Dependencies between flags: `feeEngine` needs `treasuryLedgers`; `dynamicFee` and `burn` need `feeEngine`; `securityReward` needs `treasuryLedgers`; `adaptiveIssuance` needs `securityReward`.

## Supply invariant

After every block:

    issued - burned === circulating + ledgers.total() + validatorPool + miningPool

and `issued <= 100,000,000 SNN`, with no negative pool. Each movement is a named transfer between pools, so the invariant holds by construction and is also asserted at runtime.

## Test results

- Review fixes in this round: issuance moved from per-block to per-epoch (the earlier per-block cap could exceed 1% per year on a live chain); all input validation now runs before any state change, so a rejected block leaves state untouched (tested); the deficit accumulates across the epoch and is not lost during a pause.
- `tests/econ.test.js`: 28 tests, all passing. They cover flag defaults and dependencies, Mainnet refusal, the inert default, exact fee splits, fee-controller bounds under sustained spam and under an empty chain, ledger approval and insolvency, the issuance minimum, the supply ceiling, the two-thirds quorum boundary, proportional payouts with exact remainders, duplicate and zero-weight refusal, emergency authorization, and a 500-block randomised run with pause and resume that checks the invariant on every block.
- Full `npm test`: 204 passing, 0 failing, 1 skipped. The skip is the existing VRF RFC 9381 vector, documented in `SECURITY_ARCHITECTURE.md`.

## Parameter assumptions to confirm

These values are proposals carried over from the Model D analysis. They have not been approved.

- Fee split 85% validators / 10% treasury / remainder burned.
- Fee controller steps +50% / -12.5%, bounds 0.001 to 1 SNN.
- Issuance decided once per epoch, capped at 1% of circulating per epoch. Epoch length is a placeholder of 52,560 blocks (about one year of 10-minute blocks); the owner must confirm it.
- PoW/PoS split 50/50, marked experimental. **No final ratio can be chosen until the attack-cost assessment is complete.**

## Not done (required before any activation decision)

1. Model D vs Model F Monte Carlo (10,000 trials over 20 years, identical assumptions). Not run.
2. PoW and PoS attack-cost assessment. Not run. No USD figures are given because no labelled price scenario exists yet.
3. Live Testnet validation: the modules are not connected to the running nodes, so there is nothing to validate on a network yet.
4. Sybil resistance. Only duplicate and zero-weight checks exist. Address-based rate limiting is not treated as Sybil protection.
5. Independent audit, and multi-machine testing.
6. Treasury sustainability: the Model D result still applies. A fixed 1.5M SNN/year cannot be funded from 10% of fees, and no automatic spending commitment is implemented.

## Remaining risks and decisions for the owner

- Confirm the fee split, the controller steps, the issuance cap, and the PoW/PoS ratio.
- Decide how the security deficit should be funded when fees do not cover it. The current code reports the deficit and issues nothing beyond the explicit budget.
- Name the emergency authorizers and decide whether the pause rights are acceptable.
- Decide whether any part of this should be wired into Testnet nodes, which would be a separate reviewed change.
