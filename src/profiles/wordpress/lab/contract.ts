import type { ExpectedSourceTree } from "../../../infrastructure/canonical-source-tree.js";
import type { LabHandle } from "../../../lab/index.js";
import type { Snapshot } from "../../../snapshot/index.js";

/**
 * Data types of the WordPress Lab contract. This module imports no Lab
 * sibling, so every sibling can depend on it without a cycle; `index.ts`
 * re-exports it together with the `WordPressLab` interface.
 */

export type WordPressSource =
  | {
      readonly kind: "plugin";
      readonly pluginSlug: string;
      readonly sourceDirectory: string;
      readonly sourceTree: ExpectedSourceTree;
    }
  | {
      readonly kind: "wordpress-core";
      readonly version: string;
      readonly sourceDirectory: string;
      readonly sourceTree: ExpectedSourceTree;
    }
  | {
      readonly kind: "php-source";
      readonly version: string;
      readonly sourceDirectory: string;
      readonly sourceTree: ExpectedSourceTree;
    };
export interface WordPressSourceResolver {
  resolve(snapshot: Snapshot): Promise<{
    readonly target: WordPressSource;
    readonly dependencies: readonly WordPressSource[];
  }>;
}

export interface WordPressLabHandle extends LabHandle {
  /** Non-secret ordinary locale setting for prerequisite matching. */
  readonly secondaryLocale?: string;
  readonly networkName: string;
  readonly internalIp: string;
  /** Verifier traffic passes through this Lab-local recorder. */
  readonly recorderIp: string;
  readonly database?: {
    readonly host: "database";
    readonly ipv4: string;
    readonly port: 3306;
    readonly name: "wordpress";
    readonly readOnlyAccount: {
      readonly username: "wbh_reader";
      readonly password: string;
    };
  };
  readonly attackerAccounts: Readonly<{
    subscriber: { readonly username: string; readonly password: string };
    customer?: { readonly username: string; readonly password: string };
  }>;
  /**
   * Exploration Labs only (ADR 0003, 2026-10-25 addendum): the control
   * endpoint and the administrator the agent holds for the whole Trial. A
   * verification handle never carries either.
   */
  readonly exploration?: {
    readonly control: { readonly host: "labctl"; readonly ipv4: string };
    readonly administrator: {
      readonly username: "harness-admin";
      readonly password: string;
    };
  };
}

/** Bounded observer diagnostic; never includes a visited path or browser output. */
export type WordPressVictimPagesFailurePhase = "victim-input" | "victim-page";

export type WordPressVictimPagesFailureCode =
  | "browser-visit"
  | "victim-login"
  | "victim-action-not-visible"
  | "victim-action-ambiguous"
  | "victim-action-click"
  | "victim-action-fill"
  | "victim-action-file"
  | "victim-popup"
  | "victim-navigation"
  | "victim-unobserved-popup"
  | "observer-marker-input"
  | "victim-screenshot";

/** Counts from the Harness-owned victim browser; Private Evidence only. */
export interface WordPressVictimBrowserDiagnostic {
  readonly schemaVersion: 1;
  readonly document: {
    readonly readyState: "loading" | "interactive" | "complete";
    readonly elementCount: number;
    readonly imageCount: number;
    readonly brokenImageCount: number;
    readonly inlineHandlerCount: number;
  };
  readonly runtime: {
    readonly pageErrorCounts: {
      readonly syntax: number;
      readonly reference: number;
      readonly type: number;
      readonly security: number;
      readonly other: number;
    };
    readonly consoleErrorCount: number;
    readonly failedRequestCount: number;
    readonly http4xxCount: number;
    readonly http5xxCount: number;
  };
}

export interface WordPressDialogEvent {
  readonly type: "alert";
  readonly message: string;
  readonly topLevelPageUrlAtEvent: string;
  readonly topLevelPageOriginAtEvent: "http://wordpress";
  readonly frameUrlsAtEvent: readonly string[];
}

/** A Harness-owned fixture the observer put into a victim file input (#468). */
export interface WordPressVictimFileRecord {
  readonly visitIndex: number;
  readonly actionIndex: number;
  readonly fixture: string;
  readonly fileName: string;
  readonly size: number;
  readonly sha256: string;
}

/** What the Lab browser saw on the declared victim pages; a record, never a verdict. */
export type WordPressVictimPagesObservation =
  | {
      readonly status: "observed";
      /** `self` when the Lab has no victim account apart from the attacker's. */
      readonly victimRole:
        | "administrator"
        | "subscriber"
        | "customer"
        | "unauthenticated"
        | "self";
      /** The last victim page after its actions; Private Evidence only. */
      readonly screenshot?: Buffer;
      /** Counts from that last visit; Private Evidence only. */
      readonly victimBrowserDiagnostic?: WordPressVictimBrowserDiagnostic;
      /** The first visit that showed a dialog with the declared numeric marker. */
      readonly dialog?: {
        readonly visitIndex: number;
        /** Exact Lab browser event with top-level and all frame URLs captured at event time. */
        readonly event: WordPressDialogEvent;
        /** Screen after the observer dismissed that dialog; Private Evidence only. */
        readonly screenshot: Buffer;
      };
      /** Fixture files the observer supplied, by digest; Private Evidence only. */
      readonly files?: readonly WordPressVictimFileRecord[];
    }
  | {
      readonly status: "unavailable";
      readonly phase: WordPressVictimPagesFailurePhase;
      /** Bounded observer failure code; no browser stderr enters a ledger event. */
      readonly failureCode?: WordPressVictimPagesFailureCode;
      /**
       * Private Evidence only. Never copy these bytes into a ledger event.
       * For a named failure code, the one browser line that names it with the
       * failed check and what the observer saw; otherwise bounded stderr.
       */
      readonly privateDiagnostic?: Buffer;
      /** On a victim-page failure, the fixture files the visits were given. */
      readonly files?: readonly WordPressVictimFileRecord[];
    };

export type LeftoverPatterns = {
  readonly containers?: readonly RegExp[];
  readonly networks?: readonly RegExp[];
  readonly volumes?: readonly RegExp[];
};
export type Leftovers = {
  readonly containers: readonly string[];
  readonly networks: readonly string[];
  readonly volumes: readonly string[];
};
