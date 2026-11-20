import { createAccount, importSigningKey, signTransfer, toHex } from "../js/signing.js";
import { parseAmount } from "../js/ledger.js";

// Creates a real Ed25519 account, with its signing key imported as the app does.
export async function makeAccount() {
  const account = await createAccount();
  return { ...account, signingKey: await importSigningKey(account.privateKeyDer) };
}

// Builds a transfer exactly as the app submits it: signed over the integer micro-SNN amount.
export async function signedTransfer(sender, to, amount, nonce) {
  const units = parseAmount(amount).toString();
  const signature = await signTransfer(sender.signingKey, { from: sender.address, to, units, nonce });
  return { from: sender.address, to, amount, nonce, publicKey: toHex(sender.publicKey), signature };
}
