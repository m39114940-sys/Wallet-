// Key generation and encrypted keystore, built only on the Web Crypto API.
// Private keys never leave the browser and are never stored in plaintext.
//
// Limitation: addresses are derived with SHA-256 over the private key. This is a demo derivation,
// not the Ed25519 public-key scheme that the SNN spec requires. Signing is not implemented yet.

const PBKDF2_ITERATIONS = 600_000;
const ADDRESS_DOMAIN = "SNN-DEMO-ADDRESS-v1";
const encoder = new TextEncoder();

export const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

export const fromHex = (hex) => {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    throw new Error("قيمة hex غير صالحة.");
  }
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
};

export function createPrivateKey() {
  return crypto.getRandomValues(new Uint8Array(32));
}

export async function deriveAddress(privateKey) {
  const domain = encoder.encode(ADDRESS_DOMAIN);
  const input = new Uint8Array(domain.length + privateKey.length);
  input.set(domain, 0);
  input.set(privateKey, domain.length);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
  return `snn1${toHex(digest).slice(0, 40)}`;
}

async function deriveWrappingKey(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey("raw", encoder.encode(passphrase), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export async function encryptKeystore(privateKey, passphrase, address, iterations = PBKDF2_ITERATIONS) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveWrappingKey(passphrase, salt, iterations);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, privateKey));
  return {
    format: "snn-keystore",
    version: 1,
    address,
    kdf: { name: "PBKDF2", hash: "SHA-256", iterations, salt: toHex(salt) },
    cipher: { name: "AES-256-GCM", iv: toHex(iv), data: toHex(cipher) },
  };
}

// Throws a generic error for both a wrong passphrase and a tampered file, so the failure reveals nothing extra.
export async function decryptKeystore(keystore, passphrase) {
  if (!keystore || keystore.format !== "snn-keystore" || keystore.version !== 1) {
    throw new Error("ملف المحفظة غير مدعوم.");
  }
  const { iterations, salt } = keystore.kdf;
  if (!Number.isInteger(iterations) || iterations < 100_000) {
    throw new Error("إعدادات التشفير غير آمنة.");
  }
  const key = await deriveWrappingKey(passphrase, fromHex(salt), iterations);
  let privateKey;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: fromHex(keystore.cipher.iv) },
      key,
      fromHex(keystore.cipher.data),
    );
    privateKey = new Uint8Array(plain);
  } catch {
    throw new Error("كلمة المرور غير صحيحة أو ملف المحفظة تالف.");
  }
  const address = await deriveAddress(privateKey);
  if (address !== keystore.address) {
    throw new Error("ملف المحفظة لا يطابق العنوان المسجل.");
  }
  return { privateKey, address };
}
