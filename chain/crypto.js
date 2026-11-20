// Hashing and Ed25519 helpers shared by the chain, consensus and node code.

import { createHash } from "node:crypto";
import { importSigningKey, fromHex } from "../js/signing.js";

const subtle = globalThis.crypto.subtle;
const encoder = new TextEncoder();

export const sha256Hex = (text) => createHash("sha256").update(text).digest("hex");

// Stable JSON: keys sorted, so the same data always produces the same bytes.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function signText(privateKeyDerHex, text) {
  const key = await importSigningKey(fromHex(privateKeyDerHex));
  return Buffer.from(await subtle.sign("Ed25519", key, encoder.encode(text))).toString("hex");
}

export async function verifyText(publicKeyHex, text, signatureHex) {
  try {
    const key = await subtle.importKey("raw", fromHex(publicKeyHex), { name: "Ed25519" }, false, ["verify"]);
    return await subtle.verify("Ed25519", key, fromHex(signatureHex), encoder.encode(text));
  } catch {
    return false;
  }
}
