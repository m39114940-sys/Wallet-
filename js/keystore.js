// Encrypted keystore for Ed25519 accounts. The private key is encrypted with AES-256-GCM,
// using a key derived from the passphrase with PBKDF2-SHA256. It is never stored in plaintext.

import {
  createAccount,
  addressFromPublicKey,
  importSigningKey,
  keyMatchesPublicKey,
  toHex,
  fromHex,
  PKCS8_PRIVATE_KEY_BYTES,
  PUBLIC_KEY_BYTES,
} from "./signing.js";
import { isValidAddress } from "./ledger.js";

export const DEFAULT_ITERATIONS = 600_000;
export const MIN_ITERATIONS = 100_000;
export const MAX_ITERATIONS = 1_000_000; // upper bound so a crafted file cannot exhaust a phone's CPU
export const MAX_PASSPHRASE_LENGTH = 256;
export const MAX_KEYSTORE_BYTES = 4096;

const KEYSTORE_KEYS = ["address", "cipher", "format", "kdf", "publicKey", "version"];
const KDF_KEYS = ["hash", "iterations", "name", "salt"];
const CIPHER_KEYS = ["data", "iv", "name"];
const SALT_HEX = /^[0-9a-f]{32}$/; // 16 bytes
const IV_HEX = /^[0-9a-f]{24}$/; // 12 bytes
const PUBLIC_KEY_HEX = /^[0-9a-f]{64}$/; // 32 bytes
const CIPHER_HEX = /^[0-9a-f]{128}$/; // 48-byte PKCS#8 plus 16-byte GCM tag
const encoder = new TextEncoder();

const sameKeys = (obj, expected) => Object.keys(obj).sort().join() === [...expected].sort().join();

async function deriveWrappingKey(passphrase, salt, iterations) {
  const base = await globalThis.crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return globalThis.crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function createKeystore(passphrase, iterations = DEFAULT_ITERATIONS) {
  const account = await createAccount();
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(16));
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveWrappingKey(passphrase, salt, iterations);
  const cipher = new Uint8Array(
    await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, account.privateKeyDer),
  );
  return {
    keystore: {
      format: "snn-keystore",
      version: 2,
      address: account.address,
      publicKey: toHex(account.publicKey),
      kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt: toHex(salt) },
      cipher: { name: "AES-256-GCM", iv: toHex(iv), data: toHex(cipher) },
    },
    privateKeyDer: account.privateKeyDer,
  };
}

// Strict validation of an uploaded file: exact key sets, exact hex lengths, bounded iterations, bounded size.
export function parseKeystoreFile(text) {
  if (typeof text !== "string" || text.length === 0 || encoder.encode(text).length > MAX_KEYSTORE_BYTES) {
    throw new Error("ملف المحفظة غير صالح أو كبير الحجم.");
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("ملف المحفظة ليس JSON صالحاً.");
  }
  const valid =
    data !== null &&
    typeof data === "object" &&
    !Array.isArray(data) &&
    sameKeys(data, KEYSTORE_KEYS) &&
    data.format === "snn-keystore" &&
    data.version === 2 &&
    isValidAddress(data.address) &&
    typeof data.publicKey === "string" &&
    PUBLIC_KEY_HEX.test(data.publicKey) &&
    data.kdf !== null &&
    typeof data.kdf === "object" &&
    sameKeys(data.kdf, KDF_KEYS) &&
    data.kdf.name === "PBKDF2" &&
    data.kdf.hash === "SHA-256" &&
    Number.isInteger(data.kdf.iterations) &&
    data.kdf.iterations >= MIN_ITERATIONS &&
    data.kdf.iterations <= MAX_ITERATIONS &&
    typeof data.kdf.salt === "string" &&
    SALT_HEX.test(data.kdf.salt) &&
    data.cipher !== null &&
    typeof data.cipher === "object" &&
    sameKeys(data.cipher, CIPHER_KEYS) &&
    data.cipher.name === "AES-256-GCM" &&
    typeof data.cipher.iv === "string" &&
    IV_HEX.test(data.cipher.iv) &&
    typeof data.cipher.data === "string" &&
    CIPHER_HEX.test(data.cipher.data);
  if (!valid) {
    throw new Error("ملف المحفظة لا يطابق صيغة SNN الحالية (الإصدار 2).");
  }
  return data;
}

// Throws a generic error for a wrong passphrase and for a tampered file alike.
export async function unlockKeystore(keystore, passphrase) {
  const parsed = parseKeystoreFile(JSON.stringify(keystore));
  if (typeof passphrase !== "string" || passphrase.length === 0 || passphrase.length > MAX_PASSPHRASE_LENGTH) {
    throw new Error("كلمة المرور غير صحيحة أو ملف المحفظة تالف.");
  }

  const key = await deriveWrappingKey(passphrase, fromHex(parsed.kdf.salt), parsed.kdf.iterations);
  let privateKeyDer;
  try {
    const plain = await globalThis.crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromHex(parsed.cipher.iv) },
      key,
      fromHex(parsed.cipher.data),
    );
    privateKeyDer = new Uint8Array(plain);
  } catch {
    throw new Error("كلمة المرور غير صحيحة أو ملف المحفظة تالف.");
  }
  if (privateKeyDer.length !== PKCS8_PRIVATE_KEY_BYTES) {
    throw new Error("كلمة المرور غير صحيحة أو ملف المحفظة تالف.");
  }

  const publicKey = fromHex(parsed.publicKey);
  if (publicKey.length !== PUBLIC_KEY_BYTES) throw new Error("ملف المحفظة لا يطابق المفتاح العام.");
  if ((await addressFromPublicKey(publicKey)) !== parsed.address) {
    throw new Error("ملف المحفظة لا يطابق العنوان المسجل.");
  }

  const signingKey = await importSigningKey(privateKeyDer);
  if (!(await keyMatchesPublicKey(signingKey, publicKey))) {
    throw new Error("ملف المحفظة لا يطابق المفتاح العام.");
  }
  return { signingKey, publicKey, address: parsed.address };
}
