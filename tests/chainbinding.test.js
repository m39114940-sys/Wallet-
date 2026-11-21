// Chain-bound transfers (v2): a transfer signed for one chain cannot be replayed on another.
// Hybrid rules require binding; Testnet rules still accept legacy transfers (KNOWN GAP 19 stays open there).
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyBlock, buildBlock, createGenesisConfig, genesisBlock, genesisState, withWork } from "../chain/core.js";
import { Ledger, TESTNET_FAUCET_UNITS } from "../js/ledger.js";
import { makeAccount, signedTransfer } from "./helpers.js";

const T0 = 1_700_000_000;
const EASY = "0000" + "f".repeat(60);

async function setup(chainId, { hybrid = false, accounts } = {}) {
  const alice = accounts?.alice ?? (await makeAccount());
  const bob = accounts?.bob ?? (await makeAccount());
  const config = createGenesisConfig({
    chainId,
    timestamp: T0,
    allocations: [alice.address, bob.address],
    validators: [{ publicKey: "11".repeat(32), stake: "1000" }],
    maxShareBps: 10000,
    rules: hybrid ? "hybrid-v1" : undefined,
    powTarget: hybrid ? EASY : undefined,
  });
  return { alice, bob, config, genesis: genesisBlock(config), state0: genesisState(config) };
}

test("a transfer bound to its chain verifies there and not on another chain", async () => {
  const a = await makeAccount();
  const b = await makeAccount();
  const pay = await signedTransfer(a, b.address, "3", 0, "snn-chain-a");
  const funded = () => { const l = new Ledger(); l.credit(a.address, TESTNET_FAUCET_UNITS); return l; };
  await funded().transfer(pay);
  await assert.rejects(funded().transfer({ ...pay, chainId: "snn-chain-b" }), { code: "BAD_SIGNATURE" });
});

test("a legacy transfer without a chain id still verifies (existing wallet history)", async () => {
  const a = await makeAccount();
  const b = await makeAccount();
  const legacy = await signedTransfer(a, b.address, "3", 0);
  const l = new Ledger();
  l.credit(a.address, TESTNET_FAUCET_UNITS);
  await l.transfer(legacy);
  assert.equal(legacy.chainId, undefined);
});

test("a bound transfer cannot be given a different chain id after signing", async () => {
  const a = await makeAccount();
  const b = await makeAccount();
  const pay = await signedTransfer(a, b.address, "3", 0, "snn-chain-a");
  await assert.rejects(new Ledger().transfer({ ...pay, chainId: "snn-chain-b" }), { code: "BAD_SIGNATURE" });
});

test("a hybrid chain refuses a legacy transfer that is not bound to it", async () => {
  const s = await setup("snn-mainnet-test", { hybrid: true });
  const pay = await signedTransfer(s.alice, s.bob.address, "3", 0);
  const block = withWork(buildBlock({ height: 1, timestamp: T0 + 10, prevHash: s.genesis.hash, txs: [pay] }), s.config, s.genesis);
  await assert.rejects(applyBlock(s.state0, block, s.genesis, s.config), { code: "TX_UNBOUND" });
});

test("a hybrid chain refuses a transfer bound to another chain", async () => {
  const s = await setup("snn-mainnet-test", { hybrid: true });
  const pay = await signedTransfer(s.alice, s.bob.address, "3", 0, "snn-other-chain");
  const block = withWork(buildBlock({ height: 1, timestamp: T0 + 10, prevHash: s.genesis.hash, txs: [pay] }), s.config, s.genesis);
  await assert.rejects(applyBlock(s.state0, block, s.genesis, s.config), { code: "TX_UNBOUND" });
});

test("on Testnet rules too, a transfer bound to chain A is refused on chain B with the same accounts", async () => {
  const alice = await makeAccount();
  const bob = await makeAccount();
  const b = await setup("snn-chain-b", { accounts: { alice, bob } });
  const pay = await signedTransfer(alice, bob.address, "3", 0, "snn-chain-a");
  const block = buildBlock({ height: 1, timestamp: T0 + 10, prevHash: b.genesis.hash, txs: [pay] });
  await assert.rejects(applyBlock(b.state0, block, b.genesis, b.config), { code: "TX_UNBOUND" });
});
