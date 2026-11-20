// Validator key files. The consensus signing key and the TLS private key are encrypted with
// AES-256-GCM under a key derived from a passphrase with PBKDF2-SHA256. The public key and the TLS
// certificate stay readable; they are bound to the ciphertext as associated data, so changing them
// makes decryption fail. Runtime uses only node:crypto.

import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto";
import { ChainError } from "../chain/core.js";

export const KEYFILE_FORMAT = "snn-validator-key";
export const KEYFILE_VERSION = 1;
export const DEFAULT_KEYFILE_ITERATIONS = 600_000;
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 1_000_000; // a crafted file must not be able to exhaust a machine's CPU
export const MAX_PASSPHRASE_LENGTH = 256;

export const isEncryptedKeyfile = (obj) => obj?.format === KEYFILE_FORMAT;

const aad = (publicKey, cert) => Buffer.from(`${KEYFILE_FORMAT}|${publicKey}|${cert}`, "utf8");

function deriveKey(passphrase, salt, iterations) {
  return pbkdf2Sync(Buffer.from(passphrase, "utf8"), salt, iterations, 32, "sha256");
}

function checkPassphrase(passphrase) {
  if (typeof passphrase !== "string" || passphrase.length === 0 || passphrase.length > MAX_PASSPHRASE_LENGTH) {
    throw new ChainError("BAD_PASSPHRASE", "كلمة مرور مفتاح المدقق غير صالحة.");
  }
}

// plain: { publicKey, privateKeyDer, tls: { key, cert } }. Returns the file object to write.
export function encryptKeyfile(plain, passphrase, iterations = DEFAULT_KEYFILE_ITERATIONS) {
  checkPassphrase(passphrase);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = deriveKey(passphrase, salt, iterations);
  const secret = Buffer.from(JSON.stringify({ privateKeyDer: plain.privateKeyDer, tlsKey: plain.tls.key }), "utf8");
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(plain.publicKey, plain.tls.cert));
  const data = Buffer.concat([cipher.update(secret), cipher.final()]);
  return {
    format: KEYFILE_FORMAT,
    version: KEYFILE_VERSION,
    publicKey: plain.publicKey,
    tls: { cert: plain.tls.cert },
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt: salt.toString("hex") },
    cipher: { name: "AES-256-GCM", iv: iv.toString("hex"), data: data.toString("hex"), tag: cipher.getAuthTag().toString("hex") },
  };
}

// Returns { publicKey, privateKeyDer, tls: { key, cert } }. Throws one generic error for a wrong
// passphrase and for a tampered file alike.
export function decryptKeyfile(file, passphrase) {
  checkPassphrase(passphrase);
  const { kdf, cipher } = file;
  if (!Number.isInteger(kdf?.iterations) || kdf.iterations < MIN_ITERATIONS || kdf.iterations > MAX_ITERATIONS) {
    throw new ChainError("BAD_KEYFILE", "عدد تكرارات KDF خارج الحدود المسموحة.");
  }
  if (typeof cipher?.tag !== "string" || typeof cipher?.iv !== "string" || typeof cipher?.data !== "string") {
    throw new ChainError("BAD_KEYFILE", "ملف مفتاح المدقق لا يطابق الصيغة.");
  }
  const key = deriveKey(passphrase, Buffer.from(kdf.salt, "hex"), kdf.iterations);
  let secret;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(cipher.iv, "hex"));
    decipher.setAAD(aad(file.publicKey, file.tls.cert));
    decipher.setAuthTag(Buffer.from(cipher.tag, "hex"));
    secret = JSON.parse(Buffer.concat([decipher.update(Buffer.from(cipher.data, "hex")), decipher.final()]).toString("utf8"));
  } catch {
    throw new ChainError("BAD_PASSPHRASE", "كلمة المرور غير صحيحة أو ملف المفتاح تالف.");
  }
  return {
    publicKey: file.publicKey,
    privateKeyDer: secret.privateKeyDer,
    tls: { key: secret.tlsKey, cert: file.tls.cert },
  };
}

// Accepts an encrypted or a plaintext key file. Encrypted files need the passphrase.
export function openValidatorKey(file, passphrase) {
  if (isEncryptedKeyfile(file)) return decryptKeyfile(file, passphrase);
  return file;
}
