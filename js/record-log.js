// Append-only record log: one JSON line per record, split into numbered segment files.
// Each entry commits to the previous entry's hash, so an edited, removed or reordered line is detected on open.
// Standalone: not used by the chain or the ledger yet.
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { canonicalJson } from "../chain/crypto.js";

export const LOG_SEGMENT_RECORDS = 1_000_000;
const GENESIS_PREV = "0".repeat(64);
const SEGMENT_PATTERN = /^seg-(\d{6})\.log$/;

export class RecordLogError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "RecordLogError";
    this.code = code;
  }
}

// A line that is not valid JSON is most often a write cut short by a power loss. Refuse it with a clear reason.
function parseLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    throw new RecordLogError("LOG_CORRUPT", "سطر غير مكتمل أو تالف في السجل (ربما انقطاع أثناء الكتابة).");
  }
}

const hashOf = (seq, prev, record) =>
  createHash("sha256").update(canonicalJson({ seq, prev, record })).digest("hex");

const segmentName = (index) => `seg-${String(index).padStart(6, "0")}.log`;

export class RecordLog {
  #dir;
  #segmentRecords;
  #count = 0;
  #lastHash = GENESIS_PREV;

  // Opens the log and verifies every existing entry. Throws LOG_CORRUPT on any mismatch.
  constructor(dir, { segmentRecords = LOG_SEGMENT_RECORDS } = {}) {
    if (!Number.isSafeInteger(segmentRecords) || segmentRecords <= 0) {
      throw new RecordLogError("BAD_OPTIONS", "حجم المقطع يجب أن يكون عدداً صحيحاً موجباً.");
    }
    this.#dir = dir;
    this.#segmentRecords = segmentRecords;
    mkdirSync(dir, { recursive: true });
    this.#verifyExisting();
  }

  get length() {
    return this.#count;
  }

  #segments() {
    return readdirSync(this.#dir)
      .filter((name) => SEGMENT_PATTERN.test(name))
      .sort();
  }

  #verifyExisting() {
    const names = this.#segments();
    names.forEach((name, i) => {
      if (name !== segmentName(i + 1)) throw new RecordLogError("LOG_CORRUPT", "أرقام المقاطع غير متسلسلة.");
    });
    for (const name of names) {
      const lines = readFileSync(join(this.#dir, name), "utf8").split("\n").filter((l) => l.length > 0);
      for (const line of lines) {
        this.#checkEntry(parseLine(line));
      }
    }
  }

  #checkEntry(entry) {
    const seq = this.#count + 1;
    if (entry.seq !== seq) throw new RecordLogError("LOG_CORRUPT", `ترقيم السجل غير متسلسل عند ${seq}.`);
    if (entry.prev !== this.#lastHash) throw new RecordLogError("LOG_CORRUPT", `سلسلة التجزئة مكسورة عند ${seq}.`);
    if (entry.hash !== hashOf(entry.seq, entry.prev, entry.record)) {
      throw new RecordLogError("LOG_CORRUPT", `بصمة السجل لا تطابق محتواه عند ${seq}.`);
    }
    this.#count = seq;
    this.#lastHash = entry.hash;
  }

  // Appends one record and flushes it to disk before returning its sequence number.
  append(record) {
    const seq = this.#count + 1;
    const hash = hashOf(seq, this.#lastHash, record);
    const entry = { seq, prev: this.#lastHash, record, hash };
    const index = Math.floor((seq - 1) / this.#segmentRecords) + 1;
    const path = join(this.#dir, segmentName(index));
    const fd = openSync(path, "a");
    try {
      writeSync(fd, JSON.stringify(entry) + "\n");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    this.#count = seq;
    this.#lastHash = hash;
    return seq;
  }

  // Reads one record by sequence number, after re-checking its entry hash.
  get(seq) {
    if (!Number.isSafeInteger(seq) || seq < 1 || seq > this.#count) {
      throw new RecordLogError("OUT_OF_RANGE", "رقم السجل خارج النطاق.");
    }
    const index = Math.floor((seq - 1) / this.#segmentRecords) + 1;
    const lines = readFileSync(join(this.#dir, segmentName(index)), "utf8").split("\n").filter((l) => l.length > 0);
    const entry = parseLine(lines[(seq - 1) % this.#segmentRecords]);
    if (entry.seq !== seq || entry.hash !== hashOf(entry.seq, entry.prev, entry.record)) {
      throw new RecordLogError("LOG_CORRUPT", `السجل ${seq} تالف.`);
    }
    return entry.record;
  }
}
