import { test } from "node:test";
import assert from "node:assert/strict";
import { createKeystore, parseKeystoreFile, unlockKeystore, MAX_ITERATIONS, MAX_KEYSTORE_BYTES } from "../js/keystore.js";
import { toHex, createAccount, addressFromPublicKey } from "../js/signing.js";

// Lower iteration count keeps the test fast. The app uses the production default.
const TEST_ITERATIONS = 100_000;
const PASS = "right-passphrase-1";

test("a new keystore is version 2 with an Ed25519 public key and a matching address", async () => {
  const { keystore } = await createKeystore(PASS, TEST_ITERATIONS);
  assert.equal(keystore.version, 2);
  assert.equal(keystore.publicKey.length, 64);
  assert.equal(keystore.address, await addressFromPublicKey(Uint8Array.from(Buffer.from(keystore.publicKey, "hex"))));
});

test("unlock restores a signing key whose public key matches the stored one", async () => {
  const { keystore } = await createKeystore(PASS, TEST_ITERATIONS);
  const unlocked = await unlockKeystore(JSON.parse(JSON.stringify(keystore)), PASS);
  assert.equal(unlocked.address, keystore.address);
  assert.equal(toHex(unlocked.publicKey), keystore.publicKey);
});

test("the stored keystore never contains the plaintext private key", async () => {
  const { keystore, privateKeyDer } = await createKeystore(PASS, TEST_ITERATIONS);
  assert.equal(JSON.stringify(keystore).includes(toHex(privateKeyDer)), false);
});

test("a wrong passphrase is rejected with a generic error", async () => {
  const { keystore } = await createKeystore(PASS, TEST_ITERATIONS);
  await assert.rejects(unlockKeystore(keystore, "wrong-passphrase-1"), /كلمة المرور غير صحيحة/);
});

test("a tampered ciphertext is rejected", async () => {
  const { keystore } = await createKeystore(PASS, TEST_ITERATIONS);
  const flipped = keystore.cipher.data.slice(0, 2) === "00" ? "ff" + keystore.cipher.data.slice(2) : "00" + keystore.cipher.data.slice(2);
  keystore.cipher.data = flipped;
  await assert.rejects(unlockKeystore(keystore, PASS));
});

test("version 1 keystores from the earlier prototype are refused", () => {
  const legacy = {
    format: "snn-keystore",
    version: 1,
    address: "snn1" + "a".repeat(40),
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations: 600000, salt: "a".repeat(32) },
    cipher: { name: "AES-256-GCM", iv: "a".repeat(24), data: "a".repeat(128) },
  };
  assert.throws(() => parseKeystoreFile(JSON.stringify(legacy)), /الإصدار 2/);
});

test("a keystore paired with someone else's public key is rejected", async () => {
  const { keystore } = await createKeystore(PASS, TEST_ITERATIONS);
  const other = await createAccount();
  keystore.publicKey = toHex(other.publicKey);
  await assert.rejects(unlockKeystore(keystore, PASS));
});
