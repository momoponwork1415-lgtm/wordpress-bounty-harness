/**
 * The command table's shared shapes. A command is one row: its name, its usage
 * lines, the flags it reads, and its handler. The usage text and the flag
 * parser are derived from the rows, so adding or deleting a command touches
 * that row only.
 */

export type FlagSpec =
  | { readonly type: "string" }
  | { readonly type: "string"; readonly multiple: true }
  | { readonly type: "boolean" };

export const STR = { type: "string" } as const;
export const BOOL = { type: "boolean" } as const;
export const STRS = { type: "string", multiple: true } as const;

export type FlagSet = Readonly<Record<string, FlagSpec>>;

/** What `parseArgs` yields for a row's declared flags; an absent flag is undefined. */
export type FlagValues<Flags extends FlagSet> = {
  readonly [Name in keyof Flags]?: Flags[Name] extends { multiple: true }
    ? string[]
    : Flags[Name] extends { type: "boolean" }
      ? boolean
      : string;
};

export interface CommandShape {
  /** The positionals that select the row, joined with a space: "review decide". */
  readonly name: string;
  /** One line per accepted form, without the leading indent. */
  readonly usage: readonly string[];
  readonly options: FlagSet;
}

/** Flags every command accepts; `main` reads them before the command runs. */
export const GLOBAL_OPTIONS = { state: STR } as const satisfies FlagSet;

export function usageText(
  header: string,
  commands: readonly CommandShape[],
): string {
  return [
    header,
    ...commands.flatMap((command) => command.usage.map((line) => `  ${line}`)),
  ].join("\n");
}

/** The union of every row's flags, for the one `parseArgs` call that precedes the lookup. */
export function parserOptions(
  commands: readonly CommandShape[],
): Record<string, FlagSpec> {
  const merged: Record<string, FlagSpec> = { ...GLOBAL_OPTIONS };
  for (const command of commands)
    for (const [flag, spec] of Object.entries(command.options)) {
      const earlier = merged[flag];
      if (
        earlier !== undefined &&
        JSON.stringify(earlier) !== JSON.stringify(spec)
      )
        throw new Error(
          `--${flag} is declared with different types (${command.name})`,
        );
      merged[flag] = spec;
    }
  return merged;
}

export function commandIndex<Command extends CommandShape>(
  commands: readonly Command[],
): ReadonlyMap<string, Command> {
  const byName = new Map<string, Command>();
  for (const command of commands) {
    if (byName.has(command.name))
      throw new Error(`command ${command.name} is declared twice`);
    byName.set(command.name, command);
  }
  return byName;
}
