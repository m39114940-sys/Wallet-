// State root for the NEW Testnet rules only ("evm-v1"). The current Testnet never calls these functions, so its blocks are unchanged.
// Composite root = H(domain || H(ledger) || evmRoot). Each part is hashed on its own so either can be checked alone.
// Transaction history is excluded from the ledger root: it is already committed by each block's merkleRoot.
import { sha256Hex, canonicalJson } from "./crypto.js";
import { EvmAccounts } from "../evm/state.js";

export const LEDGER_ROOT_DOMAIN = "snn-ledger-root-v1";
export const COMPOSITE_ROOT_DOMAIN = "snn-state-root-v1";
const EVM_ROOT_PATTERN = /^0x[0-9a-f]{64}$/;
// Root of an empty EVM account set. Computed by the same function blocks use, so it cannot drift from it.
export const EMPTY_EVM_ROOT = new EvmAccounts().root();

export function ledgerRoot(ledger) {
  const { balances, nonces } = ledger.toJSON();
  return sha256Hex(canonicalJson({ domain: LEDGER_ROOT_DOMAIN, balances, nonces }));
}

export function compositeStateRoot(ledger, evmRoot) {
  if (typeof evmRoot !== "string" || !EVM_ROOT_PATTERN.test(evmRoot)) {
    throw Object.assign(new Error("EVM state root must be 0x followed by 64 lowercase hex characters"), { code: "BAD_EVM_ROOT" });
  }
  return sha256Hex(canonicalJson({ domain: COMPOSITE_ROOT_DOMAIN, ledger: ledgerRoot(ledger), evm: evmRoot }));
}
