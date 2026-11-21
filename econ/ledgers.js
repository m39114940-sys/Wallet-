// Separate treasury ledgers. There is deliberately no transfer between ledgers and no
// unapproved spend: debit requires an approval that names the ledger, the exact amount and an approver.
import { EconError } from "./errors.js";
import { assertUnits } from "./units.js";

export const LEDGER_NAMES = Object.freeze(["security", "development", "operations", "emergency"]);

function assertLedger(name) {
  if (!LEDGER_NAMES.includes(name)) throw new EconError("BAD_LEDGER", `unknown ledger "${name}"`);
  return name;
}

export class TreasuryLedgers {
  #balances = new Map(LEDGER_NAMES.map((name) => [name, 0n]));

  balance(name) {
    return this.#balances.get(assertLedger(name));
  }

  credit(name, units) {
    assertLedger(name);
    assertUnits(units, "units");
    this.#balances.set(name, this.#balances.get(name) + units);
  }

  debit(name, units, approval) {
    assertLedger(name);
    assertUnits(units, "units");
    const ok =
      approval &&
      approval.ledger === name &&
      approval.units === units &&
      typeof approval.approvedBy === "string" &&
      approval.approvedBy.length > 0;
    if (!ok) {
      throw new EconError("UNAPPROVED_SPEND", "spend needs an approval naming this ledger, the exact amount and an approver");
    }
    const current = this.#balances.get(name);
    if (units > current) throw new EconError("INSUFFICIENT_LEDGER", `ledger "${name}" holds less than requested`);
    this.#balances.set(name, current - units);
  }

  total() {
    let t = 0n;
    for (const v of this.#balances.values()) t += v;
    return t;
  }

  snapshot() {
    return Object.fromEntries([...this.#balances].map(([k, v]) => [k, v.toString()]));
  }
}
