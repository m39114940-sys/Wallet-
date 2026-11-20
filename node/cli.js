#!/usr/bin/env node
// Starts one SNN node. Example:
//   node node/cli.js --port 8001 --data ./data/a --genesis ./net/genesis.json --producer-key ./net/producer.json

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
  console.error("required: --port <n> --data <dir> --genesis <file> [--producer-key <file>] [--peer <url>]...");
  process.exit(2);
}

const genesis = JSON.parse(readFileSync(args.genesis, "utf8"));
const producer = args["producer-key"] ? JSON.parse(readFileSync(args["producer-key"], "utf8")) : null;
if (producer && producer.publicKey !== genesis.producerPublicKey) {
  console.error("producer key does not match the genesis producer");
  process.exit(2);
}

const node = new ChainNode({
  dataDir: args.data,
  genesis,
  producer,
  selfUrl: args.self ?? `http://${host}:${port}`,
});
await node.init();
for (const peer of args.peers) node.addPeer(peer);

const server = createHttpServer(node);
server.listen(port, host, async () => {
  await node.syncFromPeers();
  console.log(JSON.stringify({ event: "ready", url: node.selfUrl, height: node.tip.height }));
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
