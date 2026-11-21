// Shared error type for the Model F economy modules.
// Isolated from chain/ and node/: nothing in the live consensus path imports this package.

export class EconError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EconError";
    this.code = code;
  }
}
