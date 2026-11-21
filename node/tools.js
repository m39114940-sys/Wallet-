// Creates the files a network needs: a genesis config and one key file per validator.
// Usage: node node/tools.js init <dir> <chainId> <address> [<address> ...]
// Default: 4 validators with equal stake and a 40% weight cap, so a 4-node test network can run.
// Production networks need at least 10 validators for a 10% cap (see docs/consensus-design.md).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createAccount, toHex } from "../js/signing.js";
import { createGenesisConfig } from "../chain/core.js";
import { createTlsIdentity } from "./tls.js";
import { encryptKeyfile } from "./keyfile.js";
import { createNodeIdentity, saveNodeIdentity } from "./identity.js";

export const DEFAULT_VALIDATORS = 4;
export const DEFAULT_MAX_SHARE_BPS = 4000; // 40%, for a 4-validator test network
export const DEFAULT_STAKE = "1000000000"; // 1000 SNN in micro-units

export async function generateValidatorKey() {
  const account = await createAccount();
  return { privateKeyDer: toHex(account.privateKeyDer), publicKey: toHex(account.publicKey) };
}

// passphrase: when set, every validator file is encrypted with it. When null, files are plaintext (tests only).
export async function initNetwork(dir, chainId, allocations, { count = DEFAULT_VALIDATORS, maxShareBps = DEFAULT_MAX_SHARE_BPS, passphrase = null } = {}) {
  mkdirSync(dir, { recursive: true });
  const validators = [];
  for (let i = 1; i <= count; i++) {
    const key = await generateValidatorKey();
    key.tls = createTlsIdentity(`snn-validator-${i}`); // { key, cert, fingerprint }
    validators.push(key);
  }
  const genesis = createGenesisConfig({
    chainId,
    timestamp: Math.floor(Date.now() / 1000),
    allocations,
    validators: validators.map((v) => ({
      publicKey: v.publicKey,
      stake: DEFAULT_STAKE,
      tlsFingerprint: v.tls.fingerprint,
    })),
    maxShareBps,
  });
  writeFileSync(join(dir, "genesis.json"), JSON.stringify(genesis, null, 2));
  validators.forEach((key, i) => {
    const { fingerprint, ...tls } = key.tls; // the file keeps the key material, not the derived fingerprint
    const file = passphrase === null ? { ...key, tls } : encryptKeyfile({ ...key, tls }, passphrase);
    writeFileSync(join(dir, `validator-${i + 1}.json`), JSON.stringify(file, null, 2), { mode: 0o600 });
  });
  return { genesis, validators };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv[2] === "identity") {
    const file = process.argv[3];
    const passphrase = process.env.SNN_IDENTITY_PASSPHRASE;
    if (!file || !passphrase) {
      console.error("usage: SNN_IDENTITY_PASSPHRASE=... node node/tools.js identity <file>");
      process.exit(2);
    }
    const identity = await createNodeIdentity();
    saveNodeIdentity(file, identity, passphrase);
    console.log(JSON.stringify({ nodeId: identity.nodeId, publicKey: identity.publicKey, file }));
    process.exit(0);
  }
  const [command, dir, chainId, ...allocations] = process.argv.slice(2);
  if (command !== "init" || !dir || !chainId || allocations.length === 0) {
    console.error("usage: node node/tools.js init <dir> <chainId> <address> [<address> ...]");
    process.exit(2);
  }
  const passphrase = process.env.SNN_VALIDATOR_PASSPHRASE;
  if (!passphrase) {
    console.error("set SNN_VALIDATOR_PASSPHRASE to encrypt the validator key files");
    process.exit(2);
  }
  await initNetwork(dir, chainId, allocations, { passphrase });
  console.log(`network files written to ${dir}`);
}
