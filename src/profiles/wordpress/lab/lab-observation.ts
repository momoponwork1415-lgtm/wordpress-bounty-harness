import { z } from "zod";

import {
  httpCapture,
  RECORDER_CAPTURE_PATH,
  RECORDER_DROPPED_PATH,
  type HttpCaptureRead,
} from "../../../lab/capture.js";
import type { LabReachability } from "../../../lab/index.js";
import type {
  WordPressDialogEvent,
  WordPressLabHandle,
  WordPressVictimBrowserDiagnostic,
  WordPressVictimPagesFailureCode,
  WordPressVictimPagesObservation,
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
  /** Status of the response to the visited path itself, before any action. */
  httpStatus: z.number().int().min(100).max(599).optional(),
  dialogCount: diagnosticCountSchema.optional(),
  consoleErrorCount: diagnosticCountSchema.optional(),
  dialogEvent: z
    .strictObject({
      type: z.literal("alert"),
      message: z.string(),
      topLevelPageUrlAtEvent: z.string().max(2048),
      topLevelPageOriginAtEvent: z.literal("http://wordpress"),
      frameUrlsAtEvent: z.array(z.string().max(2048)).min(1).max(50),
    })
    .optional(),
  diagnostic: z.unknown().optional(),
});

class BrowserVisitFailure extends Error {
  constructor(
    readonly failureCode: WordPressVictimPagesFailureCode,
    readonly privateDiagnostic?: Buffer,
  ) {
    super(`Browser visit failed:${failureCode}`);
  }
}
/** One victim page visit by the Lab's observer; it records, and never decides. */
const BROWSER_VISIT = `const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
  const page = await browser.newPage();
  const dialogMarker = process.env.WBH_DIALOG_MARKER ?? "";
  const markerDialogs = new Map();
  let recordingRuntime = false;
  // Every dialog while recording is counted; only the marker's is described.
  let dialogCount = 0;
  const dismissDialogs = (tab) => tab.on("dialog", (dialog) => {
    if (recordingRuntime) dialogCount = Math.min(999999, dialogCount + 1);
    if (recordingRuntime && dialogMarker !== "" &&
        dialog.type() === "alert" && dialog.message() === dialogMarker)
      markerDialogs.set(tab, {
        type: dialog.type(),
        message: dialog.message(),
        topLevelPageUrlAtEvent: tab.url(),
        frameUrlsAtEvent: tab.frames().map((frame) => frame.url()),
      });
    void dialog.dismiss();
  });
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
    await page.goto(base + "/wp-login.php");
    await page.fill("#user_login", user);
    await page.fill("#user_pass", process.env.WBH_LOGIN_PASSWORD ?? "");
    await Promise.all([page.waitForNavigation(), page.click("#wp-submit")]);
    const cookies = await page.context().cookies(base);
    if (!cookies.some((cookie) => cookie.name.startsWith("wordpress_logged_in_")))
      throw new Error("Victim login failed");
  }
  let visiblePage = page;
  recordingRuntime = true;
  const navigation = await visiblePage.goto(base + process.env.WBH_VISIT_PATH, { waitUntil: "load" });
  const httpStatus = navigation ? navigation.status() : undefined;
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
  if ([...openedPages].some((tab) => !observedPages.has(tab)))
    throw new Error("Unobserved victim popup opened");
  for (const tab of observedPages)
    if (!tab.isClosed() && !await atLabOrigin(tab))
      throw new Error("Victim observation left the Lab origin");
  let dialogEvent;
  for (const [tab, event] of markerDialogs) {
    // Page dialogs have no source frame; reject non-Lab frames and later navigation.
    if (tab !== visiblePage || !observedPages.has(tab) || tab.isClosed() ||
        tab.url() !== event.topLevelPageUrlAtEvent ||
        event.topLevelPageUrlAtEvent.length > 2048 ||
        event.frameUrlsAtEvent.length === 0 ||
        event.frameUrlsAtEvent.length > 50 ||
        event.frameUrlsAtEvent.some((url) => url.length > 2048)) continue;
    const origin = (url) => {
      try { return new URL(url).origin; } catch { return null; }
    };
    if (origin(event.topLevelPageUrlAtEvent) !== base ||
        event.frameUrlsAtEvent.some((url) => origin(url) !== base)) continue;
    dialogEvent = { ...event, topLevelPageOriginAtEvent: base };
    break;
  }
  recordingRuntime = false;
  let documentDiagnostic;
  try {
    documentDiagnostic = await visiblePage.evaluate(() => {
    const limit = 999999;
    const elements = document.querySelectorAll("*");
    let imageCount = 0;
    let brokenImageCount = 0;
    let inlineHandlerCount = 0;
    for (const element of elements) {
      if (element instanceof HTMLImageElement) {
        imageCount++;
        if (element.complete && element.naturalWidth === 0) brokenImageCount++;
      }
      for (const attribute of element.attributes)
        if (attribute.name.toLowerCase().startsWith("on")) inlineHandlerCount++;
    }
    return {
      readyState: document.readyState,
      elementCount: Math.min(limit, elements.length),
      imageCount: Math.min(limit, imageCount),
      brokenImageCount: Math.min(limit, brokenImageCount),
      inlineHandlerCount: Math.min(limit, inlineHandlerCount),
    };
    });
  } catch {
    // Diagnostics must never turn a completed observation into failure.
  }
  const screenshot = await visiblePage.screenshot({ type: "png" });
  if (screenshot.length > ${MAX_SCREENSHOT_BYTES})
    throw new Error("Browser screenshot exceeds the evidence limit");
  process.stdout.write(JSON.stringify({
    screenshotBase64: screenshot.toString("base64"),
    ...(httpStatus === undefined ? {} : { httpStatus }),
    dialogCount,
    consoleErrorCount: runtime.consoleErrorCount,
    ...(dialogEvent === undefined ? {} : { dialogEvent }),
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
  /** Written in attacker JavaScript as alert(1234567890), without quotes. */
  dialogMarker: z
    .string()
    .regex(/^[1-9][0-9]{9,14}$/)
    .optional(),
});
export type WordPressVictimRoute = z.infer<typeof wordpressVictimRouteSchema>;
type VictimActions = readonly z.infer<typeof wordpressVictimActionSchema>[];

/** True when the observer's own input carries the marker, however it was encoded. */
function observerInputCarriesMarker(value: unknown, marker: string): boolean {
  const raw = JSON.stringify(value ?? null);
  const layers = [raw];
  let current = raw;
  for (let depth = 0; depth < 5; depth++) {
    // Decode ASCII markers even alongside malformed percent sequences.
    const next = current.replace(/%([0-9a-fA-F]{2})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
    if (next === current) break;
    layers.push(next);
    current = next;
  }
  // Reject unresolved deep percent encoding instead of trusting a hidden marker.
  if (/%[0-9a-fA-F]{2}/.test(current)) return true;
  for (const source of layers) {
    if (source.includes(marker)) return true;
    for (const token of source.match(/[A-Za-z0-9+/]{8,}={0,2}/g) ?? [])
      if (Buffer.from(token, "base64").toString("utf8").includes(marker))
        return true;
    for (const token of source.match(/[a-fA-F0-9]{16,}/g) ?? [])
      if (Buffer.from(token, "hex").toString("utf8").includes(marker))
        return true;
  }
  return false;
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

/**
 * One visit by the Lab's Playwright observer as `account` (none: logged out).
 * Shared by the verification victim pages and by the exploration Lab's
 * `/observe`. It records, and never decides.
 */
async function runBrowserVisit(input: {
  readonly lab: WordPressLabSession;
  readonly path: string;
  readonly account?: { readonly username: string; readonly password: string };
  readonly actions?: VictimActions;
  readonly dialogMarker?: string;
}): Promise<{
  readonly httpStatus?: number;
  readonly dialogCount?: number;
  readonly consoleErrorCount?: number;
  readonly dialogEvent?: WordPressDialogEvent;
  readonly screenshot: Buffer;
  readonly diagnostic?: WordPressVictimBrowserDiagnostic;
}> {
  const { lab, path, account, actions } = input;
  const result = await lab.docker(
    [
      "run",
      "--rm",
      "--runtime=runsc",
      "--network",
      lab.network,
      `--add-host=wordpress:${lab.handle.internalIp}`,
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
      ...(input.dialogMarker === undefined
        ? []
        : ["--env", `WBH_DIALOG_MARKER=${input.dialogMarker}`]),
      "--entrypoint=node",
      lab.images.browser,
      "-e",
      BROWSER_VISIT,
    ],
    120_000,
    Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4 + MAX_BROWSER_DIAGNOSTIC_BYTES,
  );
  if (result.exitCode !== 0) {
    const known: readonly [string, WordPressVictimPagesFailureCode][] = [
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
    ...(parsed.data.httpStatus === undefined
      ? {}
      : { httpStatus: parsed.data.httpStatus }),
    ...(parsed.data.dialogCount === undefined
      ? {}
      : { dialogCount: parsed.data.dialogCount }),
    ...(parsed.data.consoleErrorCount === undefined
      ? {}
      : { consoleErrorCount: parsed.data.consoleErrorCount }),
    ...(parsed.data.dialogEvent === undefined
      ? {}
      : { dialogEvent: parsed.data.dialogEvent }),
    screenshot,
    ...(diagnostic.success ? { diagnostic: diagnostic.data } : {}),
  };
}

async function visitVictimPage(input: {
  readonly lab: WordPressLabSession;
  readonly path: string;
  readonly role: WordPressVictimRoute["role"];
  readonly actions?: VictimActions;
  readonly dialogMarker?: string;
}): Promise<{
  readonly dialogEvent?: WordPressDialogEvent;
  readonly screenshot: Buffer;
  readonly diagnostic?: WordPressVictimBrowserDiagnostic;
}> {
  const { lab, path, role, actions } = input;
  const account =
    role === "administrator"
      ? { username: "harness-admin", password: lab.adminPassword }
      : role === "unauthenticated"
        ? undefined
        : lab.victimAccounts[role];
  if (role !== "unauthenticated" && account === undefined)
    throw new Error("Victim role is unavailable");
  const visit = await runBrowserVisit({
    lab,
    path,
    ...(account === undefined ? {} : { account }),
    ...(actions === undefined ? {} : { actions }),
    ...(input.dialogMarker === undefined
      ? {}
      : { dialogMarker: input.dialogMarker }),
  });
  return {
    ...(visit.dialogEvent === undefined
      ? {}
      : { dialogEvent: visit.dialogEvent }),
    screenshot: visit.screenshot,
    ...(visit.diagnostic === undefined ? {} : { diagnostic: visit.diagnostic }),
  };
}

/**
 * The exploration Lab's `/observe` (ADR 0003, 2026-10-25 addendum, Phase D2):
 * the agent names a role of the Lab's own accounts, a path and optional typed
 * actions; the verification observer opens it. No script is accepted and
 * nothing is judged: the answer is what the browser saw.
 */
export const wordpressExplorationObserveSchema = z.strictObject({
  role: z.enum(["visitor", "subscriber", "customer", "administrator"]),
  path: wordpressVisitPathSchema,
  actions: z.array(wordpressVictimActionSchema).min(1).max(5).optional(),
  /** Written in the page's JavaScript as alert(1234567890), without quotes. */
  dialogMarker: z
    .string()
    .regex(/^[1-9][0-9]{9,14}$/)
    .optional(),
});
export type WordPressExplorationObserveRequest = z.infer<
  typeof wordpressExplorationObserveSchema
>;

export type WordPressExplorationObservation =
  | {
      readonly status: "observed";
      /** Status of the response to `path`; absent when the browser saw none. */
      readonly httpStatus?: number;
      /** Dialogs that opened on the observed pages, any text. */
      readonly dialogCount: number;
      /** With a marker only: whether an alert with exactly that text opened. */
      readonly markerDialog?: boolean;
      readonly consoleErrorCount: number;
      readonly screenshot: Buffer;
    }
  | {
      readonly status: "failed";
      readonly failureCode: WordPressVictimPagesFailureCode;
    }
  | { readonly status: "role-unavailable" };

export async function observeExplorationPage(
  lab: WordPressLabSession,
  request: WordPressExplorationObserveRequest,
): Promise<WordPressExplorationObservation> {
  const account =
    request.role === "administrator"
      ? { username: "harness-admin", password: lab.adminPassword }
      : request.role === "visitor"
        ? undefined
        : lab.attackerAccounts[request.role];
  if (request.role !== "visitor" && account === undefined)
    return { status: "role-unavailable" };
  try {
    const visit = await runBrowserVisit({
      lab,
      path: request.path,
      ...(account === undefined ? {} : { account }),
      ...(request.actions === undefined ? {} : { actions: request.actions }),
      ...(request.dialogMarker === undefined
        ? {}
        : { dialogMarker: request.dialogMarker }),
    });
    return {
      status: "observed",
      ...(visit.httpStatus === undefined
        ? {}
        : { httpStatus: visit.httpStatus }),
      dialogCount: visit.dialogCount ?? 0,
      ...(request.dialogMarker === undefined
        ? {}
        : { markerDialog: visit.dialogEvent !== undefined }),
      consoleErrorCount: visit.consoleErrorCount ?? 0,
      screenshot: visit.screenshot,
    };
  } catch (error) {
    return {
      status: "failed",
      failureCode:
        error instanceof BrowserVisitFailure
          ? error.failureCode
          : "browser-visit",
    };
  }
}

/**
 * Opens the declared victim pages in fresh Lab browsers as the declared
 * victim and records what each showed: the first dialog carrying the declared
 * marker, and the last page's screen (#525). A person reads the record; this
 * observer decides nothing.
 */
export async function observeVictimPages(
  lab: WordPressLabSession,
  input: WordPressVictimRoute,
): Promise<WordPressVictimPagesObservation> {
  const victim = wordpressVictimRouteSchema.safeParse(input);
  if (!victim.success) return { status: "unavailable", phase: "victim-input" };
  const { role, paths, dialogMarker } = victim.data;
  if (
    dialogMarker !== undefined &&
    observerInputCarriesMarker({ paths }, dialogMarker)
  )
    return {
      status: "unavailable",
      phase: "victim-input",
      failureCode: "observer-marker-input",
    };
  try {
    let screenshot: Buffer | undefined;
    let victimBrowserDiagnostic: WordPressVictimBrowserDiagnostic | undefined;
    let dialog:
      | {
          readonly visitIndex: number;
          readonly event: WordPressDialogEvent;
          readonly screenshot: Buffer;
        }
      | undefined;
    for (const [index, visit] of paths.entries()) {
      const observation = await visitVictimPage({
        lab,
        path: typeof visit === "string" ? visit : visit.path,
        role,
        ...(typeof visit === "string" ? {} : { actions: visit.actions }),
        ...(dialogMarker === undefined ? {} : { dialogMarker }),
      });
      screenshot = observation.screenshot;
      victimBrowserDiagnostic = observation.diagnostic;
      if (observation.dialogEvent !== undefined && dialog === undefined)
        dialog = {
          visitIndex: index,
          event: observation.dialogEvent,
          screenshot: observation.screenshot,
        };
    }
    const sameAccount =
      (role === "subscriber" || role === "customer") &&
      lab.victimAccounts[role]?.username ===
        lab.handle.attackerAccounts[role]?.username;
    return {
      status: "observed",
      victimRole: sameAccount ? "self" : role,
      ...(screenshot === undefined ? {} : { screenshot }),
      ...(victimBrowserDiagnostic === undefined
        ? {}
        : { victimBrowserDiagnostic }),
      ...(dialog === undefined ? {} : { dialog }),
    };
  } catch (error) {
    return {
      status: "unavailable",
      phase: "victim-page",
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
