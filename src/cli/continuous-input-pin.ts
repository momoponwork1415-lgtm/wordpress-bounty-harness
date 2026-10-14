/** Raised before any child Lab or Trial when a loaded input differs from the parent's pin. */
export class ContinuousInputPinMismatchError extends Error {
  constructor(readonly inputKind: "config" | "policy") {
    super(`Continuous parent ${inputKind} digest changed`);
    this.name = "ContinuousInputPinMismatchError";
  }
}
