import { createHash } from "node:crypto";

import { z } from "zod";

import {
  httpCapture,
  RECORDER_CAPTURE_PATH,
  RECORDER_DROPPED_PATH,
  type HttpCaptureRead,
} from "../../../lab/capture.js";
import type { LabReachability } from "../../../lab/index.js";
import { BEACON_LOG } from "./container-startup.js";
import type {
  ExecutionCanary,
  ScriptCanary,
  WordPressCanaryFilesObservation,
  WordPressCanaryTableObservation,
  WordPressExecutionObservation,
  WordPressFileCanary,
  WordPressLabHandle,
  WordPressOptionsObservation,
  WordPressScriptContext,
  WordPressSessionObservation,
  WordPressStoredScriptFailurePhase,
  WordPressStoredScriptFailureCode,
  WordPressStoredScriptObservation,
  WordPressVictimBrowserDiagnostic,
} from "./contract.js";
import type { WordPressLabSession } from "./lab-session.js";

/**
 * Observations the Lab makes about itself. Every function takes the active
 * session; `index.ts` resolves the handle to it and answers "unavailable" when
 * no session owns the handle.
 */

const REACHABILITY_PROBE = `$http = @file_get_contents("http://wordpress/");
$database = "not-exposed";
$user = getenv("WBH_DB_USER");
if ($user !== false && $user !== "") {
  $link = @mysqli_connect(getenv("WBH_DB_HOST"), $user, getenv("WBH_DB_PASSWORD"), getenv("WBH_DB_NAME"));
  $database = $link !== false && @mysqli_query($link, "SELECT 1") !== false ? "ok" : "failed";
}
echo json_encode(["http" => $http !== false ? "ok" : "failed", "database" => $database]);`;
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
const MAX_BROWSER_DIAGNOSTIC_BYTES = 16 * 1024;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
const diagnosticCountSchema = z.number().int().min(0).max(999_999);
const victimBrowserDiagnosticSchema = z.strictObject({
  schemaVersion: z.literal(1),
  document: z.strictObject({
    readyState: z.enum(["loading", "interactive", "complete"]),
    elementCount: diagnosticCountSchema,
    imageCount: diagnosticCountSchema,
    brokenImageCount: diagnosticCountSchema,
    inlineHandlerCount: diagnosticCountSchema,
    canaryAttributeCount: diagnosticCountSchema,
    canaryInlineHandlerCount: diagnosticCountSchema,
  }),
  runtime: z.strictObject({
    pageErrorCounts: z.strictObject({
      syntax: diagnosticCountSchema,
      reference: diagnosticCountSchema,
      type: diagnosticCountSchema,
      security: diagnosticCountSchema,
      other: diagnosticCountSchema,
    }),
    consoleErrorCount: diagnosticCountSchema,
    failedRequestCount: diagnosticCountSchema,
    http4xxCount: diagnosticCountSchema,
    http5xxCount: diagnosticCountSchema,
  }),
});
const browserVisitOutputSchema = z.strictObject({
  screenshotBase64: z.string(),
  diagnostic: z.unknown().optional(),
});

class BrowserVisitFailure extends Error {
  constructor(
    readonly failureCode: WordPressStoredScriptFailureCode,
    readonly privateDiagnostic?: Buffer,
  ) {
    super(`Browser visit failed:${failureCode}`);
  }
}
/** One page visit by the Lab's observer; dialogs are dismissed and never count. */
const BROWSER_VISIT = `const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
  const page = await browser.newPage();
  const dismissDialogs = (tab) => tab.on("dialog", (dialog) => { void dialog.dismiss(); });
  // Record bounded categories only. Browser messages, request URLs, and page
  // content are never copied into the diagnostic.
  const limit = 999999;
  const increment = (value) => Math.min(limit, value + 1);
  const runtime = {
    pageErrorCounts: { syntax: 0, reference: 0, type: 0, security: 0, other: 0 },
    consoleErrorCount: 0,
    failedRequestCount: 0,
    http4xxCount: 0,
    http5xxCount: 0,
  };
  let recordingRuntime = false;
  const observeRuntime = (tab) => {
    tab.on("pageerror", (error) => {
      if (!recordingRuntime) return;
      let kind = "other";
      switch (error.name) {
        case "SyntaxError": kind = "syntax"; break;
        case "ReferenceError": kind = "reference"; break;
        case "TypeError": kind = "type"; break;
        case "SecurityError": kind = "security"; break;
      }
      runtime.pageErrorCounts[kind] = increment(runtime.pageErrorCounts[kind]);
    });
    tab.on("console", (message) => {
      if (recordingRuntime && message.type() === "error")
        runtime.consoleErrorCount = increment(runtime.consoleErrorCount);
    });
  };
  dismissDialogs(page);
  observeRuntime(page);
  const openedPages = new Set();
  const observedPages = new Set([page]);
  const popupOpeners = new Map();
  page.context().on("page", (tab) => {
    dismissDialogs(tab);
    observeRuntime(tab);
    openedPages.add(tab);
  });
  page.context().on("requestfailed", () => {
    if (recordingRuntime)
      runtime.failedRequestCount = increment(runtime.failedRequestCount);
  });
  page.context().on("response", (response) => {
    if (!recordingRuntime) return;
    const status = response.status();
    if (status >= 400 && status < 500)
      runtime.http4xxCount = increment(runtime.http4xxCount);
    else if (status >= 500 && status < 600)
      runtime.http5xxCount = increment(runtime.http5xxCount);
  });
  const base = "http://wordpress";
  const atLabOrigin = async (tab) => {
    const url = tab.url();
    if (new URL(url).origin === base) return true;
    const opener = popupOpeners.get(tab);
    if (url !== "about:blank" || opener === undefined) return false;
    if (await tab.opener() !== opener) return false;
    return tab.evaluate((origin) => {
      try {
        return window.origin === origin &&
          window.opener !== null &&
          window.opener.document !== undefined;
      } catch {
        return false;
      }
    }, base).catch(() => false);
  };
  const user = process.env.WBH_LOGIN_USER;
  if (user) {
    // The login page is not the page under observation. A script there must
    // not make a later victim route look as though it fired.
    await page.route("http://canary:8080/**", (route) => route.abort());
    await page.goto(base + "/wp-login.php");
    await page.fill("#user_login", user);
    await page.fill("#user_pass", process.env.WBH_LOGIN_PASSWORD ?? "");
    await Promise.all([page.waitForNavigation(), page.click("#wp-submit")]);
    const cookies = await page.context().cookies(base);
    if (!cookies.some((cookie) => cookie.name.startsWith("wordpress_logged_in_")))
      throw new Error("Victim login failed");
    await page.unroute("http://canary:8080/**");
  }
  const scriptNonces = JSON.parse(process.env.WBH_SCRIPT_NONCES ?? "[]");
  const carriesScriptNonce = (value) => {
    const raw = typeof value === "string" ? value : JSON.stringify(value ?? null);
    let decoded = raw;
    try { decoded = decodeURIComponent(raw); } catch { /* malformed encoding stays raw */ }
    return scriptNonces.some((nonce) => {
      if (raw.includes(nonce) || decoded.includes(nonce)) return true;
      for (const source of [raw, decoded]) {
        for (const token of source.match(new RegExp("[A-Za-z0-9+/]{8,}={0,2}", "g")) ?? [])
          if (Buffer.from(token, "base64").toString("utf8").includes(nonce)) return true;
        for (const token of source.match(new RegExp("[a-fA-F0-9]{16,}", "g")) ?? [])
          if (Buffer.from(token, "hex").toString("utf8").includes(nonce)) return true;
      }
      return false;
    });
  };
  let victimCanaryRequest = false;
  page.context().on("request", (request) => {
    if (new URL(request.url()).origin !== base) return;
    if (
      carriesScriptNonce(request.url()) ||
      carriesScriptNonce(request.postData()) ||
      carriesScriptNonce(request.headers())
    ) victimCanaryRequest = true;
  });
  let visiblePage = page;
  recordingRuntime = true;
  await visiblePage.goto(base + process.env.WBH_VISIT_PATH, { waitUntil: "load" });
  if (new URL(visiblePage.url()).origin !== base)
    throw new Error("Victim navigation left the Lab origin");
  const actions = JSON.parse(process.env.WBH_VISIT_ACTIONS ?? "[]");
  for (const action of actions) {
    const target = action.kind === "click-text"
      ? visiblePage.getByText(action.text, { exact: action.exact })
      : visiblePage.locator(action.selector);
    await target.waitFor({ state: "visible", timeout: 10000 }).catch(() => {
      throw new Error("Victim action not visible");
    });
    if (await target.count() !== 1)
      throw new Error("Victim action did not identify one visible element");
    const opener = visiblePage;
    const expectsPopup = await target.evaluate((element) => {
      const carriers = [
        element.closest('a[target],form[target]'),
        element.querySelector('a[target="_blank"],form[target="_blank"]'),
      ];
      return carriers.some((carrier) =>
        carrier?.getAttribute('target')?.toLowerCase() === '_blank'
      );
    });
    const popup = visiblePage.waitForEvent("popup", { timeout: expectsPopup ? 10000 : 1500 })
      .then((tab) => tab, () => null);
    if (action.kind === "fill") {
      await target.fill(action.value, { timeout: 10000 }).catch(() => {
        throw new Error("Victim action fill failed");
      });
      continue;
    }
    await target.click({ timeout: 10000 }).catch(() => {
      throw new Error("Victim action click failed");
    });
    const opened = await popup;
    if (expectsPopup && opened === null)
      throw new Error("Expected victim popup did not open");
    if (opened !== null) {
      observedPages.add(opened);
      popupOpeners.set(opened, opener);
      visiblePage = opened;
    }
    await visiblePage.waitForLoadState("load", { timeout: 10000 });
    if (!await atLabOrigin(visiblePage))
      throw new Error("Victim action left the Lab origin");
  }
  await visiblePage.waitForTimeout(3000);
  if (victimCanaryRequest)
    throw new Error("Victim request carried the script canary");
  if ([...openedPages].some((tab) => !observedPages.has(tab)))
    throw new Error("Unobserved victim popup opened");
  for (const tab of observedPages)
    if (!tab.isClosed() && !await atLabOrigin(tab))
      throw new Error("Victim observation left the Lab origin");
  recordingRuntime = false;
  let documentDiagnostic;
  try {
    documentDiagnostic = await visiblePage.evaluate((nonces) => {
    const limit = 999999;
    const elements = document.querySelectorAll("*");
    let imageCount = 0;
    let brokenImageCount = 0;
    let inlineHandlerCount = 0;
    let canaryAttributeCount = 0;
    let canaryInlineHandlerCount = 0;
    for (const element of elements) {
      if (element instanceof HTMLImageElement) {
        imageCount++;
        if (element.complete && element.naturalWidth === 0) brokenImageCount++;
      }
      for (const attribute of element.attributes) {
        const handler = attribute.name.toLowerCase().startsWith("on");
        const carriesCanary = nonces.some((nonce) => attribute.value.includes(nonce));
        if (handler) inlineHandlerCount++;
        if (carriesCanary) canaryAttributeCount++;
        if (handler && carriesCanary) canaryInlineHandlerCount++;
      }
    }
    return {
      readyState: document.readyState,
      elementCount: Math.min(limit, elements.length),
      imageCount: Math.min(limit, imageCount),
      brokenImageCount: Math.min(limit, brokenImageCount),
      inlineHandlerCount: Math.min(limit, inlineHandlerCount),
      canaryAttributeCount: Math.min(limit, canaryAttributeCount),
      canaryInlineHandlerCount: Math.min(limit, canaryInlineHandlerCount),
    };
    }, scriptNonces);
  } catch {
    // Diagnostics must never turn a completed canary observation into failure.
  }
  const screenshot = await visiblePage.screenshot({ type: "png" });
  if (screenshot.length > ${MAX_SCREENSHOT_BYTES})
    throw new Error("Browser screenshot exceeds the evidence limit");
  process.stdout.write(JSON.stringify({
    screenshotBase64: screenshot.toString("base64"),
    ...(documentDiagnostic === undefined ? {} : {
      diagnostic: {
        schemaVersion: 1,
        document: documentDiagnostic,
        runtime,
      },
    }),
  }));
  } finally {
    await browser.close();
  }
})().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});`;
export const wordpressVisitPathSchema = z
  .string()
  .max(2048)
  .regex(/^\/(?!\/)[^\s\0\\]*$/);
export const wordpressVictimActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("click"),
    selector: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[#.a-zA-Z0-9_ \[\]="'():>+~*,-]+$/),
  }),
  z.strictObject({
    kind: z.literal("click-text"),
    text: z.string().min(1).max(120),
    exact: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal("fill"),
    selector: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[#.a-zA-Z0-9_ \[\]="'():>+~*,-]+$/),
    value: z.string().min(1).max(120),
  }),
]);
const victimVisitSchema = z.union([
  wordpressVisitPathSchema,
  z.strictObject({
    path: wordpressVisitPathSchema,
    actions: z.array(wordpressVictimActionSchema).min(1).max(5),
  }),
]);
export const wordpressVictimRouteSchema = z.strictObject({
  role: z.enum(["administrator", "subscriber", "customer", "unauthenticated"]),
  paths: z.array(victimVisitSchema).min(1).max(5),
});
export type WordPressVictimRoute = z.infer<typeof wordpressVictimRouteSchema>;
type VictimActions = readonly z.infer<typeof wordpressVictimActionSchema>[];

function observerInputCarriesCanary(
  value: unknown,
  nonces: ReadonlySet<string>,
): boolean {
  const raw = JSON.stringify(value ?? null);
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // Malformed percent encoding still receives the raw comparison.
  }
  return [...nonces].some((nonce) => {
    if (raw.includes(nonce) || decoded.includes(nonce)) return true;
    for (const source of [raw, decoded]) {
      for (const token of source.match(/[A-Za-z0-9+/]{8,}={0,2}/g) ?? [])
        if (Buffer.from(token, "base64").toString("utf8").includes(nonce))
          return true;
      for (const token of source.match(/[a-fA-F0-9]{16,}/g) ?? [])
        if (Buffer.from(token, "hex").toString("utf8").includes(nonce))
          return true;
    }
    return false;
  });
}

export async function markCapture(
  lab: WordPressLabSession,
): Promise<string | null> {
  const result = await lab.docker([
    "exec",
    lab.recorder,
    "wc",
    "-c",
    RECORDER_CAPTURE_PATH,
  ]);
  const marker = result.stdout.trim().split(/\s+/)[0];
  return result.exitCode === 0 && marker !== undefined && /^\d+$/.test(marker)
    ? marker
    : null;
}

export async function readCapture(
  lab: WordPressLabSession,
  sinceMarker: string,
): Promise<HttpCaptureRead> {
  if (
    !/^\d+$/.test(sinceMarker) ||
    !Number.isSafeInteger(Number(sinceMarker)) ||
    Number(sinceMarker) > 64 * 1024 * 1024
  )
    return { status: "unavailable" };
  const [capture, dropped] = await Promise.all([
    lab.docker(
      [
        "exec",
        lab.recorder,
        "tail",
        "-c",
        `+${Number(sinceMarker) + 1}`,
        RECORDER_CAPTURE_PATH,
      ],
      60_000,
      64 * 1024 * 1024 + 1024,
    ),
    lab.docker([
      "exec",
      lab.recorder,
      "sh",
      "-c",
      `cat ${RECORDER_DROPPED_PATH} 2>/dev/null || printf 0`,
    ]),
  ]);
  const count = Number(dropped.stdout.trim());
  if (
    capture.exitCode !== 0 ||
    dropped.exitCode !== 0 ||
    !Number.isSafeInteger(count) ||
    count < 0
  )
    return { status: "unavailable" };
  return {
    status: "captured",
    ...httpCapture(Buffer.from(capture.stdout, "utf8"), count),
  };
}

/** The probe result for a Lab that cannot be reached at all. */
export function labUnreachable(handle: WordPressLabHandle): LabReachability {
  return {
    http: "failed",
    database: handle.database === undefined ? "not-exposed" : "failed",
  };
}

export async function probe(
  lab: WordPressLabSession,
): Promise<LabReachability> {
  const { handle } = lab;
  const database = handle.database;
  try {
    const result = await lab.docker(
      [
        "run",
        "--rm",
        "--runtime=runsc",
        "--network",
        lab.network,
        `--add-host=wordpress:${handle.internalIp}`,
        ...(database === undefined
          ? []
          : [
              `--add-host=${database.host}:${database.ipv4}`,
              "--env",
              `WBH_DB_HOST=${database.host}`,
              "--env",
              `WBH_DB_USER=${database.readOnlyAccount.username}`,
              "--env",
              `WBH_DB_PASSWORD=${database.readOnlyAccount.password}`,
              "--env",
              `WBH_DB_NAME=${database.name}`,
            ]),
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--tmpfs=/tmp:rw,nosuid,nodev,size=16m",
        "--entrypoint=php",
        lab.images.wordpress,
        "-r",
        REACHABILITY_PROBE,
      ],
      60_000,
    );
    if (result.exitCode !== 0) return labUnreachable(handle);
    const parsed = z
      .strictObject({
        http: z.enum(["ok", "failed"]),
        database: z.enum(["ok", "failed", "not-exposed"]),
      })
      .safeParse(JSON.parse(result.stdout.trim()) as unknown);
    return parsed.success ? parsed.data : labUnreachable(handle);
  } catch {
    return labUnreachable(handle);
  }
}

export function prepareExecutionCanary(
  lab: WordPressLabSession,
): ExecutionCanary | null {
  const token = lab.nonce();
  if (!/^[A-Za-z0-9-]{1,100}$/.test(token)) return null;
  lab.executionNonces.add(token);
  const path = `/tmp/wbh-execution-${token}`;
  return {
    nonce: token,
    php: `<?php file_put_contents('${path}', hash('sha256', '${token}' . getenv('WBH_EXECUTION_SALT'))); ?>`,
  };
}

export async function observeSessionUser(
  lab: WordPressLabSession,
  cookie: string,
  scheme: "logged_in" | "auth" | "secure_auth" = "logged_in",
): Promise<WordPressSessionObservation> {
  // The value travels as an environment variable, never as PHP source.
  if (!/^[A-Za-z0-9%|._@+-]{1,4096}$/.test(cookie)) return { status: "none" };
  try {
    const result = await lab.wp(
      [
        "eval",
        '$id = wp_validate_auth_cookie(rawurldecode((string) getenv("WBH_SESSION_COOKIE")), (string) getenv("WBH_SESSION_SCHEME")); echo $id ? get_userdata($id)->user_login : "";',
      ],
      [`WBH_SESSION_COOKIE=${cookie}`, `WBH_SESSION_SCHEME=${scheme}`],
    );
    const login = result.stdout.trim();
    return login === "" ? { status: "none" } : { status: "user", login };
  } catch {
    return { status: "unavailable" };
  }
}

export async function observeCanaryTable(
  lab: WordPressLabSession,
): Promise<WordPressCanaryTableObservation> {
  const canary = lab.canaries?.sqlCanary;
  if (canary === undefined) return { status: "unavailable" };
  try {
    const present = await lab.wp([
      "db",
      "query",
      `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${canary.table}'`,
      "--skip-column-names",
    ]);
    if (present.stdout.trim() === "0") return { status: "changed" };
    const rows = await lab.wp([
      "db",
      "query",
      `SELECT id, value FROM ${canary.table} ORDER BY id`,
      "--skip-column-names",
    ]);
    return {
      status:
        rows.stdout.trim() === `1\t${canary.value}` ? "intact" : "changed",
    };
  } catch {
    return { status: "unavailable" };
  }
}

export async function observeCanaryFiles(
  lab: WordPressLabSession,
): Promise<WordPressCanaryFilesObservation> {
  const files = lab.canaries?.fileCanaries;
  if (files === undefined) return { status: "unavailable" };
  const deleted: WordPressFileCanary["kind"][] = [];
  for (const file of files) {
    const result = await lab.docker(
      ["exec", lab.wordpress, "test", "-e", file.path],
      10_000,
    );
    if (result.exitCode === 1) deleted.push(file.kind);
    else if (result.exitCode !== 0) return { status: "unavailable" };
  }
  return { status: "observed", deleted };
}

export function prepareScriptCanary(
  lab: WordPressLabSession,
): ScriptCanary | null {
  const token = lab.nonce();
  if (!/^[A-Za-z0-9-]{1,100}$/.test(token)) return null;
  lab.scriptNonces.add(token);
  const beaconUrl = `http://canary:8080/b/${token}`;
  return {
    nonce: token,
    beaconUrl,
    javascript: `fetch(${JSON.stringify(beaconUrl)}, { method: "POST", headers: { "X-WBH-Script-Canary": ${JSON.stringify(token)} } });`,
    loaderJavascript: `import("//canary:8080/c/${token}")`,
  };
}

async function readBeaconCount(
  lab: WordPressLabSession,
  issued: ReadonlySet<string>,
): Promise<number> {
  const log = await lab.docker(
    ["exec", lab.receiver, "cat", BEACON_LOG],
    10_000,
  );
  if (log.exitCode === 1 && log.stdout === "") return 0;
  if (log.exitCode !== 0) throw new Error("Beacon log unreadable");
  return log.stdout.split("\n").filter((line) => issued.has(line)).length;
}

async function visitStoredScriptPage(input: {
  readonly lab: WordPressLabSession;
  readonly receiverIp: string;
  readonly issued: ReadonlySet<string>;
  readonly path: string;
  readonly role: WordPressVictimRoute["role"];
  readonly actions?: VictimActions;
}): Promise<{
  readonly fired: boolean;
  readonly screenshot: Buffer;
  readonly diagnostic?: WordPressVictimBrowserDiagnostic;
}> {
  const { lab, receiverIp, issued, path, role, actions } = input;
  const account =
    role === "administrator"
      ? { username: "harness-admin", password: lab.adminPassword }
      : role === "unauthenticated"
        ? undefined
        : lab.victimAccounts[role];
  if (role !== "unauthenticated" && account === undefined)
    throw new Error("Victim role is unavailable");
  const before = await readBeaconCount(lab, issued);
  const result = await lab.docker(
    [
      "run",
      "--rm",
      "--runtime=runsc",
      "--network",
      lab.network,
      `--add-host=wordpress:${lab.handle.internalIp}`,
      `--add-host=canary:${receiverIp}`,
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--tmpfs=/tmp:rw,nosuid,nodev,size=512m",
      "--workdir=/harness",
      ...(account === undefined
        ? []
        : [
            "--env",
            `WBH_LOGIN_USER=${account.username}`,
            "--env",
            `WBH_LOGIN_PASSWORD=${account.password}`,
          ]),
      "--env",
      `WBH_VISIT_PATH=${path}`,
      "--env",
      `WBH_VISIT_ACTIONS=${JSON.stringify(actions ?? [])}`,
      "--env",
      `WBH_SCRIPT_NONCES=${JSON.stringify([...lab.scriptNonces])}`,
      "--entrypoint=node",
      lab.images.browser,
      "-e",
      BROWSER_VISIT,
    ],
    120_000,
    Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4 + MAX_BROWSER_DIAGNOSTIC_BYTES,
  );
  if (result.exitCode !== 0) {
    const known: readonly [string, WordPressStoredScriptFailureCode][] = [
      ["Victim login failed", "victim-login"],
      ["Victim action not visible", "victim-action-not-visible"],
      [
        "Victim action did not identify one visible element",
        "victim-action-ambiguous",
      ],
      ["Victim action click failed", "victim-action-click"],
      ["Victim action fill failed", "victim-action-fill"],
      ["Expected victim popup did not open", "victim-popup"],
      ["Victim navigation left the Lab origin", "victim-navigation"],
      ["Victim action left the Lab origin", "victim-navigation"],
      ["Victim observation left the Lab origin", "victim-navigation"],
      ["Unobserved victim popup opened", "victim-unobserved-popup"],
      ["Victim request carried the script canary", "victim-canary-request"],
      ["Browser screenshot exceeds the evidence limit", "victim-screenshot"],
    ];
    const failureCode =
      known.find(([message]) => result.stderr.includes(message))?.[1] ??
      "browser-visit";
    const stderr = Buffer.from(result.stderr, "utf8");
    throw new BrowserVisitFailure(
      failureCode,
      failureCode === "browser-visit" && stderr.length > 0
        ? Buffer.from(stderr.subarray(0, MAX_BROWSER_DIAGNOSTIC_BYTES))
        : undefined,
    );
  }
  let output: unknown;
  try {
    output = JSON.parse(result.stdout);
  } catch {
    throw new Error("Browser visit output is invalid");
  }
  const parsed = browserVisitOutputSchema.safeParse(output);
  if (!parsed.success) throw new Error("Browser visit output is invalid");
  const diagnostic = victimBrowserDiagnosticSchema.safeParse(
    parsed.data.diagnostic,
  );
  const encoded = parsed.data.screenshotBase64;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))
    throw new Error("Browser screenshot is missing");
  const screenshot = Buffer.from(encoded, "base64");
  if (
    screenshot.length === 0 ||
    screenshot.length > MAX_SCREENSHOT_BYTES ||
    !screenshot.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE) ||
    screenshot.toString("base64") !== encoded
  )
    throw new Error("Browser screenshot is invalid");
  return {
    fired: (await readBeaconCount(lab, issued)) > before,
    screenshot,
    ...(diagnostic.success ? { diagnostic: diagnostic.data } : {}),
  };
}

export async function observeStoredScript(
  lab: WordPressLabSession,
  input: {
    readonly routePaths: readonly string[];
    readonly victim?: WordPressVictimRoute;
  },
): Promise<WordPressStoredScriptObservation> {
  const { receiverIp } = lab;
  if (receiverIp === undefined) return { status: "unavailable", phase: "lab" };
  if (lab.scriptNonces.size === 0) return { status: "not-prepared" };
  const routePaths = z
    .array(wordpressVisitPathSchema)
    .max(5)
    .safeParse(input.routePaths);
  if (!routePaths.success)
    return { status: "unavailable", phase: "route-input" };
  const victim =
    input.victim === undefined
      ? undefined
      : wordpressVictimRouteSchema.safeParse(input.victim);
  if (victim !== undefined && !victim.success)
    return { status: "unavailable", phase: "victim-input" };
  if (observerInputCarriesCanary(routePaths.data, lab.scriptNonces))
    return {
      status: "unavailable",
      phase: "route-input",
      failureCode: "observer-canary-input",
    };
  if (
    victim?.success &&
    observerInputCarriesCanary(victim.data, lab.scriptNonces)
  )
    return {
      status: "unavailable",
      phase: "victim-input",
      failureCode: "observer-canary-input",
    };
  const issued = new Set([...lab.scriptNonces].map((token) => `/b/${token}`));
  let phase: WordPressStoredScriptFailurePhase = "front";
  try {
    const contexts: WordPressScriptContext[] = [];
    let screenshot: Buffer | undefined;
    let diagnosticVictimScreenshot: Buffer | undefined;
    let victimBrowserDiagnostic: WordPressVictimBrowserDiagnostic | undefined;
    const fired = async (
      path: string,
      role: WordPressVictimRoute["role"],
      actions?: VictimActions,
      victimVisit = false,
    ): Promise<boolean> => {
      const observation = await visitStoredScriptPage({
        lab,
        receiverIp,
        issued,
        path,
        role,
        ...(actions === undefined ? {} : { actions }),
      });
      if (observation.fired) screenshot ??= observation.screenshot;
      else if (victimVisit) {
        diagnosticVictimScreenshot = observation.screenshot;
        victimBrowserDiagnostic = observation.diagnostic;
      }
      return observation.fired;
    };
    if (await fired("/", "unauthenticated")) contexts.push("front");
    phase = "dashboard";
    const dashboard = await fired("/wp-admin/", "administrator");
    phase = "posts";
    const posts = await fired("/wp-admin/edit.php", "administrator");
    if (dashboard && posts) contexts.push("admin-all");
    else if (dashboard || posts) contexts.push("admin-partial");
    let routePage = false;
    phase = "route-page";
    for (const path of routePaths.data)
      if (await fired(path, "unauthenticated")) routePage = true;
    if (routePage) contexts.push("route-page");
    let victimPage = false;
    if (victim?.success) {
      phase = "victim-page";
      for (const visit of victim.data.paths) {
        const path = typeof visit === "string" ? visit : visit.path;
        const actions = typeof visit === "string" ? undefined : visit.actions;
        if (await fired(path, victim.data.role, actions, true))
          victimPage = true;
      }
    }
    if (victimPage) contexts.push("victim-route-page");
    const victimRole =
      victim?.success && victimPage ? victim.data.role : undefined;
    const sameAccount =
      (victimRole === "subscriber" || victimRole === "customer") &&
      lab.victimAccounts[victimRole]?.username ===
        lab.handle.attackerAccounts[victimRole]?.username;
    const selectedScreenshot = screenshot ?? diagnosticVictimScreenshot;
    return {
      status: "observed",
      contexts,
      ...(victimRole === undefined
        ? {}
        : { victimRole: sameAccount ? ("self" as const) : victimRole }),
      ...(selectedScreenshot === undefined
        ? {}
        : { screenshot: selectedScreenshot }),
      ...(victimBrowserDiagnostic === undefined
        ? {}
        : { victimBrowserDiagnostic }),
    };
  } catch (error) {
    return {
      status: "unavailable",
      phase,
      failureCode:
        error instanceof BrowserVisitFailure
          ? error.failureCode
          : "browser-visit",
      ...(error instanceof BrowserVisitFailure &&
      error.privateDiagnostic !== undefined
        ? { privateDiagnostic: error.privateDiagnostic }
        : {}),
    };
  }
}

export async function observeOptions(
  lab: WordPressLabSession,
): Promise<WordPressOptionsObservation> {
  const baseline = lab.optionBaseline;
  if (baseline === undefined) return { status: "unavailable" };
  try {
    const changed: string[] = [];
    for (const [name, digest] of baseline)
      if ((await lab.optionDigest(name)) !== digest) changed.push(name);
    return { status: "observed", changed };
  } catch {
    return { status: "unavailable" };
  }
}

export async function observeExecution(
  lab: WordPressLabSession,
): Promise<WordPressExecutionObservation> {
  if (lab.executionNonces.size === 0) return { status: "not-prepared" };
  try {
    for (const token of lab.executionNonces) {
      const marker = await lab.docker(
        ["exec", lab.wordpress, "cat", `/tmp/wbh-execution-${token}`],
        10_000,
      );
      const expected = createHash("sha256")
        .update(`${token}${lab.executionSalt}`)
        .digest("hex");
      if (marker.exitCode !== 0 || marker.stdout.trim() !== expected) continue;
      const found = await lab.docker(
        ["exec", lab.wordpress, "grep", "-rlF", "--", token, "/var/www/html"],
        30_000,
      );
      const files = found.stdout
        .split("\n")
        .filter((line) => line.startsWith("/var/www/html/"))
        .slice(0, 5)
        .map((line) => line.slice("/var/www/html/".length));
      return { status: "executed", files };
    }
    return { status: "not-executed" };
  } catch {
    return { status: "unavailable" };
  }
}
