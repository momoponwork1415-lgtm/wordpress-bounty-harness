import { z } from "zod";

import type { PrivateArtifactStore } from "../../infrastructure/private-artifact-store.js";
import type { Ledger } from "../../ledger/index.js";
import type { ScopeFactsProvider } from "../../review/index.js";
import type { WordpressScopeInput } from "./scope-policy.js";

const attackerRole = z.enum(["unauthenticated", "subscriber", "customer"]);
const selectionRecordSchema = z.looseObject({
  activeInstallations: z.number().int().nonnegative(),
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
 * Scope input from Harness-owned records only: the judge's conditions, the
 * selection record and whether this verification ran on the latest version.
 */
export function wordpressScopeFacts(input: {
  readonly category: string;
  readonly conditions: Readonly<Record<string, string>>;
  readonly target: { readonly activeInstallations: number };
  readonly latestVersionVerified: boolean;
}): WordpressScopeInput {
  const attacker = attackerRole.parse(input.conditions.attackerRole);
  const defaultSettings = input.conditions.defaultSettings;
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
    ...(defaultSettings === undefined
      ? {}
      : { defaultOrCommonSettings: defaultSettings === "true" }),
    observations: observationsOf(input.conditions),
  };
}

/** Reads the ledger and Private Evidence; anything missing fails scope evaluation, never scope itself. */
export function createWordPressScopeFacts(options: {
  readonly ledger: Ledger;
  readonly store: PrivateArtifactStore;
}): ScopeFactsProvider<WordpressScopeInput> {
  return {
    async load({ ref, verification }) {
      if (verification.result.status !== "runtime-confirmed")
        throw new Error("Scope facts need a runtime-confirmed verification");
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
      const selected = options.ledger
        .read({
          campaignId: ref.campaignId,
          type: "target-selected",
          limit: 1000,
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
      return wordpressScopeFacts({
        category: finding.category,
        conditions: verification.result.conditions,
        target: selectionRecordSchema.parse(
          JSON.parse(file.bytes.toString("utf8")) as unknown,
        ),
        latestVersionVerified: verification.basis?.kind === "latest-version",
      });
    },
  };
}
