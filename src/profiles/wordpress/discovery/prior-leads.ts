import type { PriorLead } from "../../../discovery/index.js";
import { WORDPRESS_DEPENDENCY_SOURCE_ROOTS } from "../sandbox-layout.js";
import type { WordPressLead } from "./lead.js";

/**
 * ADR 0044: a Lead's entry and effect in the frozen source, by the rule of
 * `scripts/lead-groups.mjs` (`pair`): its first and last `sourceTrace` rows
 * after the rows in WordPress core, PHP or a dependency plugin are dropped,
 * or the first and last rows as they are when every row is such a frame.
 * Lines are left out. Only the summary goes with them; the section's shape
 * check picks its first sentence, and withholds it when it names the
 * storage key.
 */
export function wordPressPriorLead(
  lead: Pick<WordPressLead, "sourceTrace" | "summary" | "storage">,
): PriorLead {
  const target = lead.sourceTrace.filter(
    (row) =>
      !WORDPRESS_DEPENDENCY_SOURCE_ROOTS.some((root) =>
        row.file.startsWith(`${root.label}/`),
      ),
  );
  const frames = target.length === 0 ? lead.sourceTrace : target;
  const place = (row: (typeof frames)[number]) => ({
    file: row.file,
    function: row.function,
  });
  return {
    entry: place(frames[0]!),
    effect: place(frames.at(-1)!),
    summary: lead.summary,
    // ADR 0044 passes no storage key: a sentence naming it is withheld.
    ...(lead.storage === null ? {} : { withheldTerms: [lead.storage.key] }),
  };
}

/**
 * ADR 0044: a Lead may be passed on only when the Trial that reported it had
 * inputs inside invariant 1, which every `wp2shell-bounty` Trial from v8 on
 * meets (no entry index, no fixed attack path). Earlier and other objectives
 * do not qualify; a Trial that received the ADR 0012 catalog is refused
 * separately from its recorded history.
 */
export function wordPressPromptAdmitsPriorLeads(
  promptVariant: string,
): boolean {
  const match = /^wp2shell-bounty-v(\d+)(?:-wide)?$/.exec(promptVariant);
  return match !== null && Number(match[1]) >= 8;
}
