// Creates the files a network needs: a genesis config and a producer key.
// Usage: node node/tools.js init <dir> <chainId> <address> [<address> ...]

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAccount, toHex } from "../js/signing.js";
import { createGenesisConfig } from "../chain/core.js";

export async function generateProducerKey() {
  const account = await createAccount();
  return { privateKeyDer: toHex(account.privateKeyDer), publicKey: toHex(account.publicKey) };
}

export async function initNetwork(dir, chainId, allocations) {
  mkdirSync(dir, { recursive: true });
  const producer = await generateProducerKey();
  const genesis = createGenesisConfig({
    chainId,
    timestamp: Math.floor(Date.now() / 1000),
    allocations,
    producerPublicKey: producer.publicKey,
  });
  writeFileSync(join(dir, "genesis.json"), JSON.stringify(genesis, null, 2));
  writeFileSync(join(dir, "producer.json"), JSON.stringify(producer, null, 2), { mode: 0o600 });
  return { genesis, producer };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, dir, chainId, ...allocations] = process.argv.slice(2);
  if (command !== "init" || !dir || !chainId || allocations.length === 0) {
    console.error("usage: node node/tools.js init <dir> <chainId> <address> [<address> ...]");
    process.exit(2);
  }
  await initNetwork(dir, chainId, allocations);
  console.log(`network files written to ${dir}`);
}
