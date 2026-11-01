import { describe, expect, it } from "vitest";

import {
  PRIOR_LEAD_WITHHELD,
  priorLeadGap,
  priorLeadsSection,
} from "../../src/discovery/prior-leads.js";

const entry = { file: "includes/ajax.php", function: "handle_save" };
const effect = { file: "includes/store.php", function: "write_value" };

describe("Prior leads section (ADR 0044)", () => {
  it("states each representative's entry, effect and first summary sentence", () => {
    expect(
      priorLeadsSection([
        {
          entry,
          effect,
          summary:
            "The stored value was not shown to reach a reader. A second sentence stays out.",
        },
        { entry: effect, effect: entry, summary: "No line break here" },
      ]),
    ).toEqual({
      text: [
        "## Prior leads",
        "",
        "An earlier Trial on this same Snapshot reported the leads below. Each names the place in the frozen source where its trace entered and the place where it ended, as file and function, and the sentence in which it stated what it had not shown. They are unconfirmed and may be wrong. Report Findings and Leads under the same output contract as any other Trial.",
        "",
        "### Prior lead 1",
        "",
        "- Entry: `includes/ajax.php` `handle_save`",
        "- Effect: `includes/store.php` `write_value`",
        "- Not shown: The stored value was not shown to reach a reader.",
        "",
        "### Prior lead 2",
        "",
        "- Entry: `includes/store.php` `write_value`",
        "- Effect: `includes/ajax.php` `handle_save`",
        "- Not shown: No line break here",
      ].join("\n"),
      gapWithheld: 0,
    });
  });

  it("keeps file names with dots inside the first sentence", () => {
    expect(
      priorLeadGap("The write in store.php was not tied to a reader.\nMore."),
    ).toBe("The write in store.php was not tied to a reader.");
  });

  it("withholds a sentence that fails the shape check, and counts it", () => {
    for (const summary of [
      `A ${"long ".repeat(70)}sentence.`,
      "It was reached at https://lab.invalid/page but not shown.",
      "Sending POST /wp-admin/admin-ajax.php was not tried.",
      "The handler post /x stays open.",
      "The value `this quotation is longer than twenty` was stored.",
      'It echoed "a quoted string that is long enough" back.',
      "It printed “a curly quoted string that is long” once.",
      "It wrote 'a single quoted string that is long' once.",
      "The <script> tag was not shown to run.",
      "The value > 3 was not shown.",
      "   ",
    ]) {
      expect(priorLeadGap(summary), summary).toBeUndefined();
      expect(
        priorLeadsSection([{ entry, effect, summary }]),
        summary,
      ).toMatchObject({ gapWithheld: 1 });
      expect(priorLeadsSection([{ entry, effect, summary }]).text).toContain(
        `- Not shown: ${PRIOR_LEAD_WITHHELD}`,
      );
    }
  });

  it("does not read apostrophes or short quotes as a long quotation", () => {
    const sentence =
      "The Lead's reader isn't shown to run `save()` for 'x' at all.";
    expect(priorLeadGap(sentence)).toBe(sentence);
  });

  it("withholds a file or function name that cannot sit in backticks", () => {
    const { text } = priorLeadsSection([
      {
        entry: { file: "a.php", function: "evil`name" },
        effect: { file: "b.php\nc", function: "f" },
        summary: "Not shown.",
      },
    ]);
    expect(text).toContain(`- Entry: ${PRIOR_LEAD_WITHHELD}`);
    expect(text).toContain(`- Effect: ${PRIOR_LEAD_WITHHELD}`);
  });

  it("refuses an empty list", () => {
    expect(() => priorLeadsSection([])).toThrow("No prior leads");
  });
});
