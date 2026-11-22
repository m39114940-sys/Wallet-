// Ethereum-style JSON-RPC. It reads node.genesis, node.tip, node.state and node.evmMempool and never changes them.
// EVM methods answer only on chains with stateRootV1, so the current Testnet keeps its behaviour.
// Not yet here: eth_sendRawTransaction (needs RLP decoding, to be checked against @ethereumjs/tx), receipts, eth_call, estimateGas.
import { EVM_CHAIN_IDS, TESTNET_GAS_POLICY } from "../evm/params.js";
import { isEvmAddress } from "../evm/accounts.js";
import { applyTransferEntry } from "../evm/transfer.js";
import { evmChainIdOf } from "../chain/core.js";

export const RPC_ERRORS = Object.freeze({
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  EVM_DISABLED: -32000,
});

// Raised for bad parameters, so the caller can answer with INVALID_PARAMS instead of INTERNAL.
class RpcParamError extends Error {}

const toHex = (n) => "0x" + BigInt(n).toString(16);
const rpcError = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
const evmEnabled = (node) => node.genesis?.stateRootV1 === true;

// "latest" is the confirmed state. "pending" also counts the EVM entries waiting in the mempool.
// Other block numbers would need history, which the node does not keep as state.
const BLOCK_TAGS = ["latest", "pending"];

function evmView(node, params, index) {
  const tag = params?.[index] ?? "latest";
  if (!BLOCK_TAGS.includes(tag)) throw new RpcParamError("only the latest and pending block tags are supported");
  if (tag === "latest") return node.state.evm;
  const view = node.state.evm.clone();
  const chainId = evmChainIdOf(node.genesis);
  for (const entry of node.evmMempool.values()) {
    try {
      applyTransferEntry(view, entry, chainId);
    } catch {
      // Does not apply after the entries before it. It stays in the mempool until the next commit prunes it.
    }
  }
  return view;
}

// 0x followed by 40 hex digits. Letter case is ignored, so checksummed addresses are accepted.
function addressParam(params) {
  const raw = params?.[0];
  const address = typeof raw === "string" ? raw.toLowerCase() : "";
  if (!isEvmAddress(address)) throw new RpcParamError("address must be a 0x-prefixed 20-byte hex string");
  return address;
}

const METHODS = {
  web3_clientVersion: { needsEvm: false, run: () => "SNN-EVM/0.1" },
  net_version: { needsEvm: true, run: () => EVM_CHAIN_IDS.testnet.toString() },
  eth_chainId: { needsEvm: true, run: () => toHex(EVM_CHAIN_IDS.testnet) },
  eth_blockNumber: { needsEvm: true, run: (node) => toHex(node.tip.height) },
  eth_gasPrice: { needsEvm: true, run: () => toHex(TESTNET_GAS_POLICY.gasPriceBase) },
  eth_getBalance: { needsEvm: true, run: (node, params) => toHex(evmView(node, params, 1).get(addressParam(params)).balance) },
  eth_getTransactionCount: { needsEvm: true, run: (node, params) => toHex(evmView(node, params, 1).get(addressParam(params)).nonce) },
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
    return { jsonrpc: "2.0", id, result: entry.run(node, params) };
  } catch (err) {
    if (err instanceof RpcParamError) return rpcError(id, RPC_ERRORS.INVALID_PARAMS, err.message);
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
