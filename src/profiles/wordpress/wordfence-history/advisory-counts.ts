import Database from "better-sqlite3";
import { z } from "zod";

import type {
  WordPressAdvisoryHistoryCount,
  WordPressAdvisoryHistoryMirror,
  WordPressAdvisoryHistoryOpen,
  WordPressAdvisoryHistorySource,
} from "../selection/advisory-history.js";
import { inspectHistoryMirror, type WordfenceHistoryOptions } from "./index.js";

const publishedRowSchema = z.object({
  id: z.string(),
  published: z.string().nullable(),
});
const signalRowSchema = z.object({ vulnerability_id: z.string() });

/** The mirror stores `YYYY-MM-DD HH:MM:SS` in UTC; ISO strings also parse. */
function parsePublished(published: string | null): number | undefined {
  if (published === null) return undefined;
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(published)
    ? `${published.replace(" ", "T")}Z`
    : published;
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Selection's view of the Wordfence mirror: per-slug counts and the newest
 * publication date inside a window. It reads `published`, `informational`
 * and the signal class names, never titles, descriptions, CWE names or
 * record JSON (ADR 0037). The database is opened read-only after the same
 * state / database consistency check `history status` applies.
 */
export function openWordfenceAdvisoryHistory(
  paths: Pick<WordfenceHistoryOptions, "databasePath" | "statePath">,
): WordPressAdvisoryHistorySource {
  return {
    open({ now, maximumAgeMs }): WordPressAdvisoryHistoryOpen {
      const status = inspectHistoryMirror({
        ...paths,
        now,
        maxAgeMs: maximumAgeMs,
      });
      if (status.status === "unavailable")
        return {
          status: "unavailable",
          reason:
            status.reason === "state-unreadable"
              ? "state is unreadable"
              : "database and state disagree",
        };
      // Selection's gate is the age of the last successful refresh (policy
      // `maximumHistoryAgeDays`); a failed refresh attempt on still-young data
      // is recorded, not a stop. `history status` keeps its stricter rule.
      if (status.ageMs < 0)
        return {
          status: "unavailable",
          reason: "state timestamp is in the future",
        };
      if (status.ageMs > maximumAgeMs)
        return {
          status: "stale",
          lastSuccessfulAt: status.lastSuccessfulAt,
          ageMs: status.ageMs,
        };
      const db = new Database(paths.databasePath, {
        readonly: true,
        fileMustExist: true,
      });
      const published = db.prepare(
        "SELECT v.id, v.published FROM software s JOIN vulnerabilities v ON v.id = s.vulnerability_id WHERE s.slug = ? AND s.type = 'plugin' AND v.informational = 0",
      );
      const payingSignals = db.prepare(
        // The classifier files technique classes (stored-xss, sql-injection) as primitive and
        // outcome classes (privilege-escalation, remote-code-execution) as terminal; both count.
        "SELECT DISTINCT vulnerability_id FROM signals WHERE slug = ? AND kind IN ('primitive', 'terminal') AND value = ?",
      );
      const mirror: WordPressAdvisoryHistoryMirror = {
        asOf: status.lastSuccessfulAt,
        digest: `sha256:${status.contentSha256}`,
        recordCount: status.recordCount,
        lastRefreshFailed: status.staleFallback,
        count(slug, window): WordPressAdvisoryHistoryCount {
          const inWindow = new Map<string, number>();
          for (const row of z
            .array(publishedRowSchema)
            .parse(published.all(slug))) {
            const at = parsePublished(row.published);
            if (at === undefined || at < window.fromMs || at > window.toMs)
              continue;
            inWindow.set(row.id, at);
          }
          const paying = new Set<string>();
          for (const value of window.payingClasses)
            for (const row of z
              .array(signalRowSchema)
              .parse(payingSignals.all(slug, value)))
              if (inWindow.has(row.vulnerability_id))
                paying.add(row.vulnerability_id);
          const latest = Math.max(...inWindow.values());
          return {
            count: inWindow.size,
            payingClassCount: paying.size,
            ...(inWindow.size === 0
              ? {}
              : { latestPublished: new Date(latest).toISOString() }),
          };
        },
        close: () => db.close(),
      };
      return { status: "open", mirror };
    },
  };
}
