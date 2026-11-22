// eth_estimateGas: plain value transfers only. Gas is always the intrinsic 21,000, and a given sender must be able to pay value plus fee.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRpc, RPC_ERRORS } from "../node/jsonrpc.js";
import { EvmAccounts } from "../evm/state.js";
import { BASE_PER_SNN, EVM_CHAIN_IDS, TESTNET_GAS_POLICY } from "../evm/params.js";
import { INTRINSIC_GAS } from "../evm/transfer.js";

const FROM = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const TO = "0x1111111111111111111111111111111111111111";
const FEE = INTRINSIC_GAS * TESTNET_GAS_POLICY.gasPriceBase;
const GAS_HEX = "0x" + INTRINSIC_GAS.toString(16); // 0x5208

function fakeNode({ stateRootV1 = true, balance = 10n * BASE_PER_SNN } = {}) {
  return {
    genesis: { stateRootV1, evmChainId: Number(EVM_CHAIN_IDS.testnet) },
    tip: { height: 0 },
    state: { evm: EvmAccounts.fromAllocations({ [FROM]: balance.toString() }) },
    evmMempool: new Map(),
  };
}

const estimate = (node, call) => handleRpc(node, { jsonrpc: "2.0", id: 1, method: "eth_estimateGas", params: [call] });

test("a plain transfer is estimated at the intrinsic gas", () => {
  const res = estimate(fakeNode(), { from: FROM, to: TO, value: "0x" + BASE_PER_SNN.toString(16) });
  assert.equal(res.result, GAS_HEX);
});

test("without a sender the estimate does not depend on the balance", () => {
  assert.equal(estimate(fakeNode({ balance: 0n }), { to: TO, value: "0x1" }).result, GAS_HEX);
});

test("a sender whose balance is exactly value plus fee passes", () => {
  const node = fakeNode({ balance: BASE_PER_SNN + FEE });
  assert.equal(estimate(node, { from: FROM, to: TO, value: "0x" + BASE_PER_SNN.toString(16) }).result, GAS_HEX);
});

test("a sender who cannot pay value plus fee is refused", () => {
  const node = fakeNode({ balance: BASE_PER_SNN + FEE - 1n });
  const res = estimate(node, { from: FROM, to: TO, value: "0x" + BASE_PER_SNN.toString(16) });
  assert.equal(res.error.code, RPC_ERRORS.TX_REJECTED);
});

test("calldata is refused as invalid params", () => {
  const res = estimate(fakeNode(), { to: TO, data: "0x1234" });
  assert.equal(res.error.code, RPC_ERRORS.INVALID_PARAMS);
});

test("an empty calldata marker is accepted", () => {
  assert.equal(estimate(fakeNode(), { to: TO, data: "0x" }).result, GAS_HEX);
});

test("contract creation (no recipient) is refused as invalid params", () => {
  assert.equal(estimate(fakeNode(), { value: "0x1" }).error.code, RPC_ERRORS.INVALID_PARAMS);
});

test("a decimal value is refused: amounts must be hex quantities", () => {
  assert.equal(estimate(fakeNode(), { to: TO, value: "10" }).error.code, RPC_ERRORS.INVALID_PARAMS);
});

test("a missing transaction object is refused as invalid params", () => {
  const res = handleRpc(fakeNode(), { jsonrpc: "2.0", id: 1, method: "eth_estimateGas", params: [] });
  assert.equal(res.error.code, RPC_ERRORS.INVALID_PARAMS);
});

test("estimation is refused on a chain without stateRootV1", () => {
  assert.equal(estimate(fakeNode({ stateRootV1: false }), { to: TO }).error.code, RPC_ERRORS.EVM_DISABLED);
});
