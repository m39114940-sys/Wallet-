// Emergency pause. It can only halt issuance, reward payouts and base-fee changes. It cannot move funds or change supply.
import { EconError } from "./errors.js";

export class EmergencyControl {
  #paused = false;
  #authorizers;
  history = [];

  constructor(authorizers) {
    if (!Array.isArray(authorizers) || authorizers.some((a) => typeof a !== "string" || a.length === 0)) {
      throw new EconError("BAD_AUTHORIZERS", "authorizers must be a list of non-empty strings");
    }
    this.#authorizers = new Set(authorizers);
  }

  get paused() {
    return this.#paused;
  }

  #act(action, by, reason) {
    if (!this.#authorizers.has(by)) throw new EconError("UNAUTHORIZED", `"${by}" may not ${action}`);
    if (typeof reason !== "string" || reason.length === 0) throw new EconError("NO_REASON", `${action} needs a reason`);
    this.#paused = action === "pause";
    this.history.push({ action, by, reason });
  }

  pause({ by, reason }) {
    this.#act("pause", by, reason);
  }

  resume({ by, reason }) {
    this.#act("resume", by, reason);
  }
}
