// Mainnet and Testnet are separate: different genesis, and Testnet data is refused by mainnet rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateValidatorKey, DEFAULT_STAKE } from "../node/tools.js";
import { buildBlock, createGenesisConfig, genesisBlock, replayChain, voteMessage, applyCommitted, genesisState } from "../chain/core.js";
import { signText } from "../chain/crypto.js";
import { makeAccount, signedTransfer } from "./helpers.js";

const T0 = 1_700_000_000;

async function config(chainId, keys, allocations) {
  return createGenesisConfig({
    chainId,
    timestamp: T0,
    allocations,
    validators: keys.map((k) => ({ publicKey: k.publicKey, stake: DEFAULT_STAKE })),
    maxShareBps: 4000,
  });
}

test("Mainnet and Testnet with the same validators and accounts have different genesis blocks", async () => {
  const alice = await makeAccount();
  const keys = [];
  for (let i = 0; i < 4; i++) keys.push(await generateValidatorKey());
  const testnet = await config("snn-testnet", keys, [alice.address]);
  const mainnet = await config("snn-mainnet", keys, [alice.address]);
  assert.notEqual(genesisBlock(testnet).hash, genesisBlock(mainnet).hash);
});

test("a Testnet chain is refused when replayed under Mainnet rules", async () => {
  const alice = await makeAccount();
  const bob = await makeAccount();
  const keys = [];
  for (let i = 0; i < 4; i++) keys.push(await generateValidatorKey());
  const testnet = await config("snn-testnet", keys, [alice.address, bob.address]);
  const mainnet = await config("snn-mainnet", keys, [alice.address, bob.address]);

  const genesis = genesisBlock(testnet);
  const pay = await signedTransfer(alice, bob.address, "1", 0);
  const block = buildBlock({ height: 1, timestamp: T0 + 10, prevHash: genesis.hash, txs: [pay] });
  const signatures = [];
  for (const i of [0, 1, 2]) {
    signatures.push({ validator: keys[i].publicKey, signature: await signText(keys[i].privateKeyDer, voteMessage("snn-testnet", "precommit", 1, 0, block.hash)) });
  }
  const testnetChain = [genesis, { ...block, certificate: { round: 0, signatures } }];

  assert.equal((await replayChain(testnetChain, testnet)).ledger.balanceOf(bob.address).toString(), "101000000");
  await assert.rejects(replayChain(testnetChain, mainnet), { code: "BAD_GENESIS" });
  await assert.rejects(
    applyCommitted(genesisState(mainnet), testnetChain[1], { height: 0, hash: genesisBlock(mainnet).hash, timestamp: T0 }, mainnet),
    { code: "BAD_CERTIFICATE" },
  );
});
