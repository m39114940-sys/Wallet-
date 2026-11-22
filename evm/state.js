// EVM account state for the new Testnet, first slice: value transfers only.
// Accounts are plain {nonce, balance} records. The root is SHA-256 over the sorted account set.
// This is NOT a Merkle Patricia Trie root. It is deterministic and sufficient for transfers. When contract storage
// arrives, the root must move to a trie, and that change needs the owner's approval.
import { createHash } from "node:crypto";
import { EvmError } from "./errors.js";
import { isEvmAddress } from "./accounts.js";

export const EVM_STATE_DOMAIN = "snn-evm-state-v1";
const AMOUNT_PATTERN = /^(0|[1-9][0-9]*)$/;

export class EvmAccounts {
  #accounts = new Map(); // address -> { nonce: number, balance: bigint }

  // allocations: { "0x…": "decimal base units" }. Validated strictly; nothing is rounded.
  static fromAllocations(allocations = {}) {
    const state = new EvmAccounts();
    for (const [address, amount] of Object.entries(allocations)) {
      if (!isEvmAddress(address)) throw new EvmError("BAD_ADDRESS", `invalid allocation address ${address}`);
      if (typeof amount !== "string" || !AMOUNT_PATTERN.test(amount)) {
        throw new EvmError("BAD_AMOUNT", `allocation for ${address} must be a decimal string`);
      }
      state.#accounts.set(address, { nonce: 0, balance: BigInt(amount) });
    }
    return state;
  }

  get(address) {
    const account = this.#accounts.get(address);
    return account ? { nonce: account.nonce, balance: account.balance } : { nonce: 0, balance: 0n };
  }

  clone() {
    const copy = new EvmAccounts();
    for (const [address, account] of this.#accounts) copy.#accounts.set(address, { ...account });
    return copy;
  }

  credit(address, amount) {
    const account = this.#accounts.get(address) ?? { nonce: 0, balance: 0n };
    this.#accounts.set(address, { nonce: account.nonce, balance: account.balance + amount });
  }

  debit(address, amount) {
    const account = this.get(address);
    if (account.balance < amount) throw new EvmError("INSUFFICIENT_BALANCE", "balance is below the amount plus fee");
    this.#accounts.set(address, { nonce: account.nonce, balance: account.balance - amount });
  }

  bumpNonce(address) {
    const account = this.get(address);
    this.#accounts.set(address, { nonce: account.nonce + 1, balance: account.balance });
  }

  root() {
    const entries = [...this.#accounts]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([address, account]) => [address, account.nonce, account.balance.toString()]);
    const digest = createHash("sha256").update(JSON.stringify({ domain: EVM_STATE_DOMAIN, accounts: entries })).digest("hex");
    return `0x${digest}`;
  }
}
