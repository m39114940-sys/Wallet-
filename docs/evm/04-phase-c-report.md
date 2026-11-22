# Phase C report: EVM engine on the new Testnet

Status: **partial**. The execution layer works and is tested. The owner's acceptance criteria for Phase C are not all met yet (see "Not done"). Phase D must not start until the owner reviews this report.

Branch: `feature/evm-compat-design` at `f3660ce`.

## Files added

- `evm/errors.js`: `EvmError` with a stable `code`.
- `evm/params.js`: 18-decimal precision, 0.000001 SNN minimum, approved chain IDs (Mainnet 20261121, Testnet 20261122), Testnet-only gas policy.
- `evm/units.js`: exact SNN string parsing and formatting. Amounts with more than 18 decimals are refused, never rounded.
- `evm/accounts.js`: EVM address from a secp256k1 public key via Keccak-256 (`@noble/hashes`). Stored under the `evm:` namespace.
- `evm/gas.js`: per-transaction and per-block gas caps, fee calculation.
- `evm/chain.js`: Testnet chain descriptor, Chain ID 20261122, hardfork pinned to `shanghai`. All forks up to Shanghai activate at block 0.
- `evm/engine.js`: `createTestnetEvm` (via `createEVM`), `runTestnetCall` (checks gas caps before execution), `stateRootHex`.
- `tests/evm.test.js` and `tests/evm-engine.test.js`.
- Reference declaration files at the repo root (`evm-d-ts.txt`, `evm-types-d-ts.txt`, `common-interfaces-d-ts.txt`, `evm-constructors-d-ts.txt`, `util-sigs.txt`, `common-ctor-sigs.txt`, `common-opts-sigs.txt`, `common-base-sigs.txt`, `common-chain-sigs.txt`, `common-consensus-sigs.txt`). These are copies of third-party type declarations used to verify APIs. **They should be removed from the repo root in a cleanup commit.**

## Dependencies

- `@ethereumjs/evm`, `@noble/curves`, `@noble/hashes`: pinned to exact versions approved by the owner.
- `@ethereumjs/common`, `@ethereumjs/statemanager`: pinned exactly to `10.1.3`. The owner approved this on 2026-11-22.
- `package-lock.json` is committed with these pins.

## Changes to Testnet and Mainnet

- Testnet (Chain ID 20261122 for the new chain): no change to the existing Testnet rules.
- Mainnet: nothing published, no Mainnet values in the code.
- Chain IDs: the Mainnet and Testnet IDs were checked against ethereum-lists (exact, no conflict). The chainid.network check is still partial (see "Not done").

## Tests

Results reported by the owner from Codespace:

- `npm test` on `feature/evm-compat-design` (before the state-root work): **205 passed, 0 failed, 1 skipped**.
- `npm test` on `feature/evm-state-root` (exit 0, full log): **217 passed, 0 failed, 1 skipped**.
- `node --test tests/evm-engine.test.js`: **5 passed, 0 failed**.
- `node --test tests/stateroot.test.js`: **5 passed, 0 failed**. `node --test tests/stateroot-chain.test.js`: **7 passed, 0 failed**.
- `node --test tests/hybrid-network.test.js`: **1 passed**. An earlier full run was killed by the environment (exit 143) and then succeeded on rerun.

What the engine tests cover:
- Chain config uses Chain ID 20261122 and hardfork `shanghai`.
- A funded value transfer succeeds, moves the value, and changes the state root.
- Two runs with identical inputs produce identical state roots.
- A gas limit above the cap is refused before execution.
- A malformed caller address is refused.

## Not done (blocks acceptance of Phase C)

1. **State root in consensus block rules (partly done, branch `feature/evm-state-root`):** chains with `stateRootV1: true` (valid only with `hybrid-v1`) now require each block to carry a `stateRoot` equal to the composite of the ledger root and the EVM root. Other chains refuse blocks that carry one. The root is in the block hash only when present. Still missing: node producers do not call `attachStateRoot` yet, and the EVM root is the empty-state constant because EVM transactions are not in blocks yet.
2. **Multi-node determinism:** the test compares two in-process state managers. It does not run several validator nodes over the network and compare roots.
3. **Receipts and logs:** logs are returned in memory but are not stored in blocks or receipts.
4. **Chain ID exact check:** chainid.network was only partially scanned for 20261121 and 20261122. A full check is still needed.
5. **Hardfork schedule:** all forks are set at block 0. This is a chosen simplification. The owner should confirm it.
6. **Commit trailer:** some commits carry `Co-authored-by: Copilot`. They were not rewritten.

## Decisions needed from the owner

- Confirm `shanghai` as the Testnet hardfork.
- Confirm that the reference declaration files can be removed.
- Decide whether to rewrite commit trailers that contain the Copilot line.
- Approve starting the block-rule integration (item 1) before Phase D.
