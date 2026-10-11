/** Entry identifiers are opaque to the discovery module. */
export interface CoverageContinuationDecision {
  readonly injected: boolean;
  readonly mode: "thread-resume";
  readonly reason:
    | "coverage-incomplete"
    | "coverage-complete"
    | "wall-floor-reached"
    | "deadline-reached"
    | "already-injected"
    | "report-unavailable"
    | "thread-unavailable"
    | "resume-unavailable";
  readonly remainingMinutes: number;
  readonly entriesHandedBack: number;
  readonly remainingEntries: readonly string[];
}

function namedEntryOffset(text: string, entry: string): number {
  let offset = text.indexOf(entry);
  while (offset >= 0) {
    const before = text[offset - 1];
    const after = text[offset + entry.length];
    if (
      (before === undefined || !/[A-Za-z0-9_]/.test(before)) &&
      (after === undefined || !/[A-Za-z0-9_]/.test(after))
    )
      return offset;
    offset = text.indexOf(entry, offset + 1);
  }
  return -1;
}

/** A free-text report only proves coverage for identifiers it names exactly. */
export function decideCoverageContinuation(input: {
  readonly entries: readonly string[];
  readonly examined: string;
  readonly unexamined: string;
  readonly elapsedMs: number;
  readonly remainingMs: number;
  readonly minimumMs: number;
  readonly injectionsSoFar: number;
}): CoverageContinuationDecision {
  if (
    !Number.isSafeInteger(input.elapsedMs) ||
    input.elapsedMs < 0 ||
    !Number.isSafeInteger(input.remainingMs) ||
    input.remainingMs < 0 ||
    !Number.isSafeInteger(input.minimumMs) ||
    input.minimumMs < 1 ||
    !Number.isSafeInteger(input.injectionsSoFar) ||
    input.injectionsSoFar < 0
  )
    throw new Error("Invalid coverage continuation bounds");
  const remainingMinutes = Math.floor(input.remainingMs / 6_000) / 10;
  const remainingEntries = [...new Set(input.entries)].filter((entry) => {
    if (entry.length === 0) throw new Error("Empty coverage entry");
    if (namedEntryOffset(input.examined, entry) >= 0) return false;
    return !input.unexamined.split("\n").some((line) => {
      const offset = namedEntryOffset(line, entry);
      if (offset < 0) return false;
      return /^[:：—-]\s*\S/.test(line.slice(offset + entry.length).trim());
    });
  });
  const reason =
    input.injectionsSoFar > 0
      ? "already-injected"
      : remainingEntries.length === 0
        ? "coverage-complete"
        : input.elapsedMs >= input.minimumMs
          ? "wall-floor-reached"
          : input.remainingMs === 0
            ? "deadline-reached"
            : "coverage-incomplete";
  return {
    injected: reason === "coverage-incomplete",
    mode: "thread-resume",
    reason,
    remainingMinutes,
    entriesHandedBack:
      reason === "coverage-incomplete" ? remainingEntries.length : 0,
    remainingEntries: reason === "coverage-incomplete" ? remainingEntries : [],
  };
}

export function renderCoverageContinuation(
  template: string,
  decision: CoverageContinuationDecision,
): string {
  if (!decision.injected) throw new Error("No continuation to render");
  if (
    !template.includes("{remainingMinutes}") ||
    !template.includes("{entriesNotCovered}")
  )
    throw new Error("Coverage continuation template is incomplete");
  return template
    .replaceAll("{remainingMinutes}", String(decision.remainingMinutes))
    .replaceAll("{entriesNotCovered}", decision.remainingEntries.join("\n"));
}
