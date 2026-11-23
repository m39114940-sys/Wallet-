// eth_sendRawTransaction: a signed legacy transfer is decoded, checked, and added to the EVM mempool of a real node.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLegacyTx } from "@ethereumjs/tx";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { ChainNode } from "../node/node.js";
import { handleRpc, RPC_ERRORS } from "../node/jsonrpc.js";
import { generateValidatorKey, DEFAULT_STAKE } from "../node/tools.js";
import { createGenesisConfig } from "../chain/core.js";
import { createTestnetCommon } from "../evm/engine.js";
import { BASE_PER_SNN, EVM_CHAIN_IDS, TESTNET_GAS_POLICY } from "../evm/params.js";
import { signTransfer } from "../evm/tx.js";
import { INTRINSIC_GAS } from "../evm/transfer.js";

const KEY1 = new Uint8Array(32);
KEY1[31] = 1;
const KEY1_ADDRESS = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const RECIPIENT = "0x1111111111111111111111111111111111111111";
const hexToBytes = (hex) => Uint8Array.from(Buffer.from(hex.slice(2), "hex"));
const toHex = (bytes) => "0x" + Buffer.from(bytes).toString("hex");

function signedRaw({ nonce = 0, gasPrice } = {}) {
  if (gasPrice === undefined) {
    return toHex(signTransfer({ privateKey: KEY1, nonce, gasLimit: INTRINSIC_GAS, to: RECIPIENT, value: BASE_PER_SNN }).serialize());
  }
  const tx = createLegacyTx(
    { nonce: BigInt(nonce), gasPrice, gasLimit: INTRINSIC_GAS, to: hexToBytes(RECIPIENT), value: BASE_PER_SNN, data: new Uint8Array(0) },
    { common: createTestnetCommon() },
  ).sign(KEY1);
  return toHex(tx.serialize());
}

async function withNode({ stateRoot = true }, fn) {
  const dir = mkdtempSync(join(tmpdir(), "snn-sendraw-"));
  try {
    const keys = [];
    for (let i = 0; i < 4; i++) keys.push(await generateValidatorKey());
    const genesis = createGenesisConfig({
      chainId: "snn-sendraw",
      timestamp: Date.now() - 60_000,
      allocations: [],
      validators: keys.map((k) => ({ publicKey: k.publicKey, stake: DEFAULT_STAKE })),
      maxShareBps: 4000,
      rules: "hybrid-v1",
      powTarget: "0000" + "f".repeat(60),
      ...(stateRoot
        ? { stateRootV1: true, evmChainId: Number(EVM_CHAIN_IDS.testnet), evmAllocations: { [KEY1_ADDRESS]: (10n * BASE_PER_SNN).toString() } }
        : {}),
    });
    const node = new ChainNode({ dataDir: dir, genesis });
    await node.init();
    await fn(node);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const send = (node, raw) => handleRpc(node, { jsonrpc: "2.0", id: 1, method: "eth_sendRawTransaction", params: [raw] });

test("a valid signed transfer is added to the mempool and answered with its transaction hash", async () => {
  await withNode({}, async (node) => {
    const raw = signedRaw({ nonce: 0 });
    const res = send(node, raw);
    assert.equal(res.error, undefined);
    assert.equal(res.result, "0x" + Buffer.from(keccak_256(hexToBytes(raw))).toString("hex"));
    assert.equal(node.evmMempool.size, 1);
    const pending = handleRpc(node, { jsonrpc: "2.0", id: 2, method: "eth_getTransactionCount", params: [KEY1_ADDRESS, "pending"] });
    assert.equal(pending.result, "0x1");
  });
});

test("sending the same raw transaction again returns the same hash and adds nothing", async () => {
  await withNode({}, async (node) => {
    const raw = signedRaw({ nonce: 0 });
    const first = send(node, raw).result;
    const again = send(node, raw);
    assert.equal(again.result, first);
    assert.equal(node.evmMempool.size, 1);
  });
});

test("a typed (non-legacy) transaction is refused as invalid params", async () => {
  await withNode({}, async (node) => {
    assert.equal(send(node, "0x02c0").error.code, RPC_ERRORS.INVALID_PARAMS);
  });
});

test("input that is not hex is refused as invalid params", async () => {
  await withNode({}, async (node) => {
    assert.equal(send(node, "0xzz").error.code, RPC_ERRORS.INVALID_PARAMS);
    assert.equal(send(node, 42).error.code, RPC_ERRORS.INVALID_PARAMS);
  });
});

test("a transaction with a wrong nonce is refused with the reason", async () => {
  await withNode({}, async (node) => {
    const res = send(node, signedRaw({ nonce: 5 }));
    assert.equal(res.error.code, RPC_ERRORS.TX_REJECTED);
    assert.match(res.error.message, /nonce/);
    assert.equal(node.evmMempool.size, 0);
  });
});

test("a transaction at a gas price other than the Testnet price is refused", async () => {
  await withNode({}, async (node) => {
    const raw = signedRaw({ nonce: 0, gasPrice: TESTNET_GAS_POLICY.gasPriceBase * 2n });
    assert.equal(send(node, raw).error.code, RPC_ERRORS.INVALID_PARAMS);
    assert.equal(node.evmMempool.size, 0);
  });
});

test("sending is refused on a chain without stateRootV1", async () => {
  await withNode({ stateRoot: false }, async (node) => {
    assert.equal(send(node, signedRaw({ nonce: 0 })).error.code, RPC_ERRORS.EVM_DISABLED);
  });
});
