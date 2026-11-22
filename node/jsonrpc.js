// Ethereum-style JSON-RPC, first slice: read-only methods only.
// Pure function of (node, request): it reads node.genesis and node.tip and never changes state.
// EVM methods answer only on chains with stateRootV1, so the current Testnet keeps its behaviour.
// Not yet here: eth_sendRawTransaction, balances and receipts. They need EVM transactions inside blocks.
import { EVM_CHAIN_IDS, TESTNET_GAS_POLICY } from "../evm/params.js";

export const RPC_ERRORS = Object.freeze({
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INTERNAL: -32603,
  EVM_DISABLED: -32000,
});

const toHex = (n) => "0x" + BigInt(n).toString(16);
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const evmEnabled = (node) => node.genesis?.stateRootV1 === true;

const METHODS = {
  web3_clientVersion: { needsEvm: false, run: () => "SNN-EVM/0.1" },
  net_version: { needsEvm: true, run: () => EVM_CHAIN_IDS.testnet.toString() },
  eth_chainId: { needsEvm: true, run: () => toHex(EVM_CHAIN_IDS.testnet) },
  eth_blockNumber: { needsEvm: true, run: (node) => toHex(node.tip.height) },
  eth_gasPrice: { needsEvm: true, run: () => toHex(TESTNET_GAS_POLICY.gasPriceBase) },
};

function handleOne(node, request) {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    return rpcError(null, RPC_ERRORS.INVALID_REQUEST, "Invalid Request");
  }
  const { id = null, jsonrpc, method, params } = request;
  if (jsonrpc !== "2.0" || typeof method !== "string") {
    return rpcError(id, RPC_ERRORS.INVALID_REQUEST, "Invalid Request");
  }
  if (params !== undefined && !Array.isArray(params)) {
    return rpcError(id, RPC_ERRORS.INVALID_REQUEST, "params must be an array when present");
  }
  const entry = Object.prototype.hasOwnProperty.call(METHODS, method) ? METHODS[method] : null;
  if (entry === null) return rpcError(id, RPC_ERRORS.METHOD_NOT_FOUND, "Method not found");
  if (entry.needsEvm && !evmEnabled(node)) {
    return rpcError(id, RPC_ERRORS.EVM_DISABLED, "EVM methods are not enabled on this chain");
  }
  try {
    return { jsonrpc: "2.0", id, result: entry.run(node) };
  } catch {
    return rpcError(id, RPC_ERRORS.INTERNAL, "Internal error");
  }
}

// Accepts one request object or a batch (array). A batch returns an array of responses in the same order.
export function handleRpc(node, body) {
  if (Array.isArray(body)) {
    if (body.length === 0) return rpcError(null, RPC_ERRORS.INVALID_REQUEST, "Empty batch");
    return body.map((request) => handleOne(node, request));
  }
  return handleOne(node, body);
}
