/**
 * What selection needs from the public advisory history mirror: counts and
 * dates per slug, never record content (ADR 0037, ADR 0012). The Wordfence
 * mirror implements this in `../wordfence-history/advisory-counts.ts`.
 */
export interface WordPressAdvisoryHistoryWindow {
  /** Inclusive lower bound, epoch milliseconds. */
  readonly fromMs: number;
  /** Inclusive upper bound, epoch milliseconds; normally the mirror's `asOf`. */
  readonly toMs: number;
  /** Signal values that count toward `payingClassCount`. */
  readonly payingClasses: readonly string[];
}

export interface WordPressAdvisoryHistoryCount {
  /** Non-informational plugin records published inside the window. */
  readonly count: number;
  /** Records among `count` whose signal class is one of the paying classes. */
  readonly payingClassCount: number;
  /** ISO instant of the newest counted record; absent when `count` is 0. */
  readonly latestPublished?: string | undefined;
}

export interface WordPressAdvisoryHistoryMirror {
  /** The mirror's last successful refresh (`last_successful_at`). */
  readonly asOf: string;
  /** `sha256:` digest of the feed content the mirror was built from. */
  readonly digest: string;
  readonly recordCount: number;
  /** The most recent refresh attempt failed (`stale_fallback`); the data is still from `asOf`. */
  readonly lastRefreshFailed: boolean;
  count(
    slug: string,
    window: WordPressAdvisoryHistoryWindow,
  ): WordPressAdvisoryHistoryCount;
  close(): void;
}

export type WordPressAdvisoryHistoryOpen =
  | { readonly status: "open"; readonly mirror: WordPressAdvisoryHistoryMirror }
  | {
      readonly status: "stale";
      readonly lastSuccessfulAt: string;
      readonly ageMs: number;
    }
  | { readonly status: "unavailable"; readonly reason: string };

/** Opens the mirror only when it is consistent and its last success is younger than `maximumAgeMs`. */
export interface WordPressAdvisoryHistorySource {
  open(options: {
    readonly now: Date;
    readonly maximumAgeMs: number;
  }): WordPressAdvisoryHistoryOpen;
}
