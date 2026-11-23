// eth_getBalance and eth_getTransactionCount: confirmed state ("latest") and state with the mempool ("pending").
import { test } from "node:test";
import assert from "node:assert/strict";
import { handleRpc, RPC_ERRORS } from "../node/jsonrpc.js";
import { EvmAccounts } from "../evm/state.js";
import { BASE_PER_SNN, EVM_CHAIN_IDS, TESTNET_GAS_POLICY } from "../evm/params.js";
import { signTransfer } from "../evm/tx.js";
import { INTRINSIC_GAS } from "../evm/transfer.js";
import { evmEntryId } from "../chain/core.js";

const KEY1 = new Uint8Array(32);
KEY1[31] = 1;
const KEY1_ADDRESS = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const FEE = INTRINSIC_GAS * TESTNET_GAS_POLICY.gasPriceBase;

function entryFor(nonce) {
  const tx = signTransfer({ privateKey: KEY1, nonce, gasLimit: INTRINSIC_GAS, to: RECIPIENT, value: BASE_PER_SNN });
  return {
    nonce: tx.nonce.toString(),
    gasLimit: tx.gasLimit.toString(),
    to: tx.to.toString().toLowerCase(),
    value: tx.value.toString(),
    v: tx.v.toString(),
    r: tx.r.toString(),
    s: tx.s.toString(),
  };
}

// Only the fields the RPC layer reads: genesis, state, mempool and tip.
function fakeNode({ stateRootV1 = true, allocations = {}, mempool = [] } = {}) {
  return {
    genesis: { stateRootV1, evmChainId: Number(EVM_CHAIN_IDS.testnet) },
    tip: { height: 0 },
    state: { evm: EvmAccounts.fromAllocations(allocations) },
    evmMempool: new Map(mempool.map((e) => [evmEntryId(e), e])),
  };
}

const rpc = (node, method, params) => handleRpc(node, { jsonrpc: "2.0", id: 1, method, params });
const hex = (n) => "0x" + BigInt(n).toString(16);

test("eth_getBalance returns the confirmed balance in hex", () => {
  const node = fakeNode({ allocations: { [KEY1_ADDRESS]: (10n * BASE_PER_SNN).toString() } });
  assert.equal(rpc(node, "eth_getBalance", [KEY1_ADDRESS, "latest"]).result, hex(10n * BASE_PER_SNN));
});

test("an address with no account reports zero", () => {
  const node = fakeNode();
  assert.equal(rpc(node, "eth_getBalance", [RECIPIENT]).result, "0x0");
  assert.equal(rpc(node, "eth_getTransactionCount", [RECIPIENT]).result, "0x0");
});

test("checksummed or upper-case addresses are accepted", () => {
  const node = fakeNode({ allocations: { [KEY1_ADDRESS]: "5" } });
  const upper = "0x" + KEY1_ADDRESS.slice(2).toUpperCase();
  assert.equal(rpc(node, "eth_getBalance", [upper]).result, "0x5");
});

test("a malformed address is an invalid-params error", () => {
  const node = fakeNode();
  assert.equal(rpc(node, "eth_getBalance", ["0xABC"]).error.code, RPC_ERRORS.INVALID_PARAMS);
  assert.equal(rpc(node, "eth_getBalance", []).error.code, RPC_ERRORS.INVALID_PARAMS);
});

test("an unsupported block number is an invalid-params error", () => {
  const node = fakeNode({ allocations: { [KEY1_ADDRESS]: "5" } });
  assert.equal(rpc(node, "eth_getBalance", [KEY1_ADDRESS, "0x5"]).error.code, RPC_ERRORS.INVALID_PARAMS);
});

test("pending counts the nonce and balance after waiting entries", () => {
  const node = fakeNode({
    allocations: { [KEY1_ADDRESS]: (10n * BASE_PER_SNN).toString() },
    mempool: [entryFor(0)],
  });
  assert.equal(rpc(node, "eth_getTransactionCount", [KEY1_ADDRESS, "latest"]).result, "0x0");
  assert.equal(rpc(node, "eth_getTransactionCount", [KEY1_ADDRESS, "pending"]).result, "0x1");
  assert.equal(rpc(node, "eth_getBalance", [KEY1_ADDRESS, "latest"]).result, hex(10n * BASE_PER_SNN));
  assert.equal(rpc(node, "eth_getBalance", [KEY1_ADDRESS, "pending"]).result, hex(9n * BASE_PER_SNN - FEE));
});

test("pending ignores a waiting entry that does not apply", () => {
  const node = fakeNode({
    allocations: { [KEY1_ADDRESS]: (10n * BASE_PER_SNN).toString() },
    mempool: [entryFor(5)],
  });
  assert.equal(rpc(node, "eth_getTransactionCount", [KEY1_ADDRESS, "pending"]).result, "0x0");
  assert.equal(rpc(node, "eth_getBalance", [KEY1_ADDRESS, "pending"]).result, hex(10n * BASE_PER_SNN));
});

test("the pending view never changes the node's own state", () => {
  const node = fakeNode({
    allocations: { [KEY1_ADDRESS]: (10n * BASE_PER_SNN).toString() },
    mempool: [entryFor(0)],
  });
  const before = node.state.evm.root();
  rpc(node, "eth_getBalance", [KEY1_ADDRESS, "pending"]);
  assert.equal(node.state.evm.root(), before);
});

test("the account methods are refused on a chain without stateRootV1", () => {
  const node = fakeNode({ stateRootV1: false });
  assert.equal(rpc(node, "eth_getBalance", [KEY1_ADDRESS]).error.code, RPC_ERRORS.EVM_DISABLED);
  assert.equal(rpc(node, "eth_getTransactionCount", [KEY1_ADDRESS]).error.code, RPC_ERRORS.EVM_DISABLED);
});
