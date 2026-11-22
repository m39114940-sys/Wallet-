// EVM accounts. An EVM address is the last 20 bytes of Keccak-256 over the uncompressed secp256k1 public key (without the 0x04 prefix).
// These accounts live in their own namespace (evm:0x...) and never share a key or nonce with Ed25519 snn1 accounts.
// No conversion from Ed25519 keys is performed or allowed.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { EvmError } from "./errors.js";

const ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/;
const UNCOMPRESSED_PREFIX = 0x04;

export function evmAddressFromPublicKey(publicKeyHex) {
  if (typeof publicKeyHex !== "string" || !/^[0-9a-f]+$/.test(publicKeyHex)) {
    throw new EvmError("BAD_PUBLIC_KEY", "public key must be lowercase hex");
  }
  let bytes = Buffer.from(publicKeyHex, "hex");
  if (bytes.length === 65 && bytes[0] === UNCOMPRESSED_PREFIX) bytes = bytes.subarray(1);
  if (bytes.length !== 64) {
    throw new EvmError("BAD_PUBLIC_KEY", "expected a 64-byte uncompressed secp256k1 public key (x||y)");
  }
  const digest = keccak_256(bytes);
  return `0x${Buffer.from(digest.subarray(12)).toString("hex")}`;
}

export function isEvmAddress(address) {
  return typeof address === "string" && ADDRESS_PATTERN.test(address);
}

export function evmLedgerKey(address) {
  if (!isEvmAddress(address)) throw new EvmError("BAD_ADDRESS", "EVM address must be 0x followed by 40 lowercase hex characters");
  return `evm:${address}`;
}
