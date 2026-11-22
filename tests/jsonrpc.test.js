import { test } from "node:test";
import assert from "node:assert/strict";
import { EVM_CHAIN_IDS, TESTNET_GAS_POLICY } from "../evm/params.js";
import { handleRpc, RPC_ERRORS } from "../node/jsonrpc.js";

const evmNode = (height = 0) => ({ genesis: { stateRootV1: true }, tip: { height } });
const plainNode = () => ({ genesis: {}, tip: { height: 0 } });

test("eth_chainId returns the approved Testnet Chain ID in hex on an EVM chain", () => {
  const res = handleRpc(evmNode(), { jsonrpc: "2.0", id: 1, method: "eth_chainId" });
  assert.equal(res.result, "0x" + EVM_CHAIN_IDS.testnet.toString(16));
  assert.equal(res.id, 1);
});

test("net_version returns the decimal Chain ID", () => {
  const res = handleRpc(evmNode(), { jsonrpc: "2.0", id: 2, method: "net_version" });
  assert.equal(res.result, "20261122");
});

test("eth_blockNumber reports the tip height in hex", () => {
  const res = handleRpc(evmNode(42), { jsonrpc: "2.0", id: 3, method: "eth_blockNumber" });
  assert.equal(res.result, "0x2a");
});

test("eth_gasPrice returns the Testnet gas price in hex", () => {
  const res = handleRpc(evmNode(), { jsonrpc: "2.0", id: 4, method: "eth_gasPrice" });
  assert.equal(res.result, "0x" + TESTNET_GAS_POLICY.gasPriceBase.toString(16));
});

test("EVM methods are refused on a chain without stateRootV1, and the current Testnet is otherwise unchanged", () => {
  const res = handleRpc(plainNode(), { jsonrpc: "2.0", id: 5, method: "eth_chainId" });
  assert.equal(res.error.code, RPC_ERRORS.EVM_DISABLED);
  assert.equal(res.result, undefined);
});

test("web3_clientVersion works on any chain", () => {
  const res = handleRpc(plainNode(), { jsonrpc: "2.0", id: 6, method: "web3_clientVersion" });
  assert.equal(res.result, "SNN-EVM/0.1");
});

test("unknown methods return method-not-found", () => {
  const res = handleRpc(evmNode(), { jsonrpc: "2.0", id: 7, method: "eth_sendRawTransaction" });
  assert.equal(res.error.code, RPC_ERRORS.METHOD_NOT_FOUND);
});

test("prototype keys are not treated as methods", () => {
  const res = handleRpc(evmNode(), { jsonrpc: "2.0", id: 8, method: "constructor" });
  assert.equal(res.error.code, RPC_ERRORS.METHOD_NOT_FOUND);
});

test("malformed requests return invalid-request", () => {
  for (const bad of [null, "eth_chainId", [], { id: 9, method: "eth_chainId" }, { jsonrpc: "1.0", id: 9, method: "net_version" }]) {
    const res = handleRpc(evmNode(), bad);
    assert.equal(res.error.code, RPC_ERRORS.INVALID_REQUEST);
  }
});

test("params that are not an array are refused", () => {
  const res = handleRpc(evmNode(), { jsonrpc: "2.0", id: 10, method: "eth_chainId", params: {} });
  assert.equal(res.error.code, RPC_ERRORS.INVALID_REQUEST);
});

test("a batch returns one response per request, in order", () => {
  const res = handleRpc(evmNode(), [
    { jsonrpc: "2.0", id: "a", method: "net_version" },
    { jsonrpc: "2.0", id: "b", method: "nope" },
  ]);
  assert.equal(res.length, 2);
  assert.equal(res[0].id, "a");
  assert.equal(res[0].result, "20261122");
  assert.equal(res[1].error.code, RPC_ERRORS.METHOD_NOT_FOUND);
});

test("an empty batch is refused", () => {
  const res = handleRpc(evmNode(), []);
  assert.equal(res.error.code, RPC_ERRORS.INVALID_REQUEST);
});
