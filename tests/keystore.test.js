import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createPrivateKey,
  deriveAddress,
  encryptKeystore,
  decryptKeystore,
  toHex,
  fromHex,
} from "../js/keystore.js";
import { isValidAddress } from "../js/ledger.js";

// Lower iteration count keeps the test fast. The app uses the production default.
const TEST_ITERATIONS = 100_000;

test("createPrivateKey returns 32 random bytes", () => {
  const a = createPrivateKey();
  const b = createPrivateKey();
  assert.equal(a.length, 32);
  assert.notDeepEqual(toHex(a), toHex(b));
});

test("deriveAddress is deterministic and produces a valid SNN address", async () => {
  const key = createPrivateKey();
  const first = await deriveAddress(key);
  const second = await deriveAddress(key);
  assert.equal(first, second);
  assert.equal(isValidAddress(first), true);
});

test("keystore round trip restores the same private key and address", async () => {
  const key = createPrivateKey();
  const address = await deriveAddress(key);
  const keystore = await encryptKeystore(key, "correct horse battery", address, TEST_ITERATIONS);

  const { privateKey, address: restored } = await decryptKeystore(keystore, "correct horse battery");
  assert.equal(toHex(privateKey), toHex(key));
  assert.equal(restored, address);
});

test("the stored keystore never contains the plaintext private key", async () => {
  const key = createPrivateKey();
  const address = await deriveAddress(key);
  const keystore = await encryptKeystore(key, "passphrase-1234", address, TEST_ITERATIONS);
  assert.equal(JSON.stringify(keystore).includes(toHex(key)), false);
});

test("a wrong passphrase is rejected with a generic error", async () => {
  const key = createPrivateKey();
  const address = await deriveAddress(key);
  const keystore = await encryptKeystore(key, "right-passphrase", address, TEST_ITERATIONS);
  await assert.rejects(decryptKeystore(keystore, "wrong-passphrase"), /كلمة المرور غير صحيحة/);
});

test("a tampered ciphertext is rejected", async () => {
  const key = createPrivateKey();
  const address = await deriveAddress(key);
  const keystore = await encryptKeystore(key, "right-passphrase", address, TEST_ITERATIONS);
  const data = fromHex(keystore.cipher.data);
  data[0] ^= 0xff;
  keystore.cipher.data = toHex(data);
  await assert.rejects(decryptKeystore(keystore, "right-passphrase"));
});

test("a keystore with weak KDF iterations is refused", async () => {
  const key = createPrivateKey();
  const address = await deriveAddress(key);
  const keystore = await encryptKeystore(key, "right-passphrase", address, TEST_ITERATIONS);
  keystore.kdf.iterations = 1000;
  await assert.rejects(decryptKeystore(keystore, "right-passphrase"), /إعدادات التشفير غير آمنة/);
});

test("fromHex rejects malformed input", () => {
  assert.throws(() => fromHex("xyz"));
  assert.throws(() => fromHex("abc"));
});
