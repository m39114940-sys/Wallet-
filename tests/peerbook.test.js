import { test } from "node:test";
import assert from "node:assert/strict";
import { PeerBook, PeerBookError, normalizeUrl } from "../node/peerbook.js";

const TRUSTED = new Map([["node-a", "pub-a"]]);

test("learned addresses are candidates only and never become active by themselves", () => {
  const book = new PeerBook({ trusted: TRUSTED });
  assert.equal(book.learn(["https://a.example:8443", "https://b.example:8443"]), 2);
  assert.deepEqual(book.activeUrls(), []);
  assert.equal(book.candidateUrls().length, 2);
});

test("admission requires a trusted node identity", () => {
  const book = new PeerBook({ trusted: TRUSTED });
  book.learn(["https://a.example:8443"]);
  assert.throws(() => book.admit("https://a.example:8443", "node-x"), { code: "UNTRUSTED_NODE" });
  assert.deepEqual(book.activeUrls(), []);
  book.admit("https://a.example:8443", "node-a");
  assert.deepEqual(book.activeUrls(), ["https://a.example:8443"]);
  assert.deepEqual(book.candidateUrls(), []);
});

test("invalid addresses are skipped, not stored", () => {
  const book = new PeerBook({ trusted: TRUSTED });
  const added = book.learn([
    "http://plain.example",
    "https://user:pw@x.example",
    "https://q.example/?x=1",
    "not a url",
    42,
    "https://" + "a".repeat(300) + ".example",
    "https://ok.example:8443",
  ]);
  assert.equal(added, 1);
  assert.deepEqual(book.candidateUrls(), ["https://ok.example:8443"]);
});

test("own address and duplicates are ignored", () => {
  const book = new PeerBook({ trusted: TRUSTED, selfUrl: "https://me.example:8443" });
  assert.equal(book.learn(["https://me.example:8443", "https://p.example:8443", "https://p.example:8443/"]), 1);
});

test("a full candidate set drops new addresses without evicting old ones", () => {
  const book = new PeerBook({ trusted: TRUSTED, maxCandidates: 3 });
  book.learn(["https://a1.example", "https://a2.example", "https://a3.example"]);
  assert.equal(book.learn(["https://flood.example"]), 0);
  assert.deepEqual(book.candidateUrls(), ["https://a1.example", "https://a2.example", "https://a3.example"]);
});

test("the active set is bounded", () => {
  const book = new PeerBook({ trusted: new Map([["n1", "k"], ["n2", "k"]]), maxActive: 1 });
  book.learn(["https://a.example", "https://b.example"]);
  book.admit("https://a.example", "n1");
  assert.throws(() => book.admit("https://b.example", "n2"), { code: "FULL" });
});

test("drop removes an active peer", () => {
  const book = new PeerBook({ trusted: TRUSTED });
  book.admit("https://a.example", "node-a");
  book.drop("https://a.example");
  assert.equal(book.isActive("https://a.example"), false);
});

test("learn rejects a non-array list", () => {
  assert.throws(() => new PeerBook().learn("https://a.example"), PeerBookError);
});

test("normalizeUrl canonicalises host and trailing slash", () => {
  assert.equal(normalizeUrl("https://Host.Example:8443/"), "https://host.example:8443");
});

test("a rejected address is not learned again until the rejection expires", () => {
  let t = 0;
  const book = new PeerBook({ trusted: TRUSTED, now: () => t });
  book.learn(["https://bad.example"]);
  book.reject("https://bad.example");
  assert.equal(book.learn(["https://bad.example"]), 0);
  t = 10 * 60 * 1000 + 1;
  assert.equal(book.learn(["https://bad.example"]), 1);
});
