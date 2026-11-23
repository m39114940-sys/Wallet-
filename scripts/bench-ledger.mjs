// Measures ledger throughput, replay time, and record-log cost on this machine.
// Run: node scripts/bench-ledger.mjs [transfers]
// Not part of npm test. Results depend on the machine; record them with the hardware.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { Ledger } from "../js/ledger.js";
import { RecordLog } from "../js/record-log.js";
import { makeAccount, signedTransfer } from "../tests/helpers.js";

const N = Number(process.argv[2] ?? 2000);
const ms = (t0) => (performance.now() - t0).toFixed(1);

const sender = await makeAccount();
const receiver = await makeAccount();
const ledger = new Ledger();
ledger.genesisMint(sender.address, 10n ** 12n); // 1,000,000 SNN, within the 18-digit record limit

// Build the signed transfers first, so only the ledger work is timed below.
const txs = [];
for (let n = 0; n < N; n++) txs.push(await signedTransfer(sender, receiver.address, "0.000001", n));

let t = performance.now();
for (const tx of txs) await ledger.transfer(tx);
const applyMs = performance.now() - t;
console.log(`apply ${N} signed transfers: ${applyMs.toFixed(1)} ms total, ${(applyMs / N).toFixed(3)} ms per transfer`);

const snapshot = JSON.parse(JSON.stringify(ledger.toJSON()));
t = performance.now();
await Ledger.fromSnapshot(snapshot);
console.log(`replay ${N} signed transfers from snapshot (verifies every signature): ${ms(t)} ms`);

const dir = mkdtempSync(join(tmpdir(), "snn-bench-"));
try {
  const log = new RecordLog(dir);
  t = performance.now();
  for (const tx of txs) log.append({ from: tx.from, to: tx.to, amount: tx.amount, nonce: tx.nonce });
  const appendMs = performance.now() - t;
  console.log(`record-log append ${N} records (fsync each): ${(appendMs / N).toFixed(3)} ms per record`);

  t = performance.now();
  const reopened = new RecordLog(dir);
  console.log(`record-log reopen and verify ${reopened.length} records: ${ms(t)} ms`);

  t = performance.now();
  for (let i = 1; i <= 200; i++) reopened.get(Math.ceil((i * reopened.length) / 200));
  console.log(`record-log random get (200 reads): ${((performance.now() - t) / 200).toFixed(3)} ms per read`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
