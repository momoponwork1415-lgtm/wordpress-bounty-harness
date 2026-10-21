import { describe, expect, it } from "vitest";

import { httpCapture } from "../../../src/lab/capture.js";
import type { WordPressFinding } from "../../../src/profiles/wordpress/discovery/finding.js";
import {
  canaries,
  judgeOnce,
  quietLab,
  route,
  type JudgeLab,
} from "./judge-fixture.js";

const nonce = "synthetic-script-nonce";
const attackBody = `value=${nonce}`;
const fileValue = canaries.fileCanaries[0]!.value;
const base64 = (text: string) => Buffer.from(text).toString("base64");

/** One recorder line; the attack request also returns a file canary value. */
function exchange(cookie: string, path = "/synthetic") {
  const body = path === "/synthetic" ? attackBody : "";
  const response = path === "/synthetic" ? `saved ${fileValue}` : "ok";
  return {
    request: {
      method: "POST",
      path,
      headers: { cookie: `wordpress_logged_in_fixture=${cookie}` },
      body,
      bodyBase64: base64(body),
      truncated: false,
    },
    response: {
      statusCode: 200,
      headers: {},
      body: response,
      bodyBase64: base64(response),
      truncated: false,
    },
  };
}

const capture = (...exchanges: ReturnType<typeof exchange>[]) => ({
  status: "captured" as const,
  ...httpCapture(
    Buffer.from(
      exchanges.map((entry) => `${JSON.stringify(entry)}\n`).join(""),
    ),
    0,
  ),
});

/** What each judge observes in a Lab where the attack worked. */
const confirming: Readonly<
  Record<string, { impact: WordPressFinding["impact"]; lab: Partial<JudgeLab> }>
> = {
  administrator: {
    impact: "account-takeover",
    lab: {
      observeAccountRoles: async () => ({
        status: "roles",
        roles: ["administrator", "subscriber"],
      }),
    },
  },
  sql: {
    impact: "sqli",
    lab: { observeCanaryTable: async () => ({ status: "changed" }) },
  },
  execution: {
    impact: "rce",
    lab: { observeExecution: async () => ({ status: "executed", files: [] }) },
  },
  fileRead: { impact: "arbitrary-file-read", lab: {} },
  fileDelete: {
    impact: "arbitrary-file-delete",
    lab: {
      observeCanaryFiles: async () => ({
        status: "observed",
        deleted: ["php-source"],
      }),
    },
  },
  storedScript: {
    impact: "stored-xss",
    lab: {
      observeStoredScript: async () => ({
        status: "observed",
        contexts: ["front"],
        screenshot: Buffer.from("synthetic observer output"),
      }),
    },
  },
};

function judge(
  name: string,
  options: {
    readonly boundary?: boolean;
    readonly lab?: Partial<JudgeLab>;
  } = {},
) {
  const { impact, lab } = confirming[name]!;
  return judgeOnce({
    impact,
    lab: quietLab({
      readCapture: async () => capture(exchange("attacker-session")),
      issuedScriptNonces: () => [nonce],
      observeSessionUser: async (_lab, cookie) => ({
        status: "user",
        login:
          cookie === "attacker-session" ? "lab-subscriber" : "harness-admin",
      }),
      ...lab,
      ...options.lab,
    }),
    files: {
      "route.json": JSON.stringify({
        ...route,
        steps: [
          { ...route.steps[0], method: "POST", body: attackBody },
          { kind: "browser", path: "/?p=7", expected: "Beacon reaches it" },
        ],
      }),
      "capture-marker.json": JSON.stringify({ marker: "0" }),
      "http.json":
        '{"exchanges":[{"request":{"method":"POST","path":"/synthetic"},"response":{"body":"saved"}}]}',
      ...(options.boundary === false ? {} : { "setup-boundary.json": "{}" }),
    },
  });
}

const judges = Object.keys(confirming);
const adminRequest = () =>
  capture(
    exchange("admin-session", "/wp-admin/users.php"),
    exchange("attacker-session"),
  );
/** Post-setup evidence no judge may confirm from, and the reason it gives. */
const defects: Readonly<Record<string, [Partial<JudgeLab>, unknown]>> = {
  "a post-setup request uses the setup administrator": [
    { readCapture: async () => adminRequest() },
    "A post-setup request session differs from the Lab attacker",
  ],
  "the attacker account's role baseline is not its declared role": [
    {
      canaryLedger: () => ({
        ...canaries,
        roleBaseline: { "lab-subscriber": ["administrator", "subscriber"] },
      }),
    },
    expect.stringMatching(/^The Lab attacker account's role baseline/),
  ],
  "the Harness's post-setup capture is missing": [
    { readCapture: async () => ({ status: "unavailable" }) },
    "The post-setup HTTP capture is unavailable; repeat in a fresh Lab",
  ],
};

describe("post-setup attribution in every judge (#430)", () => {
  it.each(judges)(
    "%s confirms a handoff route whose capture holds only the attacker",
    async (name) => {
      expect((await judge(name)).observed).toMatchObject({
        status: "observed",
      });
    },
  );

  it.each(
    judges.flatMap((name) =>
      Object.keys(defects).map((defect) => [name, defect] as const),
    ),
  )("%s stays incomplete when %s", async (name, defect) => {
    const [lab, nextStep] = defects[defect]!;
    expect((await judge(name, { lab })).observed).toEqual({
      status: "incomplete",
      reason: "evidence",
      nextStep,
    });
  });

  it("leaves a Codex recipe, which has no setup boundary, as before", async () => {
    const { observed } = await judge("sql", {
      boundary: false,
      lab: { readCapture: async () => adminRequest() },
    });
    expect(observed).toMatchObject({ status: "observed" });
  });
});
