import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalJson,
  merkleRoot,
  normalizeTx,
  txId,
  buildBlock,
  applyBlock,
  genesisBlock,
  genesisState,
  createGenesisConfig,
  replayChain,
  sha256Hex,
  ChainError,
} from "../chain/core.js";
import { toHex } from "../js/signing.js";
import { makeAccount, signedTransfer } from "./helpers.js";

async function setup() {
  const alice = await makeAccount();
  const bob = await makeAccount();
  const producer = await makeAccount();
  const config = createGenesisConfig({
    chainId: "snn-unit",
    timestamp: 1_700_000_000,
    allocations: [alice.address, bob.address],
    producerPublicKey: toHex(producer.publicKey),
  });
  const producerKeyHex = toHex(producer.privateKeyDer);
  return { alice, bob, producer, config, producerKeyHex };
}

const expectChainError = (promise, code) =>
  assert.rejects(promise, (err) => err instanceof ChainError && err.code === code, `expected ${code}`);

test("canonical JSON ignores key order", () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 0 }] }), canonicalJson({ a: [2, { c: 0, d: 1 }], b: 1 }));
});

test("amounts are normalized, so equal transfers have one transaction id", async () => {
  const { alice, bob } = await setup();
  const a = await signedTransfer(alice, bob.address, "2.5", 0);
  const b = { ...a, amount: "2.50" };
  assert.equal(normalizeTx(b).amount, "2.5");
  assert.equal(txId(a), txId(b));
});

test("Merkle root: one leaf is itself, two leaves hash together, any change alters the root", () => {
  const a = sha256Hex("a");
  const b = sha256Hex("b");
  const c = sha256Hex("c");
  assert.equal(merkleRoot([a]), a);
  assert.equal(merkleRoot([a, b]), sha256Hex(a + b));
  assert.notEqual(merkleRoot([a, b, c]), merkleRoot([a, b, sha256Hex("x")]));
  assert.equal(merkleRoot([]), sha256Hex(""));
});

test("an honest chain of two blocks replays to the expected balances", async () => {
  const { alice, bob, config, producerKeyHex } = await setup();
  const genesis = genesisBlock(config);
  const tx1 = await signedTransfer(alice, bob.address, "3", 0);
  const block1 = await buildBlock({
    height: 1, timestamp: 1_700_000_010, prevHash: genesis.hash, txs: [tx1],
    producer: config.producerPublicKey, privateKeyDerHex: producerKeyHex,
  });
  const tx2 = await signedTransfer(bob, alice.address, "1", 0);
  const block2 = await buildBlock({
    height: 2, timestamp: 1_700_000_020, prevHash: block1.hash, txs: [tx2],
    producer: config.producerPublicKey, privateKeyDerHex: producerKeyHex,
  });
  const state = await replayChain([genesis, block1, block2], config);
  assert.equal(state.balanceOf(bob.address), 102_000_000n);
  assert.equal(state.balanceOf(alice.address), 98_000_000n);
});

test("a block with a tampered amount fails its Merkle or signature check", async () => {
  const { alice, bob, config, producerKeyHex } = await setup();
  const genesis = genesisBlock(config);
  const tx = await signedTransfer(alice, bob.address, "3", 0);
  const block = await buildBlock({
    height: 1, timestamp: 1_700_000_010, prevHash: genesis.hash, txs: [tx],
    producer: config.producerPublicKey, privateKeyDerHex: producerKeyHex,
  });
  block.txs[0] = { ...block.txs[0], amount: "300" };
  await expectChainError(applyBlock(genesisState(config), block, { height: 0, hash: genesis.hash }, config.producerPublicKey), "BAD_MERKLE");
});

test("a block signed by a key that is not the producer is rejected", async () => {
  const { alice, config } = await setup();
  const genesis = genesisBlock(config);
  const block = await buildBlock({
    height: 1, timestamp: 1_700_000_010, prevHash: genesis.hash, txs: [],
    producer: toHex(alice.publicKey), privateKeyDerHex: toHex(alice.privateKeyDer),
  });
  await expectChainError(applyBlock(genesisState(config), block, { height: 0, hash: genesis.hash }, config.producerPublicKey), "BAD_PRODUCER");
});

test("a block that does not point at the current tip is rejected", async () => {
  const { config, producerKeyHex } = await setup();
  const genesis = genesisBlock(config);
  const block = await buildBlock({
    height: 1, timestamp: 1_700_000_010, prevHash: "f".repeat(64), txs: [],
    producer: config.producerPublicKey, privateKeyDerHex: producerKeyHex,
  });
  await expectChainError(applyBlock(genesisState(config), block, { height: 0, hash: genesis.hash }, config.producerPublicKey), "BAD_PARENT");
});

test("a block that double-spends a nonce inside itself is rejected", async () => {
  const { alice, bob, config, producerKeyHex } = await setup();
  const genesis = genesisBlock(config);
  const pay1 = await signedTransfer(alice, bob.address, "1", 0);
  const pay2 = await signedTransfer(alice, bob.address, "2", 0);
  const block = await buildBlock({
    height: 1, timestamp: 1_700_000_010, prevHash: genesis.hash, txs: [pay1, pay2],
    producer: config.producerPublicKey, privateKeyDerHex: producerKeyHex,
  });
  await expectChainError(applyBlock(genesisState(config), block, { height: 0, hash: genesis.hash }, config.producerPublicKey), "BAD_TX");
});

test("a block with an unsigned extra field in a transaction is rejected", async () => {
  const { alice, bob, config, producerKeyHex } = await setup();
  const genesis = genesisBlock(config);
  const tx = await signedTransfer(alice, bob.address, "1", 0);
  const block = await buildBlock({
    height: 1, timestamp: 1_700_000_010, prevHash: genesis.hash, txs: [tx],
    producer: config.producerPublicKey, privateKeyDerHex: producerKeyHex,
  });
  block.txs[0].memo = "extra";
  await expectChainError(applyBlock(genesisState(config), block, { height: 0, hash: genesis.hash }, config.producerPublicKey), "BAD_TX");
});

test("a chain whose genesis does not match the configured genesis is refused", async () => {
  const { config, alice } = await setup();
  const other = createGenesisConfig({ ...config, chainId: "other", allocations: [alice.address] });
  await assert.rejects(replayChain([genesisBlock(other)], config), (err) => err.code === "BAD_GENESIS");
});
