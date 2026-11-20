#!/usr/bin/env node
// Starts one SNN node. Example (validator 1 of a 4-validator network):
//   node node/cli.js --port 8001 --data ./data/1 --genesis ./net/genesis.json \
//     --validator-key ./net/validator-1.json --peer http://127.0.0.1:8002 --round-ms 1000

import { readFileSync } from "node:fs";
import { ChainNode, createHttpServer } from "./node.js";

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

const args = parseArgs(process.argv.slice(2));
const host = args.host ?? "127.0.0.1";
const port = Number(args.port);
if (!Number.isInteger(port) || !args.data || !args.genesis) {
  console.error(
    "required: --port <n> --data <dir> --genesis <file> [--validator-key <file>] [--peer <url>]... [--round-ms <n>]",
  );
  process.exit(2);
}

const genesis = JSON.parse(readFileSync(args.genesis, "utf8"));
const validator = args["validator-key"] ? JSON.parse(readFileSync(args["validator-key"], "utf8")) : null;
if (validator && !genesis.validators.some((v) => v.publicKey === validator.publicKey)) {
  console.error("validator key is not in the genesis validator set");
  process.exit(2);
}

const node = new ChainNode({
  dataDir: args.data,
  genesis,
  validator,
  selfUrl: args.self ?? `http://${host}:${port}`,
  roundMs: Number(args["round-ms"] ?? 1000),
  log: (msg) => console.error(JSON.stringify({ event: "log", msg })),
});
await node.init();
for (const peer of args.peers) node.addPeer(peer);

const server = createHttpServer(node);
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
