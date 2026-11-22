// Error type for the EVM compatibility layer. Kept separate from chain/ so the consensus code never imports it.

export class EvmError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EvmError";
    this.code = code;
  }
}
