// eth_call: simulates plain value transfers only. "0x" means the transfer would go through; a rejection gives the reason.
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRpc, RPC_ERRORS } from "../node/jsonrpc.js";
import { EvmAccounts } from "../evm/state.js";
import { BASE_PER_SNN, EVM_CHAIN_IDS, TESTNET_GAS_POLICY } from "../evm/params.js";
import { INTRINSIC_GAS } from "../evm/transfer.js";

const FROM = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const TO = "0x1111111111111111111111111111111111111111";
const FEE = INTRINSIC_GAS * TESTNET_GAS_POLICY.gasPriceBase;
const hex = (n) => "0x" + n.toString(16);

function fakeNode({ stateRootV1 = true, balance = 10n * BASE_PER_SNN } = {}) {
  return {
    genesis: { stateRootV1, evmChainId: Number(EVM_CHAIN_IDS.testnet) },
    tip: { height: 0 },
    state: { evm: EvmAccounts.fromAllocations({ [FROM]: balance.toString() }) },
    evmMempool: new Map(),
  };
}

const call = (node, params) => handleRpc(node, { jsonrpc: "2.0", id: 1, method: "eth_call", params });

test("a plain transfer that the sender can pay returns empty data", () => {
  const res = call(fakeNode(), [{ from: FROM, to: TO, value: hex(BASE_PER_SNN) }, "latest"]);
  assert.equal(res.result, "0x");
});

test("a sender who cannot pay value plus fee is refused with the reason", () => {
  const res = call(fakeNode({ balance: BASE_PER_SNN + FEE - 1n }), [{ from: FROM, to: TO, value: hex(BASE_PER_SNN) }]);
  assert.equal(res.error.code, RPC_ERRORS.TX_REJECTED);
});

test("calldata is refused as invalid params", () => {
  assert.equal(call(fakeNode(), [{ to: TO, data: "0x1234" }]).error.code, RPC_ERRORS.INVALID_PARAMS);
});

test("contract creation is refused as invalid params", () => {
  assert.equal(call(fakeNode(), [{ value: "0x1" }]).error.code, RPC_ERRORS.INVALID_PARAMS);
});

test("a block tag other than latest is refused as invalid params", () => {
  assert.equal(call(fakeNode(), [{ to: TO }, "0x5"]).error.code, RPC_ERRORS.INVALID_PARAMS);
});

test("eth_call is refused on a chain without stateRootV1", () => {
  assert.equal(call(fakeNode({ stateRootV1: false }), [{ to: TO }]).error.code, RPC_ERRORS.EVM_DISABLED);
});

test("eth_estimateGas still answers the intrinsic gas after the shared check was factored out", () => {
  const res = handleRpc(fakeNode(), { jsonrpc: "2.0", id: 1, method: "eth_estimateGas", params: [{ to: TO }] });
  assert.equal(res.result, hex(INTRINSIC_GAS));
});
