// Validator key files: encryption at rest, passphrase checks, and detection of tampering.
import { test } from "node:test";
import assert from "node:assert/strict";
import { encryptKeyfile, decryptKeyfile, openValidatorKey, isEncryptedKeyfile } from "../node/keyfile.js";

const PLAIN = {
  publicKey: "ab".repeat(32),
  privateKeyDer: "cd".repeat(48),
  tls: { key: "-----BEGIN PRIVATE KEY-----\nTESTKEY\n-----END PRIVATE KEY-----\n", cert: "-----BEGIN CERTIFICATE-----\nTESTCERT\n-----END CERTIFICATE-----\n" },
};
const PASS = "correct horse battery";
const FAST = 100_000; // lowest iteration count the reader accepts; keeps the test quick

test("round trip restores the private key and TLS key", () => {
  const file = encryptKeyfile(PLAIN, PASS, FAST);
  assert.equal(isEncryptedKeyfile(file), true);
  assert.deepEqual(decryptKeyfile(file, PASS), PLAIN);
});

test("the private key does not appear in the file in any readable form", () => {
  const text = JSON.stringify(encryptKeyfile(PLAIN, PASS, FAST));
  assert.equal(text.includes(PLAIN.privateKeyDer), false);
  assert.equal(text.includes("TESTKEY"), false);
  assert.equal(text.includes(PLAIN.publicKey), true, "public key stays readable");
});

test("a wrong passphrase fails with a generic error", () => {
  const file = encryptKeyfile(PLAIN, PASS, FAST);
  assert.throws(() => decryptKeyfile(file, "wrong passphrase"), { code: "BAD_PASSPHRASE" });
});

test("tampering with the ciphertext, tag, or bound public fields is detected", () => {
  const file = encryptKeyfile(PLAIN, PASS, FAST);
  const flipped = (hex) => (hex[0] === "0" ? "1" : "0") + hex.slice(1);
  assert.throws(() => decryptKeyfile({ ...file, cipher: { ...file.cipher, data: flipped(file.cipher.data) } }, PASS), { code: "BAD_PASSPHRASE" });
  assert.throws(() => decryptKeyfile({ ...file, cipher: { ...file.cipher, tag: flipped(file.cipher.tag) } }, PASS), { code: "BAD_PASSPHRASE" });
  assert.throws(() => decryptKeyfile({ ...file, publicKey: "ef".repeat(32) }, PASS), { code: "BAD_PASSPHRASE" });
  assert.throws(() => decryptKeyfile({ ...file, tls: { cert: "other" } }, PASS), { code: "BAD_PASSPHRASE" });
});

test("iteration counts outside the accepted range are refused before any work", () => {
  const file = encryptKeyfile(PLAIN, PASS, FAST);
  assert.throws(() => decryptKeyfile({ ...file, kdf: { ...file.kdf, iterations: 5_000_000 } }, PASS), { code: "BAD_KEYFILE" });
  assert.throws(() => decryptKeyfile({ ...file, kdf: { ...file.kdf, iterations: 1 } }, PASS), { code: "BAD_KEYFILE" });
});

test("empty and oversized passphrases are refused", () => {
  assert.throws(() => encryptKeyfile(PLAIN, "", FAST), { code: "BAD_PASSPHRASE" });
  assert.throws(() => encryptKeyfile(PLAIN, "x".repeat(257), FAST), { code: "BAD_PASSPHRASE" });
});

test("openValidatorKey passes plaintext files through and requires a passphrase for encrypted ones", () => {
  assert.deepEqual(openValidatorKey(PLAIN, undefined), PLAIN);
  const file = encryptKeyfile(PLAIN, PASS, FAST);
  assert.throws(() => openValidatorKey(file, undefined), { code: "BAD_PASSPHRASE" });
  assert.deepEqual(openValidatorKey(file, PASS), PLAIN);
});

test("each encryption uses a fresh salt and nonce", () => {
  const a = encryptKeyfile(PLAIN, PASS, FAST);
  const b = encryptKeyfile(PLAIN, PASS, FAST);
  assert.notEqual(a.kdf.salt, b.kdf.salt);
  assert.notEqual(a.cipher.iv, b.cipher.iv);
});
