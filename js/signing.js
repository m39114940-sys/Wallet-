// Ed25519 accounts and transfer signatures, built only on the Web Crypto API.
// Browsers without Ed25519 support fail closed: no account can be created or used on them.

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();
const ADDRESS_DOMAIN = "SNN-ADDR-v2";
const TX_DOMAIN = "SNN-TX-v1";
// v2 covers the chain id, so a transfer signed for one chain cannot be replayed on another (KNOWN GAP 19).
const TX_DOMAIN_V2 = "SNN-TX-v2";
const CHAIN_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

export const PUBLIC_KEY_BYTES = 32;
export const PKCS8_PRIVATE_KEY_BYTES = 48; // Ed25519 PKCS#8 DER for a 32-byte seed
export const SIGNATURE_BYTES = 64;

export const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

// Strict hex decoder: rejects odd length and any non-hex character.
export function fromHex(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
    throw new Error("قيمة hex غير صالحة.");
  }
  return Uint8Array.from(hex.match(/../g) ?? [], (pair) => parseInt(pair, 16));
}

export async function assertEd25519Support() {
  try {
    const pair = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    if (!pair?.privateKey) throw new Error("no key");
  } catch {
    throw new Error("هذا المتصفح لا يدعم Ed25519، لذلك لا يمكن استخدام المحفظة فيه بأمان. جرّب متصفحاً أحدث.");
  }
}

export async function createAccount() {
  const pair = await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const privateKeyDer = new Uint8Array(await subtle.exportKey("pkcs8", pair.privateKey));
  const publicKey = new Uint8Array(await subtle.exportKey("raw", pair.publicKey));
  return { privateKeyDer, publicKey, address: await addressFromPublicKey(publicKey) };
}

export async function addressFromPublicKey(publicKey) {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== PUBLIC_KEY_BYTES) {
    throw new Error("مفتاح عام غير صالح.");
  }
  const domain = encoder.encode(ADDRESS_DOMAIN);
  const input = new Uint8Array(domain.length + publicKey.length);
  input.set(domain, 0);
  input.set(publicKey, domain.length);
  const digest = new Uint8Array(await subtle.digest("SHA-256", input));
  return `snn1${toHex(digest).slice(0, 40)}`;
}

// Imports the decrypted PKCS#8 bytes as a non-extractable signing key.
export async function importSigningKey(privateKeyDer) {
  if (!(privateKeyDer instanceof Uint8Array) || privateKeyDer.length !== PKCS8_PRIVATE_KEY_BYTES) {
    throw new Error("حجم المفتاح الخاص غير صالح.");
  }
  return subtle.importKey("pkcs8", privateKeyDer, { name: "Ed25519" }, false, ["sign"]);
}

// Confirms that a signing key matches the public key stored with the wallet.
export async function keyMatchesPublicKey(signingKey, publicKey) {
  const probe = encoder.encode("SNN-KEY-CHECK");
  const signature = new Uint8Array(await subtle.sign("Ed25519", signingKey, probe));
  const verifyKey = await subtle.importKey("raw", publicKey, { name: "Ed25519" }, false, ["verify"]);
  return subtle.verify("Ed25519", verifyKey, signature, probe);
}

// Every field the signature covers. Amounts are integer micro-SNN strings, never decimals.
// Without chainId this is the legacy v1 message (still accepted on chains that have not required v2).
// With chainId it is the v2 message, which binds the transfer to that chain.
export function transferMessage({ from, to, units, nonce, chainId }) {
  if (chainId === undefined) {
    return encoder.encode([TX_DOMAIN, from, to, String(units), String(nonce)].join("|"));
  }
  if (typeof chainId !== "string" || !CHAIN_ID_PATTERN.test(chainId)) {
    throw new Error("معرّف السلسلة غير صالح.");
  }
  return encoder.encode([TX_DOMAIN_V2, chainId, from, to, String(units), String(nonce)].join("|"));
}

export async function signTransfer(signingKey, fields) {
  return toHex(new Uint8Array(await subtle.sign("Ed25519", signingKey, transferMessage(fields))));
}

// Checks that the public key belongs to the claimed sender, then that the signature matches the exact fields.
export async function verifyTransferSignature({ from, to, units, nonce, publicKey, signature, chainId }) {
  let pub;
  let sig;
  try {
    pub = fromHex(publicKey);
    sig = fromHex(signature);
  } catch {
    return { ok: false, code: "BAD_SIGNATURE", message: "صيغة التوقيع أو المفتاح العام غير صالحة." };
  }
  if (pub.length !== PUBLIC_KEY_BYTES || sig.length !== SIGNATURE_BYTES) {
    return { ok: false, code: "BAD_SIGNATURE", message: "طول التوقيع أو المفتاح العام غير صحيح." };
  }
  if (chainId !== undefined && (typeof chainId !== "string" || !CHAIN_ID_PATTERN.test(chainId))) {
    return { ok: false, code: "BAD_CHAIN_ID", message: "معرّف السلسلة في المعاملة غير صالح." };
  }
  if ((await addressFromPublicKey(pub)) !== from) {
    return { ok: false, code: "UNAUTHORIZED", message: "المفتاح العام لا يطابق عنوان المرسل." };
  }
  const key = await subtle.importKey("raw", pub, { name: "Ed25519" }, false, ["verify"]);
  const valid = await subtle.verify("Ed25519", key, sig, transferMessage({ from, to, units, nonce, chainId }));
  return valid
    ? { ok: true }
    : { ok: false, code: "BAD_SIGNATURE", message: "التوقيع لا يطابق بيانات التحويل." };
}
