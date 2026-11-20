// Creates the files a network needs: a genesis config and one key file per validator.
// Usage: node node/tools.js init <dir> <chainId> <address> [<address> ...]
// Default: 4 validators with equal stake and a 40% weight cap, so a 4-node test network can run.
// Production networks need at least 10 validators for a 10% cap (see docs/consensus-design.md).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAccount, toHex } from "../js/signing.js";
import { createGenesisConfig } from "../chain/core.js";

export const DEFAULT_VALIDATORS = 4;
export const DEFAULT_MAX_SHARE_BPS = 4000; // 40%, for a 4-validator test network
export const DEFAULT_STAKE = "1000000000"; // 1000 SNN in micro-units

export async function generateValidatorKey() {
  const account = await createAccount();
  return { privateKeyDer: toHex(account.privateKeyDer), publicKey: toHex(account.publicKey) };
}

export async function initNetwork(dir, chainId, allocations, { count = DEFAULT_VALIDATORS, maxShareBps = DEFAULT_MAX_SHARE_BPS } = {}) {
  mkdirSync(dir, { recursive: true });
  const validators = [];
  for (let i = 1; i <= count; i++) validators.push(await generateValidatorKey());
  const genesis = createGenesisConfig({
    chainId,
    timestamp: Math.floor(Date.now() / 1000),
    allocations,
    validators: validators.map((v) => ({ publicKey: v.publicKey, stake: DEFAULT_STAKE })),
    maxShareBps,
  });
  writeFileSync(join(dir, "genesis.json"), JSON.stringify(genesis, null, 2));
  validators.forEach((key, i) => {
    writeFileSync(join(dir, `validator-${i + 1}.json`), JSON.stringify(key, null, 2), { mode: 0o600 });
  });
  return { genesis, validators };
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
