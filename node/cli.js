#!/usr/bin/env node
// Starts one validator node. Example (validator 1 of a 4-validator network):
//   node node/cli.js --port 8001 --data ./data/1 --genesis ./net/genesis.json \
//     --validator-key ./net/validator-1.json --peer https://127.0.0.1:8002 --round-ms 1000
//
// Every node is a validator for now. Relay nodes need their own pinned identity, which is not built yet.

import { readFileSync } from "node:fs";
import { ChainNode, createHttpServer } from "./node.js";
import { fingerprintOfPem } from "./tls.js";
import { openValidatorKey } from "./keyfile.js";

function parseArgs(argv) {
  const args = { peers: [] };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    const value = argv[i + 1];
    if (value === undefined) throw new Error(`missing value for ${key}`);
    if (key === "--peer") args.peers.push(value);
    else args[key.replace(/^--/, "")] = value;
  }
  return args;
}

function fail(message) {
  console.error(message);
  process.exit(2);
}

const args = parseArgs(process.argv.slice(2));
const host = args.host ?? "127.0.0.1";
const port = Number(args.port);
if (!Number.isInteger(port) || !args.data || !args.genesis || !args["validator-key"]) {
  fail(
    "required: --port <n> --data <dir> --genesis <file> --validator-key <file> [--peer <https-url>]... [--round-ms <n>]",
  );
}

const genesis = JSON.parse(readFileSync(args.genesis, "utf8"));
// Encrypted key files need SNN_VALIDATOR_PASSPHRASE in the environment. It is never accepted as an argument.
let validator;
try {
  validator = openValidatorKey(JSON.parse(readFileSync(args["validator-key"], "utf8")), process.env.SNN_VALIDATOR_PASSPHRASE);
} catch (err) {
  fail(`cannot open validator key: ${err.message}`);
}
const entry = genesis.validators.find((v) => v.publicKey === validator.publicKey);
if (!entry) fail("validator key is not in the genesis validator set");
if (!validator.tls?.key || !validator.tls?.cert) fail("validator key file has no TLS identity");
if (fingerprintOfPem(validator.tls.cert) !== entry.tlsFingerprint) {
  fail("TLS certificate does not match the fingerprint in the genesis");
}
for (const peer of args.peers) {
  if (!peer.startsWith("https://")) fail(`peer must use https: ${peer}`);
}

const node = new ChainNode({
  dataDir: args.data,
  genesis,
  validator: { publicKey: validator.publicKey, privateKeyDer: validator.privateKeyDer },
  tlsIdentity: { key: validator.tls.key, cert: validator.tls.cert },
  // --loss-rate is for tests only: it drops that fraction of outbound peer messages.
  lossRate: Number(args["loss-rate"] ?? 0),
  selfUrl: args.self ?? `https://${host}:${port}`,
  roundMs: Number(args["round-ms"] ?? 1000),
  log: (msg) => console.error(JSON.stringify({ event: "log", msg })),
});
await node.init();
for (const peer of args.peers) node.addPeer(peer);

const server = createHttpServer(node, { key: validator.tls.key, cert: validator.tls.cert });
server.listen(port, host, async () => {
  await node.syncFromPeers();
  node.start();
  console.log(JSON.stringify({ event: "ready", url: node.selfUrl, height: node.tip.height }));
});

const shutdown = () => {
  node.stop();
  server.close(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
