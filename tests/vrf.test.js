import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { vrfProve, vrfVerify, vrfPublicKey } from "../chain/vrf.js";

const SK = "c5aa8df43f9f837bedb7442f31dcb7b166d38535076f094b85ce3a2e0b4458f7";
const ALPHA = "af82";

// RFC 9381, Appendix B.3, Example 18 (ECVRF-EDWARDS25519-SHA512-TAI). Values checked against the RFC text.
// An earlier version of this file carried a mis-transcribed vector, which looked like an implementation mismatch.
test("RFC 9381 B.3 example 18 (ECVRF-EDWARDS25519-SHA512-TAI)", () => {
  const PK = "fc51cd8e6218a1a38da47ed00230f0580816ed13ba3303ac5deb911548908025";
  const PI = [
    "9bc0f79119cc5604bf02d23b4caede71393cedfbb191434dd016d30177ccb",
    "f8096bb474e53895c362d8628ee9f9ea3c0e52c7a5c691b6c18c9979866568add7",
    "a2d41b00b05081ed0f58ee5e31b3a970e",
  ].join("");
  const BETA = [
    "645427e5d00c62a23fb703732fa5d892940935942101e456ecca7bb217c",
    "61c452118fec1219202a0edcf038bb6373241578be7217ba85a2687f7a0310b2df",
    "19f",
  ].join("");
  assert.equal(vrfPublicKey(SK), PK);
  assert.equal(vrfProve(SK, ALPHA), PI);
  assert.equal(vrfVerify(PK, ALPHA, PI), BETA);
});

test("public key matches Node's Ed25519 key for random seeds", () => {
  for (let i = 0; i < 10; i++) {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const der = privateKey.export({ format: "der", type: "pkcs8" });
    const seed = der.subarray(der.length - 32).toString("hex");
    const nodePk = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
    assert.equal(vrfPublicKey(seed), nodePk);
  }
});

test("prove then verify round-trips and yields a 64-byte output", () => {
  const pk = vrfPublicKey(SK);
  const pi = vrfProve(SK, ALPHA);
  assert.equal(pi.length, 160); // 80 bytes
  const beta = vrfVerify(pk, ALPHA, pi);
  assert.match(beta, /^[0-9a-f]{128}$/);
});

test("proving is deterministic for the same key and input", () => {
  assert.equal(vrfProve(SK, ALPHA), vrfProve(SK, ALPHA));
});

test("output differs for different inputs", () => {
  const pk = vrfPublicKey(SK);
  const b1 = vrfVerify(pk, ALPHA, vrfProve(SK, ALPHA));
  const b2 = vrfVerify(pk, "af83", vrfProve(SK, "af83"));
  assert.notEqual(b1, b2);
});

test("tampered proof is rejected", () => {
  const pk = vrfPublicKey(SK);
  const pi = vrfProve(SK, ALPHA);
  const bad = (pi[20] === "0" ? "1" : "0");
  const tampered = pi.slice(0, 20) + bad + pi.slice(21);
  assert.equal(vrfVerify(pk, ALPHA, tampered), null);
});

test("proof for one alpha is rejected for another", () => {
  const pk = vrfPublicKey(SK);
  assert.equal(vrfVerify(pk, "af83", vrfProve(SK, ALPHA)), null);
});

test("proof from another key is rejected", () => {
  const otherPk = vrfPublicKey("11".repeat(32));
  assert.equal(vrfVerify(otherPk, ALPHA, vrfProve(SK, ALPHA)), null);
});

test("scalar s not below the group order is rejected", () => {
  const pk = vrfPublicKey(SK);
  const pi = vrfProve(SK, ALPHA);
  const badS = "ff".repeat(32); // 2^256 - 1 is above the group order
  assert.equal(vrfVerify(pk, ALPHA, pi.slice(0, 96) + badS), null);
});

test("a gamma that is not a valid point is rejected", () => {
  const pk = vrfPublicKey(SK);
  const pi = vrfProve(SK, ALPHA);
  const invalidGamma = "ff".repeat(31) + "7f"; // y = 2^255 - 1, which is not a canonical field element
  assert.equal(vrfVerify(pk, ALPHA, invalidGamma + pi.slice(64)), null);
});

test("an invalid public key is rejected", () => {
  const pi = vrfProve(SK, ALPHA);
  assert.equal(vrfVerify("ff".repeat(32), ALPHA, pi), null);
});

test("malformed proof length is rejected", () => {
  const pk = vrfPublicKey(SK);
  assert.equal(vrfVerify(pk, ALPHA, "00".repeat(79)), null);
});
