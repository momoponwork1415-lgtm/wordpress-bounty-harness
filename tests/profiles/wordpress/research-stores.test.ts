import { describe, expect, it } from "vitest";

import {
  buildResearchStores,
  researchStoresBytes,
  researchStoresSchema,
} from "../../../src/profiles/wordpress/lab/research-stores.js";

/** A sealed `exploration-lab.json` as the driver writes it, with every lookup kind. */
const record = {
  schemaVersion: 1,
  labId: "wbh-lab-1",
  lookupLog: [
    {
      requestedAt: "2026-11-02T00:00:00.000Z",
      answeredAt: "2026-11-02T00:00:01.000Z",
      command: "find",
      status: "answered",
      request: "7391820465123",
      answer: {
        status: "answered",
        marker: "7391820465123",
        database: [
          {
            table: "wp_options",
            column: "option_value",
            keys: ["plugin_x_settings"],
          },
          { table: "wp_postmeta", column: "meta_value", keys: ["12", "13"] },
          { table: "wp_postmeta", column: "meta_value", keys: ["14"] },
        ],
        files: ["wp-content/uploads/plugin-x/cache.json"],
        truncated: false,
        lookupsUsed: 1,
        maxLookups: 60,
      },
    },
    {
      requestedAt: "2026-11-02T00:00:02.000Z",
      answeredAt: "2026-11-02T00:00:03.000Z",
      command: "find",
      status: "answered",
      request: "8391820465123",
      answer: {
        status: "answered",
        marker: "8391820465123",
        database: [],
        files: [],
        truncated: false,
        lookupsUsed: 2,
        maxLookups: 60,
      },
    },
    {
      requestedAt: "2026-11-02T00:00:04.000Z",
      answeredAt: "2026-11-02T00:00:04.500Z",
      command: "find",
      status: "refused",
      reason: "budget",
      request: "9391820465123",
      answer: {
        status: "refused",
        reason: "budget",
        lookupsUsed: 2,
        maxLookups: 60,
      },
    },
    {
      requestedAt: "2026-11-02T00:00:05.000Z",
      answeredAt: "2026-11-02T00:00:06.000Z",
      command: "sql",
      status: "answered",
      request: "SELECT option_name FROM wp_options LIMIT 5",
      answer: {
        status: "answered",
        columns: ["option_name"],
        rows: [["siteurl"], ["home"]],
        truncated: false,
        lookupsUsed: 3,
        maxLookups: 60,
      },
    },
    {
      requestedAt: "2026-11-02T00:00:07.000Z",
      answeredAt: "2026-11-02T00:00:09.000Z",
      command: "trace",
      status: "answered",
      request: {
        method: "POST",
        path: "/wp-admin/admin-ajax.php",
        contentType: "application/x-www-form-urlencoded",
        body: "action=plugin_x_save&value=1",
        bodyLength: 28,
        cookieLength: 240,
      },
      answer: {
        status: "answered",
        httpStatus: 200,
        entries: [
          {
            depth: 3,
            function: "plugin_x_ajax",
            file: "wp-content/plugins/plugin-x/ajax.php",
            line: 10,
          },
          {
            depth: 4,
            function: "plugin_x_save",
            file: "wp-content/plugins/plugin-x/store.php",
            line: 40,
          },
          {
            depth: 5,
            function: "plugin_x_sanitize",
            file: "wp-content/plugins/plugin-x/store.php",
            line: 80,
          },
        ],
        entryCount: 57,
        truncated: false,
        lookupsUsed: 4,
        maxLookups: 60,
      },
    },
    {
      requestedAt: "2026-11-02T00:00:10.000Z",
      answeredAt: "2026-11-02T00:00:10.500Z",
      command: "trace",
      status: "failed",
      request: { method: "GET", path: "/", bodyLength: 0 },
      answer: { status: "failed", lookupsUsed: 5, maxLookups: 60 },
    },
  ],
};

describe("research stores table (ADR 0049 D)", () => {
  it("keeps every answered find (marker, table/column, files) and trace (request, status, count, plugin files), nothing else", () => {
    const stores = buildResearchStores(record);
    expect(stores).toEqual({
      kind: "research-stores",
      schemaVersion: 1,
      finds: [
        {
          marker: "7391820465123",
          database: [
            { table: "wp_options", column: "option_value" },
            { table: "wp_postmeta", column: "meta_value" },
          ],
          files: ["wp-content/uploads/plugin-x/cache.json"],
        },
        { marker: "8391820465123", database: [], files: [] },
      ],
      traces: [
        {
          method: "POST",
          path: "/wp-admin/admin-ajax.php",
          httpStatus: 200,
          entryCount: 57,
          files: [
            "wp-content/plugins/plugin-x/ajax.php",
            "wp-content/plugins/plugin-x/store.php",
          ],
        },
      ],
    });
    const text = researchStoresBytes(stores!).toString("utf8");
    // Keys, SQL rows, bodies, cookies and function names never reach the table.
    for (const absent of [
      "plugin_x_settings",
      '"12"',
      "siteurl",
      "option_name",
      "action=plugin_x_save",
      "cookie",
      "Cookie",
      "plugin_x_sanitize",
      "lookupsUsed",
    ])
      expect(text).not.toContain(absent);
    expect(researchStoresSchema.parse(JSON.parse(text))).toEqual(stores);
    // Canonical JSON: the same record gives the same bytes.
    expect(
      researchStoresBytes(buildResearchStores(record)!).equals(
        researchStoresBytes(stores!),
      ),
    ).toBe(true);
  });

  it("is undefined for a record that is not one, or that answered no find or trace", () => {
    expect(buildResearchStores(null)).toBeUndefined();
    expect(buildResearchStores("text")).toBeUndefined();
    expect(buildResearchStores({ lookupLog: [] })).toBeUndefined();
    expect(
      buildResearchStores({
        lookupLog: [
          record.lookupLog[2],
          record.lookupLog[3],
          record.lookupLog[5],
        ],
      }),
    ).toBeUndefined();
    // A record without lookupLog (an older Lab) has no table either.
    expect(
      buildResearchStores({ schemaVersion: 1, resetLog: [] }),
    ).toBeUndefined();
  });
});
