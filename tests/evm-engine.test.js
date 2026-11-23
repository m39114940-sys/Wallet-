import { test } from "node:test";
import assert from "node:assert/strict";
import { Account } from "@ethereumjs/util";
import { MerkleStateManager } from "@ethereumjs/statemanager";
import { EvmError } from "../evm/errors.js";
import { EVM_CHAIN_IDS, BASE_PER_SNN, TESTNET_GAS_POLICY } from "../evm/params.js";
import { testnetChainConfig, TESTNET_HARDFORK } from "../evm/chain.js";
import { createTestnetCommon, createTestnetEvm, runTestnetCall, stateRootHex, addressFromHex } from "../evm/engine.js";

const CALLER = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const RECIPIENT = "0x1111111111111111111111111111111111111111";

async function freshState(callerBalance = 5n * BASE_PER_SNN) {
  const common = createTestnetCommon();
  const stateManager = new MerkleStateManager({ common });
  await stateManager.putAccount(addressFromHex(CALLER), new Account(0n, callerBalance));
  return stateManager;
}

test("testnet chain config uses the approved Testnet chain ID and explicit hardfork", () => {
  const cfg = testnetChainConfig();
  assert.equal(cfg.chainId, Number(EVM_CHAIN_IDS.testnet));
  assert.notEqual(cfg.chainId, Number(EVM_CHAIN_IDS.mainnet));
  assert.equal(cfg.defaultHardfork, TESTNET_HARDFORK);
  assert.equal(TESTNET_HARDFORK, "shanghai");
});

test("a funded value transfer succeeds, moves the value and changes the state root", async () => {
  const state = await freshState();
  const evm = await createTestnetEvm(state);
  const before = await stateRootHex(state);
  const res = await runTestnetCall(evm, {
    caller: CALLER,
    to: RECIPIENT,
    value: BASE_PER_SNN,
    gasLimit: 21_000n,
  });
  assert.equal(res.success, true);
  const recipient = await state.getAccount(addressFromHex(RECIPIENT));
  assert.equal(recipient.balance, BASE_PER_SNN);
  assert.notEqual(await stateRootHex(state), before);
});

test("identical transactions on identical state give identical state roots (determinism)", async () => {
  const roots = [];
  for (let i = 0; i < 2; i++) {
    const state = await freshState();
    const evm = await createTestnetEvm(state);
    await runTestnetCall(evm, { caller: CALLER, to: RECIPIENT, value: 3n * 10n ** 17n, gasLimit: 21_000n });
    roots.push(await stateRootHex(state));
  }
  assert.equal(roots[0], roots[1]);
});

test("gas limit above the per-transaction cap is refused before execution", async () => {
  const state = await freshState();
  const evm = await createTestnetEvm(state);
  await assert.rejects(
    runTestnetCall(evm, {
      caller: CALLER,
      to: RECIPIENT,
      value: 1n,
      gasLimit: TESTNET_GAS_POLICY.maxGasLimitPerTx + 1n,
    }),
    (err) => err instanceof EvmError && err.code === "GAS_LIMIT_TOO_HIGH",
  );
});

test("a malformed caller address is refused", async () => {
  const state = await freshState();
  const evm = await createTestnetEvm(state);
  await assert.rejects(
    runTestnetCall(evm, { caller: "0xABC", to: RECIPIENT, value: 1n, gasLimit: 21_000n }),
    (err) => err instanceof EvmError && err.code === "BAD_ADDRESS",
  );
});
