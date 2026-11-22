// Ethereum-style JSON-RPC. It reads node.genesis, node.tip, node.state and node.evmMempool.
// The only write is eth_sendRawTransaction, which adds a checked entry to the EVM mempool through node.addEvmEntry.
// EVM methods answer only on chains with stateRootV1, so the current Testnet keeps its behaviour.
// Receipts are derived from committed blocks. Not yet here: eth_call, typed (EIP-2718) transactions, contract creation, logs.
import { createLegacyTxFromRLP } from "@ethereumjs/tx";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { EVM_CHAIN_IDS, TESTNET_GAS_POLICY } from "../evm/params.js";
import { isEvmAddress } from "../evm/accounts.js";
import { applyTransferEntry, INTRINSIC_GAS } from "../evm/transfer.js";
import { createTestnetCommon } from "../evm/engine.js";
import { evmChainIdOf } from "../chain/core.js";

export const RPC_ERRORS = Object.freeze({
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  EVM_DISABLED: -32000,
  TX_REJECTED: -32000,
});

// Bad parameters: answered with INVALID_PARAMS.
class RpcParamError extends Error {}
// A well-formed transaction the node refuses: answered with TX_REJECTED and the reason.
class RpcTxError extends Error {}

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
function addressOf(raw) {
  const address = typeof raw === "string" ? raw.toLowerCase() : "";
  if (!isEvmAddress(address)) throw new RpcParamError("address must be a 0x-prefixed 20-byte hex string");
  return address;
}

const addressParam = (params) => addressOf(params?.[0]);

const HEX_QUANTITY = /^0x[0-9a-fA-F]+$/;
const quantityOf = (raw) => {
  if (typeof raw !== "string" || !HEX_QUANTITY.test(raw)) throw new RpcParamError("value must be a 0x-prefixed hex quantity");
  return BigInt(raw);
};

// Gas for a plain value transfer. Only transfers are estimated: no calldata and no contract creation.
// With a sender given, the sender's confirmed balance must cover the value plus the fee, as the node would require.
function estimateTransferGas(node, params) {
  const call = params?.[0];
  if (call === null || typeof call !== "object" || Array.isArray(call)) throw new RpcParamError("transaction object expected");
  if (call.to === undefined) throw new RpcParamError("contract creation is not supported");
  addressOf(call.to);
  if (call.data !== undefined && call.data !== "0x" && call.data !== "") {
    throw new RpcParamError("only plain value transfers are supported");
  }
  const value = call.value === undefined ? 0n : quantityOf(call.value);
  if (call.from !== undefined) {
    const from = addressOf(call.from);
    const fee = INTRINSIC_GAS * TESTNET_GAS_POLICY.gasPriceBase;
    if (node.state.evm.get(from).balance < value + fee) throw new RpcTxError("insufficient funds for value plus fee");
  }
  return toHex(INTRINSIC_GAS);
}

const RAW_HEX = /^0x([0-9a-fA-F]{2})+$/;

// Decodes one signed legacy transfer into the entry the node's EVM rules use, and computes its transaction hash.
// Refused before reaching the node: typed transactions, contract creation, calldata, a gas price other than the
// Testnet price (the node burns that price as the fee), and unsigned input.
function entryFromRawTx(raw) {
  if (typeof raw !== "string" || !RAW_HEX.test(raw)) {
    throw new RpcParamError("raw transaction must be a 0x-prefixed hex string");
  }
  const bytes = Uint8Array.from(Buffer.from(raw.slice(2), "hex"));
  if (bytes[0] < 0xc0) throw new RpcParamError("only legacy transactions are supported");
  let tx;
  try {
    tx = createLegacyTxFromRLP(bytes, { common: createTestnetCommon() });
  } catch {
    throw new RpcParamError("transaction cannot be decoded");
  }
  if (tx.to === undefined) throw new RpcParamError("contract creation is not supported");
  if (tx.data.length > 0) throw new RpcParamError("only plain value transfers are supported");
  if (tx.gasPrice !== TESTNET_GAS_POLICY.gasPriceBase) throw new RpcParamError("gas price must equal the Testnet gas price");
  if (tx.v === undefined || tx.r === undefined || tx.s === undefined) throw new RpcParamError("transaction is not signed");
  const entry = {
    nonce: tx.nonce.toString(),
    gasLimit: tx.gasLimit.toString(),
    to: tx.to.toString().toLowerCase(),
    value: tx.value.toString(),
    v: tx.v.toString(),
    r: tx.r.toString(),
    s: tx.s.toString(),
  };
  return { entry, hash: "0x" + Buffer.from(keccak_256(bytes)).toString("hex") };
}

const METHODS = {
  web3_clientVersion: { needsEvm: false, run: () => "SNN-EVM/0.1" },
  net_version: { needsEvm: true, run: () => EVM_CHAIN_IDS.testnet.toString() },
  eth_chainId: { needsEvm: true, run: () => toHex(EVM_CHAIN_IDS.testnet) },
  eth_blockNumber: { needsEvm: true, run: (node) => toHex(node.tip.height) },
  eth_gasPrice: { needsEvm: true, run: () => toHex(TESTNET_GAS_POLICY.gasPriceBase) },
  eth_estimateGas: { needsEvm: true, run: (node, params) => estimateTransferGas(node, params) },
  eth_getTransactionReceipt: {
    needsEvm: true,
    run: (node, params) => {
      const hash = params?.[0];
      if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
        throw new RpcParamError("transaction hash must be 32 bytes of 0x-prefixed hex");
      }
      return node.evmReceipt(hash.toLowerCase());
    },
  },
  eth_getBalance: { needsEvm: true, run: (node, params) => toHex(evmView(node, params, 1).get(addressParam(params)).balance) },
  eth_getTransactionCount: { needsEvm: true, run: (node, params) => toHex(evmView(node, params, 1).get(addressParam(params)).nonce) },
  eth_sendRawTransaction: {
    needsEvm: true,
    run: (node, params) => {
      const { entry, hash } = entryFromRawTx(params?.[0]);
      try {
        node.addEvmEntry(entry);
      } catch (err) {
        throw new RpcTxError(err.message);
      }
      return hash;
    },
  },
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
    if (err instanceof RpcTxError) return rpcError(id, RPC_ERRORS.TX_REJECTED, err.message);
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
