import {
  isClaudeTranscriptPath,
  type NativeRunSession,
} from "./native-run-receipts.js";

/** One JSON object line of the runner's stdout or a Claude Code transcript. */
export type Event = Record<string, unknown>;

export const CHILD_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Claude Code writes each child's session to `<project>/<session>/subagents/agent-<id>.jsonl`. */
export const CHILD_TRANSCRIPT =
  /(?:^|\/)subagents\/agent-([A-Za-z0-9_-]{1,64})\.jsonl$/;
export const object = (value: unknown): Event | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Event)
    : undefined;

export function jsonLines(text: string): Event[] {
  return text.split("\n").flatMap((line) => {
    try {
      const value = object(JSON.parse(line) as unknown);
      return value === undefined ? [] : [value];
    } catch {
      return [];
    }
  });
}

/** The Root session stdout last named. */
export function lastSessionId(events: readonly Event[]): string | undefined {
  const session = events
    .flatMap((event) =>
      typeof event.session_id === "string"
        ? [event.session_id]
        : event.type === "harness.turn" && typeof event.sessionId === "string"
          ? [event.sessionId]
          : [],
    )
    .at(-1);
  return session !== undefined && CHILD_ID.test(session) ? session : undefined;
}

/**
 * The Root session and the transcripts Private Evidence holds for it, as the
 * receipt records them so an operator can resume the session in a new
 * sandbox (ADR 0036). The Root is the session stdout last named, else the
 * only top-level transcript; children are every sealed child transcript.
 * Without a sealed Root transcript nothing is recorded.
 */
export function claudeRunSession(
  events: readonly Event[],
  files: readonly { readonly path: string; readonly digest?: string }[],
  segment: number,
): NativeRunSession | undefined {
  const sealed = files.flatMap((file) =>
    file.digest !== undefined && isClaudeTranscriptPath(file.path)
      ? [{ path: file.path, digest: file.digest }]
      : [],
  );
  const sessions = sealed.filter((file) => file.path.split("/").length === 2);
  const rootId =
    lastSessionId(events) ??
    (sessions.length === 1
      ? sessions[0]!.path.split("/")[1]!.slice(0, -".jsonl".length)
      : undefined);
  const root = sessions.find(
    (file) => file.path.split("/")[1] === `${rootId}.jsonl`,
  );
  if (rootId === undefined || root === undefined) return undefined;
  return {
    rootThreadId: rootId,
    rootTurns: events.filter(
      (event) => event.type === "system" && event.subtype === "init",
    ).length,
    segment,
    files: [
      {
        path: root.path,
        threadId: rootId,
        kind: "root" as const,
        diagnosticArtifactDigest: root.digest,
      },
      ...sealed.flatMap((file) => {
        const agentId = CHILD_TRANSCRIPT.exec(file.path)?.[1];
        return agentId === undefined
          ? []
          : [
              {
                path: file.path,
                threadId: agentId,
                kind: "child" as const,
                diagnosticArtifactDigest: file.digest,
              },
            ];
      }),
    ].slice(0, 256),
  };
}

/**
 * The session of a Claude run sealed before receipts recorded one: the sealed
 * diagnostic already lists every transcript with its digest
 * (`harness.transcripts`) after the Root's stdout. Undefined when the
 * diagnostic has no such list or no Root transcript in it.
 */
export function claudeSessionFromDiagnostic(
  diagnostic: string,
  segment: number,
): NativeRunSession | undefined {
  const events = jsonLines(diagnostic);
  const listed = events.find((event) => event.type === "harness.transcripts");
  if (listed === undefined || !Array.isArray(listed.files)) return undefined;
  const files = listed.files.flatMap((entry: unknown) => {
    const file = object(entry);
    return typeof file?.path === "string" && typeof file.digest === "string"
      ? [{ path: file.path, digest: file.digest }]
      : [];
  });
  return claudeRunSession(
    events.filter((event) => event.type !== "harness.transcripts"),
    files,
    segment,
  );
}
