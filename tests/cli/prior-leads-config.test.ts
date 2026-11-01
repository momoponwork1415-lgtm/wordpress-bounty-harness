import { describe, expect, it } from "vitest";

import { wordpressCampaignConfigSchema } from "../../src/cli/wordpress.js";
import { priorLeadSourceRefusal } from "../../src/cli/wordpress-prior-leads.js";
import { priorLeadsSection } from "../../src/discovery/prior-leads.js";
import {
  wordPressPriorLead,
  wordPressPromptAdmitsPriorLeads,
} from "../../src/profiles/wordpress/discovery/prior-leads.js";

const sha = (value: string) => `sha256:${value.repeat(64)}`;
const base = {
  schemaVersion: 1 as const,
  programmeBoundary: { version: "v1", text: "Synthetic" },
  wordpressVersion: "6.8",
  lab: { siteTitle: "Synthetic", initialPosts: [], customerRole: false },
};

describe("discovery.priorLeads configuration (ADR 0044)", () => {
  it("accepts Lead ids or a groups file per Snapshot with an attached Lab", () => {
    const parsed = wordpressCampaignConfigSchema.parse({
      ...base,
      discovery: {
        mode: "wide",
        lab: "attached",
        priorLeads: {
          targets: [
            { snapshotDigest: sha("a"), leadIds: [sha("1"), sha("2")] },
            { snapshotDigest: sha("b"), groupsPath: "groups.json" },
          ],
        },
      },
    });
    expect(parsed.discovery.priorLeads?.targets).toHaveLength(2);
    expect(parsed.discovery.maxChildren).toBe(4);
    expect(parsed.runWallTimeMinutes).toBe(120);
  });

  it("refuses a Lab-less second Trial, both or neither source, repeats and more than 8 Leads", () => {
    const parse = (discovery: Record<string, unknown>) =>
      wordpressCampaignConfigSchema.safeParse({ ...base, discovery }).success;
    const target = { snapshotDigest: sha("a"), leadIds: [sha("1")] };
    expect(parse({ lab: "none", priorLeads: { targets: [target] } })).toBe(
      false,
    );
    expect(
      parse({
        lab: "attached",
        priorLeads: { targets: [{ ...target, groupsPath: "groups.json" }] },
      }),
    ).toBe(false);
    expect(
      parse({
        lab: "attached",
        priorLeads: { targets: [{ snapshotDigest: sha("a") }] },
      }),
    ).toBe(false);
    expect(
      parse({ lab: "attached", priorLeads: { targets: [target, target] } }),
    ).toBe(false);
    expect(
      parse({
        lab: "attached",
        priorLeads: {
          targets: [
            { snapshotDigest: sha("a"), leadIds: [sha("1"), sha("1")] },
          ],
        },
      }),
    ).toBe(false);
    expect(
      parse({
        lab: "attached",
        priorLeads: {
          targets: [
            {
              snapshotDigest: sha("a"),
              leadIds: "123456789".split("").map(sha),
            },
          ],
        },
      }),
    ).toBe(false);
    expect(parse({ lab: "attached", priorLeads: { targets: [target] } })).toBe(
      true,
    );
  });

  it("passes Leads only from v8-or-later Trials without the ADR 0012 catalog", () => {
    const started = (promptVariant: string, catalog = false) => ({
      history: catalog
        ? { mode: "catalog" as const, digest: sha("c"), recordIds: [] }
        : { mode: "none" as const },
      configuration: { promptVariant },
    });
    expect(priorLeadSourceRefusal(started("wp2shell-bounty-v8"))).toBe(
      undefined,
    );
    expect(priorLeadSourceRefusal(started("wp2shell-bounty-v18-wide"))).toBe(
      undefined,
    );
    expect(priorLeadSourceRefusal(started("wp2shell-bounty-v7"))).toBe(
      "prior-lead-prompt-before-v8",
    );
    expect(priorLeadSourceRefusal(started("wp2shell-whitebox-v1.7"))).toBe(
      "prior-lead-prompt-before-v8",
    );
    expect(priorLeadSourceRefusal(started("short-objective-v2"))).toBe(
      "prior-lead-prompt-before-v8",
    );
    expect(
      priorLeadSourceRefusal(started("wp2shell-bounty-v14-wide", true)),
    ).toBe("prior-lead-history-catalog");
    expect(wordPressPromptAdmitsPriorLeads("wp2shell-bounty-v10-wide")).toBe(
      true,
    );
  });

  it("takes entry and effect as lead-groups.mjs pair does, past core and dependency frames", () => {
    const row = (file: string, name: string) => ({
      file,
      function: name,
      line: 1,
    });
    expect(
      wordPressPriorLead({
        summary: "Synthetic.",
        storage: null,
        sourceTrace: [
          row("@wordpress/wp-includes/plugin.php", "do_action"),
          row("includes/ajax.php", "handle_save"),
          row("includes/util.php", "normalise"),
          row("includes/store.php", "write_value"),
          row("@dependencies/other/x.php", "sink"),
        ],
      }),
    ).toEqual({
      entry: { file: "includes/ajax.php", function: "handle_save" },
      effect: { file: "includes/store.php", function: "write_value" },
      summary: "Synthetic.",
    });
    expect(
      wordPressPriorLead({
        summary: "Synthetic.",
        storage: null,
        sourceTrace: [
          row("@wordpress/a.php", "first"),
          row("@php/b.c", "last"),
        ],
      }),
    ).toMatchObject({
      entry: { file: "@wordpress/a.php", function: "first" },
      effect: { file: "@php/b.c", function: "last" },
    });
  });

  it("withholds a gap sentence that names the Lead's storage key (ADR 0044)", () => {
    const lead = (summary: string) =>
      wordPressPriorLead({
        summary,
        storage: { kind: "option", key: "plugin_secret_token" },
        sourceTrace: [{ file: "a.php", function: "save", line: 1 }],
      });
    expect(
      priorLeadsSection([
        lead("The value in Plugin_Secret_Token was not shown to be read."),
        lead("No reader of the stored value was shown."),
      ]),
    ).toMatchObject({ gapWithheld: 1 });
    const { text } = priorLeadsSection([
      lead("The value in plugin_secret_token was not shown to be read."),
    ]);
    expect(text).toContain("- Not shown: (withheld)");
    expect(text).not.toContain("plugin_secret_token");
  });
});
