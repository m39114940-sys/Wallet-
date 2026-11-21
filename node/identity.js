// Node identity: an Ed25519 key pair per node. The node ID is a fixed digest of the public key, so a
// node cannot claim an ID it does not hold the key for. The private key is stored sealed with a
// passphrase and is never sent to another node.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { createAccount, toHex } from "../js/signing.js";
import { signText, verifyText } from "../chain/crypto.js";
import { ChainError } from "../chain/core.js";
import { sealSecret, openSecret } from "./keyfile.js";

export const IDENTITY_FORMAT = "snn-node-identity";
const LABEL = "snn-node-identity-v1";

export const nodeIdOf = (publicKeyHex) =>
  createHash("sha256").update(`snn-node-id-v1|${publicKeyHex}`).digest("hex");

export async function createNodeIdentity() {
  const account = await createAccount();
  const publicKey = toHex(account.publicKey);
  return { publicKey, privateKeyDer: toHex(account.privateKeyDer), nodeId: nodeIdOf(publicKey) };
}

// Writes the identity file. The private key is sealed; the public parts are readable.
export function saveNodeIdentity(path, identity, passphrase) {
  const file = {
    format: IDENTITY_FORMAT,
    version: 1,
    nodeId: identity.nodeId,
    publicKey: identity.publicKey,
    sealed: sealSecret(identity.privateKeyDer, `${LABEL}|${identity.publicKey}`, passphrase),
  };
  writeFileSync(path, JSON.stringify(file, null, 2), { mode: 0o600 });
}

export function loadNodeIdentity(path, passphrase) {
  const file = JSON.parse(readFileSync(path, "utf8"));
  if (file.format !== IDENTITY_FORMAT) throw new ChainError("BAD_IDENTITY", "ملف الهوية ليس بصيغة SNN.");
  const privateKeyDer = openSecret(file.sealed, `${LABEL}|${file.publicKey}`, passphrase);
  if (nodeIdOf(file.publicKey) !== file.nodeId) throw new ChainError("BAD_IDENTITY", "معرف العقدة لا يطابق المفتاح العام.");
  return { publicKey: file.publicKey, privateKeyDer, nodeId: file.nodeId };
}

// The message a node signs to prove it holds its key. It binds the chain, the verifier, the nonce
// and the claimed ID, so a signature cannot be replayed to another chain, another verifier, or another nonce.
export const helloMessage = ({ chainId, verifierId, nonce, nodeId }) =>
  `snn-hello-v1|${chainId}|${verifierId}|${nonce}|${nodeId}`;

export async function signHello(identity, { chainId, verifierId, nonce }) {
  return signText(identity.privateKeyDer, helloMessage({ chainId, verifierId, nonce, nodeId: identity.nodeId }));
}

