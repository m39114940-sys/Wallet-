# Phase C report: EVM engine on the new Testnet

Status: **closed, pending owner acceptance**. Phase D has not started and must not start until the owner approves it separately.

Branch: `feature/evm-compat-design` at `926daa8` (contains `feature/evm-state-root`, `feature/evm-node-producer` and `feature/evm-determinism`).

## What Phase C delivers

- **Execution layer (`evm/`):** SNN units with 18 decimals and a 0.000001 SNN minimum; EVM addresses from secp256k1 public keys via Keccak-256, kept in the `evm:` namespace; per-transaction and per-block gas caps; a Testnet chain descriptor (Chain ID 20261122, hardfork `shanghai`); `createTestnetEvm`, `runTestnetCall` and `stateRootHex`.
- **State root in block rules (`chain/`):** an optional genesis flag `stateRootV1`, valid only with `hybrid-v1`. Such chains require each block to carry a `stateRoot` equal to the composite of the ledger root and the EVM root. Other chains refuse blocks that carry one, so the current Testnet is unchanged. The root is included in the block hash only when present.
- **Producer (`node/node.js`):** `assemble()` records the state root before proof of work, only on `stateRootV1` chains.
- **Dependencies:** `@ethereumjs/evm` 10.1.3, `@noble/curves` 2.4.0 and `@noble/hashes` 2.4.0 pinned exactly; `@ethereumjs/common` and `@ethereumjs/statemanager` pinned exactly to 10.1.3 (approved by the owner on 2026-11-22). `package-lock.json` is committed.
- **Repo cleanup:** the ten third-party declaration copies used to verify APIs were removed from the repo root in `78234be`.

## Tests

Results reported from Codespace:

- Full `npm test` on `feature/evm-determinism` (same commit as the merged branch): **220 total, 219 passed, 0 failed, 1 skipped**.
- Earlier full run on `feature/evm-state-root`: **217 passed, 0 failed, 1 skipped**.
- Engine: `tests/evm-engine.test.js` 5/5. Units and gas: `tests/evm.test.js` 19/19.
- State root: `tests/stateroot.test.js` 5/5; `tests/stateroot-chain.test.js` 7/7; `tests/stateroot-node.test.js` 1/1.
- Determinism: `tests/stateroot-determinism.test.js` 1/1. Four nodes, each with its own data directory and state, validate the same certified block and all reach the root the proposer recorded.
- Note: the full run was once killed by the environment (exit 143) and the test files were then run sequentially (`--test-concurrency=1`). Individual files pass on rerun.

## Chain ID check

The 2,897 entries of ethereum-lists (commit 75bdee7) contain no entry with Chain ID 20261121 or 20261122. The chainid.network site was only partially scanned earlier; ethereum-lists is the exact list the owner asked for.

## Not done in Phase C (carried forward)

1. **Networked determinism:** the determinism test runs four nodes in one process. It does not run four real node processes exchanging the block over the network. That needs `stateRootV1` in the CLI genesis and a root query endpoint.
2. **Receipts and logs:** not stored in blocks. **Owner accepted deferring them to Phase D**, where receipts are exposed through the Ethereum JSON-RPC layer.
3. **Hardfork schedule:** all forks are set at block 0. This is a chosen simplification and needs the owner's confirmation.

## Decisions still open for the owner

- Confirm `shanghai` as the Testnet hardfork and the block-0 fork schedule.
- Decide whether to rewrite commit trailers that contain the `Co-authored-by: Copilot` line. They were not rewritten; doing so requires a force push.
- Approve starting Phase D, separately.
