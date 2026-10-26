import { z } from "zod";

import type { PrivateArtifactStore } from "../../infrastructure/private-artifact-store.js";
import type { Ledger } from "../../ledger/index.js";
import {
  MANUAL_OBSERVATION_CONFIGURATION_FILE,
  manualObservationConfigurationSchema,
  type ScopeFactsProvider,
} from "../../review/index.js";
import { retiredWordPressScenario } from "./lab/retired-scenarios.js";
import { LAB_BROWSER_OBSERVATION_FILE } from "./verification/attempt-observer.js";
import type { WordpressScopeInput } from "./scope-policy.js";

const attackerRole = z.enum(["unauthenticated", "subscriber", "customer"]);
const selectionRecordSchema = z.looseObject({
  activeInstallations: z.number().int().nonnegative(),
  slug: z.string().optional(),
});

const listed = (value: string | undefined): readonly string[] =>
  value === undefined ? [] : value.split(",");

/** Translates what a judge observed into the policy file's observation vocabulary. */
function observationsOf(
  conditions: Readonly<Record<string, string>>,
): string[] {
  const control =
    conditions.pathAndExtension === "attacker-chosen"
      ? ["path-extension-control"]
      : [];
  switch (conditions.observedVia) {
    case "execution-canary":
      return [
        "execution-canary",
        ...(listed(conditions.canaryFiles).some((file) =>
          /\.(php|phtml|phar)$/i.test(file),
        )
          ? ["path-extension-control"]
          : []),
      ];
    case "canary-file-read":
      return ["canary-file-read", ...control];
    case "canary-file-deleted":
      return ["canary-file-deleted", ...control];
    case "sensitive-canary-access":
      return ["sensitive-canary-access"];
    case "canary-row-read":
    case "canary-table-write":
      return ["canary-row-access"];
    case "option-change":
      return conditions.optionClass === "critical"
        ? ["option-canary-changed", "significant-option-changed"]
        : ["option-canary-changed"];
    case "session":
      return conditions.reachedRole === "administrator"
        ? ["admin-session-reached", "other-session-reached"]
        : ["other-session-reached"];
    case "role-change":
      return conditions.reachedRole === "administrator"
        ? ["admin-capability-reached", "contributor-capability-reached"]
        : ["contributor-capability-reached"];
    case "canary-beacon":
      return conditions.siteWide === "yes"
        ? ["javascript-executed", "site-wide"]
        : ["javascript-executed"];
    default:
      return [];
  }
}

/** A canary in PHP source makes a file read or delete the High Threat PHP variant. */
function categoryOf(
  category: string,
  conditions: Readonly<Record<string, string>>,
): string {
  const php = (value: string | undefined) =>
    listed(value).includes("php-source");
  if (
    (category === "arbitrary-file-read" ||
      category === "arbitrary-file-download") &&
    php(conditions.canaryFilesRead)
  )
    return "arbitrary-php-file-read";
  if (
    category === "arbitrary-file-delete" &&
    php(conditions.canaryFilesDeleted)
  )
    return "arbitrary-php-file-delete";
  return category;
}

/**
 * #525 (ADR 0040): what a person's `match` in a review Lab stands for. It is
 * the effect the Finding's category claims, in the policy's observation
 * vocabulary. Conditions only a judge recorded (path and extension control,
 * site-wide reach, an option's class) are not implied, so a programme that
 * needs them stays `ambiguous`.
 */
const HUMAN_OBSERVED_EFFECT: Readonly<Record<string, readonly string[]>> = {
  rce: ["execution-canary"],
  "php-file-write": ["execution-canary"],
  "arbitrary-file-read": ["canary-file-read"],
  "arbitrary-file-download": ["canary-file-read"],
  lfi: ["canary-file-read"],
  rfi: ["canary-file-read"],
  "arbitrary-file-delete": ["canary-file-deleted"],
  sqli: ["canary-row-access"],
  "options-update": ["option-canary-changed"],
  "stored-xss": ["javascript-executed"],
  "privesc-to-admin": [
    "admin-capability-reached",
    "contributor-capability-reached",
  ],
  "privesc-to-contributor+": ["contributor-capability-reached"],
  "auth-bypass-to-admin": ["admin-session-reached", "other-session-reached"],
  "account-takeover": ["admin-session-reached", "other-session-reached"],
  "auth-bypass-non-admin": ["other-session-reached"],
  "sensitive-object-access": ["sensitive-canary-access"],
  "content-deletion": ["other-content-deleted"],
};

const labBrowserSchema = z.looseObject({
  observerId: z.literal("wordpress-lab-browser"),
  status: z.literal("visited"),
  victimRole: z.enum([
    "administrator",
    "subscriber",
    "customer",
    "unauthenticated",
    "self",
  ]),
});

/**
 * Scope input for a result a person observed as `match` in a review Lab
 * (#525, ADR 0040): the Finding's attacker position (the only account the
 * Harness released after setup), the Lab browser's victim record when there
 * is one, the selection record, the observer's statement about the
 * configuration (#578) and the version comparison.
 */
export function wordpressHumanObservedScopeFacts(input: {
  readonly category: string;
  readonly attacker: z.infer<typeof attackerRole>;
  readonly victimRole?: NonNullable<WordpressScopeInput["victimRole"]>;
  readonly target: { readonly activeInstallations: number };
  readonly latestVersionVerified: boolean;
  /** What the observer stated with `review observe --ordinary-site`; absent when not stated. */
  readonly ordinaryPublicSite?: boolean;
}): WordpressScopeInput {
  return {
    category: input.category as WordpressScopeInput["category"],
    attacker: attackerRole.parse(input.attacker),
    activeInstalls: input.target.activeInstallations,
    wordpressOrgListed: true,
    premium: false,
    ...(input.latestVersionVerified ? { latestVersionVerified: true } : {}),
    ...(input.ordinaryPublicSite === undefined
      ? {}
      : { defaultOrCommonSettings: input.ordinaryPublicSite }),
    ...(input.victimRole === undefined
      ? {}
      : {
          victimRole: input.victimRole,
          // The Lab browser signs in as its own victim account unless it reports `self`.
          ...(input.victimRole === "self"
            ? {}
            : { victimPrincipal: "separate" as const }),
        }),
    observations: [...(HUMAN_OBSERVED_EFFECT[input.category] ?? [])],
  };
}

/**
 * Scope input from Harness-owned records only: the judge's conditions, the
 * selection record, the verified Lab scenario and the version comparison.
 */
export function wordpressScopeFacts(input: {
  readonly category: string;
  readonly conditions: Readonly<Record<string, string>>;
  readonly target: { readonly activeInstallations: number };
  readonly latestVersionVerified: boolean;
  readonly ordinaryScenarioVerified: boolean;
}): WordpressScopeInput {
  const attacker = attackerRole.parse(input.conditions.attackerRole);
  const victimRole = input.conditions.victimRole;
  const victimPrincipal = input.conditions.victimPrincipal;
  return {
    category: categoryOf(
      input.category,
      input.conditions,
    ) as WordpressScopeInput["category"],
    attacker,
    activeInstalls: input.target.activeInstallations,
    // Selection only admits targets it observed on WordPress.org, where plugins are free.
    wordpressOrgListed: true,
    premium: false,
    ...(input.latestVersionVerified ? { latestVersionVerified: true } : {}),
    // The Verifier's defaultSettings field is agent-authored. A digest-pinned
    // ordinary Lab setup is the trusted evidence for common configuration.
    ...(input.ordinaryScenarioVerified
      ? { defaultOrCommonSettings: true }
      : {}),
    ...(victimRole === undefined
      ? {}
      : {
          victimRole: victimRole as NonNullable<
            WordpressScopeInput["victimRole"]
          >,
        }),
    ...(victimPrincipal === "separate"
      ? { victimPrincipal: "separate" as const }
      : {}),
    observations: observationsOf(input.conditions),
  };
}

/** Reads the ledger and Private Evidence; anything missing fails scope evaluation, never scope itself. */
export function createWordPressScopeFacts(options: {
  readonly ledger: Ledger;
  readonly store: PrivateArtifactStore;
}): ScopeFactsProvider<WordpressScopeInput> {
  return {
    async load({ ref, basis }) {
      // Review's `scope` basis decided what counts; this only reads its records.
      const { verification } = basis;
      const finding = options.ledger
        .read({
          campaignId: ref.campaignId,
          findingId: ref.findingId,
          type: "finding-recorded",
          limit: 1,
        })
        .at(0)?.event;
      if (finding?.type !== "finding-recorded")
        throw new Error("Finding record is missing");
      const lab = options.ledger
        .readAll({
          campaignId: ref.campaignId,
          type: "lab-provisioned",
        })
        .map(({ event }) => event)
        .find(
          (event) =>
            event.type === "lab-provisioned" &&
            event.identity ===
              `verification-lab-${verification.verificationId}`,
        );
      const pinnedScenario =
        lab?.type === "lab-provisioned" && lab.scenario !== undefined
          ? retiredWordPressScenario(lab.scenario.id)
          : undefined;
      const selected = options.ledger
        .readAll({
          campaignId: ref.campaignId,
          type: "target-selected",
        })
        .filter(
          ({ event }) => event.snapshotDigest === verification.snapshotDigest,
        )
        .at(-1)?.event;
      const reference = selected?.artifacts.find(
        (artifact) => artifact.kind === "target-selection",
      );
      if (reference === undefined)
        throw new Error("Target selection record is missing");
      const file = await options.store.readFile(
        reference.digest,
        "target-selection.json",
        64 * 1024,
      );
      if (file.status !== "resolved")
        throw new Error("Target selection record is unreadable");
      const target = selectionRecordSchema.parse(
        JSON.parse(file.bytes.toString("utf8")) as unknown,
      );
      const ordinaryScenarioVerified =
        lab?.type === "lab-provisioned" &&
        lab.status === "ready" &&
        lab.purpose === "verification" &&
        lab.snapshotDigest === verification.snapshotDigest &&
        lab.scenario !== undefined &&
        pinnedScenario?.digest === lab.scenario.digest &&
        (pinnedScenario.pluginSlug === null ||
          pinnedScenario.pluginSlug === target.slug);
      const latestVersionVerified =
        verification.basis?.kind === "latest-version";
      if (basis.kind === "human-observed") {
        const findingFile = finding.artifacts.find(
          (artifact) => artifact.kind === "finding",
        );
        const recorded =
          findingFile === undefined
            ? undefined
            : await options.store.readJson(
                findingFile.digest,
                "finding.json",
                z.looseObject({ attackerPosition: attackerRole }),
                1024 * 1024,
              );
        if (recorded?.status !== "resolved")
          throw new Error("Finding private record is unreadable");
        const evidenceDigest = basis.verification.result.evidenceDigest;
        const browser =
          evidenceDigest === undefined
            ? undefined
            : await options.store.readJson(
                evidenceDigest,
                LAB_BROWSER_OBSERVATION_FILE,
                labBrowserSchema,
                64 * 1024,
              );
        // #578: the observer's statement, never a Lab scenario record.
        const stated = basis.observation.configuration;
        if (stated !== undefined) {
          const statement = await options.store.readJson(
            stated.recordDigest,
            MANUAL_OBSERVATION_CONFIGURATION_FILE,
            manualObservationConfigurationSchema,
            64 * 1024,
          );
          if (
            statement.status !== "resolved" ||
            statement.value.ordinaryPublicSite !== stated.ordinaryPublicSite
          )
            throw new Error("Observer configuration record is unreadable");
        }
        return wordpressHumanObservedScopeFacts({
          category: finding.category,
          attacker: recorded.value.attackerPosition,
          ...(browser?.status === "resolved"
            ? { victimRole: browser.value.victimRole }
            : {}),
          target,
          latestVersionVerified,
          ...(stated === undefined
            ? {}
            : { ordinaryPublicSite: stated.ordinaryPublicSite }),
        });
      }
      return wordpressScopeFacts({
        category: finding.category,
        conditions: basis.verification.result.conditions,
        target,
        latestVersionVerified,
        ordinaryScenarioVerified,
      });
    },
  };
}
