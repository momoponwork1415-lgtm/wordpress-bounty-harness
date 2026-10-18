/**
 * Registrations the regex index could not resolve (Issue #328 1a-0, Issue #332 layer 1).
 *
 * Pure text scan over the same bounded source texts as the index. It only
 * counts and locates; it does not resolve concatenations (1a-1 hands those to
 * an agent). The list is Harness-side health data and is not rendered into any
 * agent-facing section. Removing it means deleting this file and the
 * `unresolved` / `unresolvedCounts` fields of the index.
 *
 * - `dynamic-hook`: `add_action` / `add_filter` whose first argument is not a
 *   plain string literal (variable, concatenation, interpolation, constant).
 * - `dynamic-rest-route`: `register_rest_route` whose second argument is not a
 *   plain string literal.
 * - `dispatcher`: a `switch` subject or the first argument of
 *   `call_user_func` / `call_user_func_array` that mentions a request
 *   parameter named `action`, `task` or `cmd` (`$_GET` / `$_POST` /
 *   `$_REQUEST`, `get_param`, `filter_input`), directly or through a variable
 *   assigned from one anywhere in the same file. False positives are accepted.
 */

export type WordPressUnresolvedKind =
  "dynamic-hook" | "dynamic-rest-route" | "dispatcher";

export interface WordPressUnresolvedRegistration {
  readonly kind: WordPressUnresolvedKind;
  /** Relative to the source root with `/` separators. */
  readonly file: string;
  readonly line: number;
}

export type WordPressUnresolvedCounts = Readonly<
  Record<WordPressUnresolvedKind, number>
>;

const KIND_ORDER: readonly WordPressUnresolvedKind[] = [
  "dynamic-hook",
  "dynamic-rest-route",
  "dispatcher",
];

const REQUEST_PARAMETER = String.raw`(?:\$_(?:REQUEST|GET|POST)\s*\[\s*['"](?:action|task|cmd)['"]\s*\]|\bget_param\s*\(\s*['"](?:action|task|cmd)['"]|\bfilter_input\s*\(\s*INPUT_(?:REQUEST|GET|POST)\s*,\s*['"](?:action|task|cmd)['"])`;

const lineOf = (text: string, offset: number): number =>
  text.slice(0, offset).split("\n").length;

/** Top-level arguments of the call whose `(` is at `open`, split on commas outside quotes and brackets. */
function callArguments(text: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = open + 1;
  for (let index = open + 1; index < text.length; index++) {
    const char = text[index]!;
    if (quote !== null) {
      if (char === "\\") index++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"') quote = char;
    else if (char === "(" || char === "[" || char === "{") depth++;
    else if (char === ")" || char === "]" || char === "}") {
      if (depth === 0) {
        args.push(text.slice(start, index).trim());
        return args;
      }
      depth--;
    } else if (char === "," && depth === 0) {
      args.push(text.slice(start, index).trim());
      start = index + 1;
    }
  }
  return args;
}

/** A single- or double-quoted string with no concatenation and no interpolation. */
function plainLiteral(argument: string | undefined): boolean {
  if (argument === undefined) return false;
  return (
    /^'(?:[^'\\]|\\.)*'$/s.test(argument) ||
    /^"(?:[^"\\$]|\\.)*"$/s.test(argument)
  );
}

export function scanWordPressUnresolved(
  text: string,
  file: string,
): WordPressUnresolvedRegistration[] {
  const found: WordPressUnresolvedRegistration[] = [];
  const add = (kind: WordPressUnresolvedKind, offset: number) =>
    found.push({ kind, file, line: lineOf(text, offset) });
  for (const match of text.matchAll(
    /(?<!function\s{1,8})\b(add_action|add_filter|register_rest_route)\s*\(/g,
  )) {
    const offset = match.index ?? 0;
    const args = callArguments(text, offset + match[0].length - 1);
    if (match[1] === "register_rest_route") {
      if (!plainLiteral(args[1])) add("dynamic-rest-route", offset);
    } else if (!plainLiteral(args[0])) add("dynamic-hook", offset);
  }
  const request = new RegExp(REQUEST_PARAMETER);
  const tainted = new Set<string>();
  for (const match of text.matchAll(
    new RegExp(
      String.raw`\$([A-Za-z_][A-Za-z_0-9]*)\s*=(?![=>])[^;]*${REQUEST_PARAMETER}`,
      "g",
    ),
  ))
    tainted.add(match[1]!);
  const fromRequest = (subject: string | undefined): boolean =>
    subject !== undefined &&
    (request.test(subject) ||
      [...subject.matchAll(/\$([A-Za-z_][A-Za-z_0-9]*)/g)].some((variable) =>
        tainted.has(variable[1]!),
      ));
  for (const match of text.matchAll(
    /\b(?:switch|call_user_func_array|call_user_func)\s*\(/g,
  )) {
    const offset = match.index ?? 0;
    const args = callArguments(text, offset + match[0].length - 1);
    if (fromRequest(args[0])) add("dispatcher", offset);
  }
  return found;
}

export function compareUnresolved(
  a: WordPressUnresolvedRegistration,
  b: WordPressUnresolvedRegistration,
): number {
  return (
    a.file.localeCompare(b.file) ||
    a.line - b.line ||
    KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind)
  );
}

export function countWordPressUnresolved(
  unresolved: readonly WordPressUnresolvedRegistration[],
): WordPressUnresolvedCounts {
  const count = (kind: WordPressUnresolvedKind) =>
    unresolved.filter((item) => item.kind === kind).length;
  return {
    "dynamic-hook": count("dynamic-hook"),
    "dynamic-rest-route": count("dynamic-rest-route"),
    dispatcher: count("dispatcher"),
  };
}

/** One operator-facing line; never part of an agent-facing section. */
export function describeWordPressUnresolved(
  counts: WordPressUnresolvedCounts,
): string {
  return `Unresolved registrations: dynamic-hook ${counts["dynamic-hook"]}, dynamic-rest-route ${counts["dynamic-rest-route"]}, dispatcher ${counts.dispatcher}`;
}
