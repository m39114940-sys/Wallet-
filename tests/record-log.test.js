import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordLog, RecordLogError } from "../js/record-log.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "snn-log-"));
}

test("records survive reopen, split across segments, and are read back by sequence", () => {
  const dir = tempDir();
  try {
    const log = new RecordLog(dir, { segmentRecords: 2 });
    for (let i = 1; i <= 5; i++) assert.equal(log.append({ n: i }), i);
    const reopened = new RecordLog(dir, { segmentRecords: 2 });
    assert.equal(reopened.length, 5);
    assert.deepEqual(reopened.get(4), { n: 4 });
    assert.equal(reopened.append({ n: 6 }), 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("an edited record is detected on open", () => {
  const dir = tempDir();
  try {
    const log = new RecordLog(dir, { segmentRecords: 10 });
    log.append({ amount: "100" });
    log.append({ amount: "200" });
    const path = join(dir, "seg-000001.log");
    writeFileSync(path, readFileSync(path, "utf8").replace('"100"', '"999"'));
    assert.throws(() => new RecordLog(dir, { segmentRecords: 10 }), { code: "LOG_CORRUPT" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a removed or reordered line breaks the hash chain", () => {
  const dir = tempDir();
  try {
    const log = new RecordLog(dir, { segmentRecords: 10 });
    for (let i = 1; i <= 3; i++) log.append({ n: i });
    const path = join(dir, "seg-000001.log");
    const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
    writeFileSync(path, [lines[0], lines[2]].join("\n") + "\n");
    assert.throws(() => new RecordLog(dir, { segmentRecords: 10 }), { code: "LOG_CORRUPT" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("reading outside the log is refused", () => {
  const dir = tempDir();
  try {
    const log = new RecordLog(dir, { segmentRecords: 10 });
    log.append({ n: 1 });
    assert.throws(() => log.get(2), (e) => e instanceof RecordLogError && e.code === "OUT_OF_RANGE");
    assert.throws(() => log.get(0), { code: "OUT_OF_RANGE" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
