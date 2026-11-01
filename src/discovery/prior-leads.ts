/** One place in the frozen source: a file path and a function name. */
export interface PriorLeadPlace {
  readonly file: string;
  readonly function: string;
}

/**
 * One representative Lead of an earlier Trial on the same Snapshot, as the
 * `## Prior leads` section receives it (ADR 0044): where its trace entered
 * the frozen source, where it ended, and the summary it wrote.
 */
export interface PriorLead {
  readonly entry: PriorLeadPlace;
  readonly effect: PriorLeadPlace;
  readonly summary: string;
}

/** ADR 0044: what the section states when a gap sentence fails the shape check. */
export const PRIOR_LEAD_WITHHELD = "(withheld)";

const MAX_GAP_LENGTH = 300;
const MAX_NAME_LENGTH = 256;
const HTTP_METHOD_PATH =
  /\b(?:GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|CONNECT|TRACE)\s+\//i;
/** A backtick or quote span longer than 20 characters (a long quotation). */
const LONG_QUOTE = [
  /`[^`]{21,}`/,
  /"[^"]{21,}"/,
  /“[^”]{21,}”/,
  /‘[^’]{21,}’/,
  // A single quote opens and closes a span only where it is not an apostrophe.
  /(?:^|[^\p{L}\p{N}])'[^']{21,}'(?![\p{L}\p{N}])/u,
];

/** The text up to the first sentence end (`.`, `!` or `?` before whitespace or the end) or line break. */
function firstSentence(summary: string): string {
  const line = summary.trim().split(/\r?\n/, 1)[0] ?? "";
  const end = /[.!?](?=\s|$)/.exec(line);
  return (end === null ? line : line.slice(0, end.index + 1)).trim();
}

/**
 * The first sentence of a Lead summary, or undefined when it fails the shape
 * check of ADR 0044: longer than 300 characters, a URL, an HTTP method with a
 * path, a long quotation, or `<` / `>`. The check reads the characters only,
 * never the meaning.
 */
export function priorLeadGap(summary: string): string | undefined {
  const sentence = firstSentence(summary);
  if (
    sentence.length === 0 ||
    sentence.length > MAX_GAP_LENGTH ||
    sentence.includes("://") ||
    HTTP_METHOD_PATH.test(sentence) ||
    LONG_QUOTE.some((pattern) => pattern.test(sentence)) ||
    /[<>]/.test(sentence)
  )
    return undefined;
  return sentence;
}

/** A file or function name the section can quote in backticks on one line. */
function quotedName(name: string): string | undefined {
  return name.length === 0 ||
    name.length > MAX_NAME_LENGTH ||
    /[`<>\p{Cc}]/u.test(name)
    ? undefined
    : `\`${name}\``;
}

function place({ file, function: name }: PriorLeadPlace): string {
  const quotedFile = quotedName(file);
  const quotedFunction = quotedName(name);
  return quotedFile === undefined || quotedFunction === undefined
    ? PRIOR_LEAD_WITHHELD
    : `${quotedFile} ${quotedFunction}`;
}

/**
 * The Harness-generated `## Prior leads` section (ADR 0019 pattern, ADR
 * 0044): for each named representative, the entry and effect places in the
 * frozen source and the first summary sentence that passed the shape check.
 * It says nothing about what to try. Agent-facing text: changes need
 * `owner-approved`. `gapWithheld` counts the sentences withheld.
 */
export function priorLeadsSection(leads: readonly PriorLead[]): {
  readonly text: string;
  readonly gapWithheld: number;
} {
  if (leads.length === 0) throw new Error("No prior leads to state");
  let gapWithheld = 0;
  const entries = leads.map((lead, index) => {
    const gap = priorLeadGap(lead.summary);
    if (gap === undefined) gapWithheld += 1;
    return [
      `### Prior lead ${index + 1}`,
      [
        `- Entry: ${place(lead.entry)}`,
        `- Effect: ${place(lead.effect)}`,
        `- Not shown: ${gap ?? PRIOR_LEAD_WITHHELD}`,
      ].join("\n"),
    ].join("\n\n");
  });
  return {
    text: [
      "## Prior leads",
      "An earlier Trial on this same Snapshot reported the leads below. Each names the place in the frozen source where its trace entered and the place where it ended, as file and function, and the sentence in which it stated what it had not shown. They are unconfirmed and may be wrong. Report Findings and Leads under the same output contract as any other Trial.",
      ...entries,
    ].join("\n\n"),
    gapWithheld,
  };
}
