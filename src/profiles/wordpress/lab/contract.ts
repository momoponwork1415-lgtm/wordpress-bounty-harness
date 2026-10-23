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
}

export interface WordPressCanaryLedger {
  readonly nonce: string;
  readonly option: string;
  readonly postId: string;
  readonly postMeta: string;
  readonly file: string;
  readonly user: string;
  /** Administrator canary: a takeover target the attacker never holds credentials for. */
  readonly adminUser: string;
  /** Roles of each attacker account when the Lab was seeded. */
  readonly roleBaseline: Readonly<Record<string, readonly string[]>>;
  /** One row whose value is stored only in this table; reading it needs SQL access. */
  readonly sqlCanary: { readonly table: string; readonly value: string };
  /** Files outside wp-content at fixed paths; only their values are secret. */
  readonly fileCanaries: readonly WordPressFileCanary[];
  /** Verification-only protected objects; never mounted into a discovery Lab. */
  readonly sensitiveCanaries: readonly WordPressSensitiveCanary[];
}

export const WORDPRESS_SENSITIVE_OBJECT_KINDS_V1 = [
  "private-post",
  "other-user-meta",
] as const;
export type WordPressSensitiveObjectKind =
  (typeof WORDPRESS_SENSITIVE_OBJECT_KINDS_V1)[number];
export interface WordPressSensitiveCanary {
  readonly kind: WordPressSensitiveObjectKind;
  readonly objectId: string;
  readonly value: string;
}

export interface ScriptCanary {
  readonly nonce: string;
  readonly beaconUrl: string;
  /** Exact browser code for the nonce-bound POST; stays in Private Evidence. */
  readonly javascript: string;
  /** Short code for constrained surfaces; the module sends the same POST. */
  readonly loaderJavascript: string;
}

export type WordPressScriptContext =
  "front" | "admin-all" | "admin-partial" | "route-page" | "victim-route-page";

/** Bounded observer diagnostic; never includes a visited path or browser output. */
export type WordPressStoredScriptFailurePhase =
  | "lab"
  | "route-input"
  | "victim-input"
  | "front"
  | "dashboard"
  | "posts"
  | "route-page"
  | "victim-page";

export type WordPressStoredScriptFailureCode =
  | "browser-visit"
  | "victim-login"
  | "victim-action-not-visible"
  | "victim-action-ambiguous"
  | "victim-action-click"
  | "victim-action-fill"
  | "victim-popup"
  | "victim-navigation"
  | "victim-unobserved-popup"
  | "observer-canary-input"
  | "observer-marker-input"
  | "victim-canary-request"
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
    readonly canaryAttributeCount: number;
    readonly canaryInlineHandlerCount: number;
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

export type WordPressStoredScriptObservation =
  | {
      readonly status: "observed";
      readonly contexts: readonly WordPressScriptContext[];
      /** Actual Lab browser principal when a declared victim page fired. */
      readonly victimRole?:
        | "administrator"
        | "subscriber"
        | "customer"
        | "unauthenticated"
        | "self";
      /** First firing page, or last non-firing victim page for diagnosis; Private Evidence only. */
      readonly screenshot?: Buffer;
      /** Last completed non-firing victim visit; Private Evidence only. */
      readonly victimBrowserDiagnostic?: WordPressVictimBrowserDiagnostic;
      /** A dialog with the declared numeric marker appeared during this victim visit. */
      readonly dialogVisitIndex?: number;
      /** Exact Lab browser event with top-level and all frame URLs captured at event time. */
      readonly dialogEvent?: WordPressDialogEvent;
      /** Screenshot after the observer dismissed that dialog; Private Evidence only. */
      readonly dialogScreenshot?: Buffer;
    }
  | { readonly status: "not-prepared" }
  | {
      readonly status: "unavailable";
      /** Optional for callers created before phase diagnostics were added. */
      readonly phase?: WordPressStoredScriptFailurePhase;
      /** Bounded observer failure code; no browser stderr enters a ledger event. */
      readonly failureCode?: WordPressStoredScriptFailureCode;
      /** Private Evidence only. Never copy these bytes into a ledger event. */
      readonly privateDiagnostic?: Buffer;
    };

export type WordPressOptionsObservation =
  | { readonly status: "observed"; readonly changed: readonly string[] }
  | { readonly status: "unavailable" };

export interface WordPressFileCanary {
  /** Different directory and extension, so reaching both shows full path control. */
  readonly kind: "outside-webroot" | "php-source";
  readonly path: string;
  readonly value: string;
}

export type WordPressCanaryFilesObservation =
  | {
      readonly status: "observed";
      readonly deleted: readonly WordPressFileCanary["kind"][];
    }
  | { readonly status: "unavailable" };

export type WordPressCanaryTableObservation = {
  readonly status: "intact" | "changed" | "unavailable";
};

export type WordPressRoleObservation =
  | { readonly status: "roles"; readonly roles: readonly string[] }
  | { readonly status: "unavailable" };

export type WordPressSessionObservation =
  | { readonly status: "user"; readonly login: string }
  | { readonly status: "none" | "unavailable" };

export type WordPressExecutionObservation =
  | {
      readonly status: "executed";
      /** Files under the web root that hold the canary, relative to it. */
      readonly files: readonly string[];
    }
  | { readonly status: "not-executed" | "not-prepared" | "unavailable" };

export interface ExecutionCanary {
  readonly nonce: string;
  readonly php: string;
}

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
