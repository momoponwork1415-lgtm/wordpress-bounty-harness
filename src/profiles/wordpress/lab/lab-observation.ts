import { createHash } from "node:crypto";

import { z } from "zod";

import type { LabReachability } from "../../../lab/index.js";
import { BEACON_LOG } from "./container-startup.js";
import type {
  DockerResult,
  Resources,
  WordPressFileCanary,
  WordPressLab,
  WordPressLabHandle,
  WordPressRoleObservation,
  WordPressScriptContext,
  WordPressStoredScriptFailurePhase,
} from "./index.js";

const REACHABILITY_PROBE = `$http = @file_get_contents("http://wordpress/");
$database = "not-exposed";
$user = getenv("WBH_DB_USER");
if ($user !== false && $user !== "") {
  $link = @mysqli_connect(getenv("WBH_DB_HOST"), $user, getenv("WBH_DB_PASSWORD"), getenv("WBH_DB_NAME"));
  $database = $link !== false && @mysqli_query($link, "SELECT 1") !== false ? "ok" : "failed";
}
echo json_encode(["http" => $http !== false ? "ok" : "failed", "database" => $database]);`;
const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
/** One page visit by the Lab's observer; dialogs are dismissed and never count. */
const BROWSER_VISIT = `const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on("dialog", (dialog) => { void dialog.dismiss(); });
  const base = "http://wordpress";
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
  await page.goto(base + process.env.WBH_VISIT_PATH, { waitUntil: "load" });
  if (new URL(page.url()).origin !== base)
    throw new Error("Victim navigation left the Lab origin");
  const actions = JSON.parse(process.env.WBH_VISIT_ACTIONS ?? "[]");
  for (const action of actions) {
    const target = action.kind === "click-text"
      ? page.getByText(action.text, { exact: action.exact })
      : page.locator(action.selector);
    await target.waitFor({ state: "visible", timeout: 10000 });
    if (await target.count() !== 1)
      throw new Error("Victim action did not identify one visible element");
    await target.click({ timeout: 10000 });
    if (new URL(page.url()).origin !== base)
      throw new Error("Victim action left the Lab origin");
  }
  await page.waitForTimeout(3000);
  const screenshot = await page.screenshot({ type: "png" });
  if (screenshot.length > ${MAX_SCREENSHOT_BYTES})
    throw new Error("Browser screenshot exceeds the evidence limit");
  process.stdout.write(screenshot.toString("base64"));
  await browser.close();
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
]);
const victimVisitSchema = z.union([
  wordpressVisitPathSchema,
  z.strictObject({
    path: wordpressVisitPathSchema,
    actions: z.array(wordpressVictimActionSchema).min(1).max(3),
  }),
]);
export const wordpressVictimRouteSchema = z.strictObject({
  role: z.enum(["administrator", "subscriber", "customer", "unauthenticated"]),
  paths: z.array(victimVisitSchema).min(1).max(5),
});
export type WordPressVictimRoute = z.infer<typeof wordpressVictimRouteSchema>;

type RunDocker = (
  args: readonly string[],
  timeoutMs?: number,
  maxOutputBytes?: number,
) => Promise<DockerResult>;
type WordPressCommand = (
  resource: Resources,
  args: readonly string[],
  environment?: readonly string[],
) => Promise<DockerResult>;

type ObservationMethods = Pick<
  WordPressLab,
  | "markCapture"
  | "readCapture"
  | "probe"
  | "canaryLedger"
  | "prepareExecutionCanary"
  | "observeSessionUser"
  | "observeCanaryTable"
  | "observeCanaryFiles"
  | "prepareScriptCanary"
  | "observeStoredScript"
  | "observeOptions"
  | "observeAccountRoles"
  | "observeExecution"
>;

async function readBeaconCount(
  resource: Resources,
  issued: ReadonlySet<string>,
  docker: RunDocker,
): Promise<number> {
  const log = await docker(
    ["exec", resource.receiver, "cat", BEACON_LOG],
    10_000,
  );
  if (log.exitCode === 1 && log.stdout === "") return 0;
  if (log.exitCode !== 0) throw new Error("Beacon log unreadable");
  return log.stdout.split("\n").filter((line) => issued.has(line)).length;
}

async function visitStoredScriptPage(input: {
  readonly resource: Resources;
  readonly handle: WordPressLabHandle;
  readonly receiverIp: string;
  readonly issued: ReadonlySet<string>;
  readonly path: string;
  readonly role: WordPressVictimRoute["role"];
  readonly actions?: readonly z.infer<typeof wordpressVictimActionSchema>[];
  readonly browserImage: string;
  readonly docker: RunDocker;
}): Promise<{ readonly fired: boolean; readonly screenshot: Buffer }> {
  const {
    resource,
    handle,
    receiverIp,
    issued,
    path,
    role,
    actions,
    browserImage,
    docker,
  } = input;
  const account =
    role === "administrator"
      ? { username: "harness-admin", password: resource.adminPassword }
      : role === "unauthenticated"
        ? undefined
        : resource.victimAccounts[role];
  if (role !== "unauthenticated" && account === undefined)
    throw new Error("Victim role is unavailable");
  const before = await readBeaconCount(resource, issued, docker);
  const result = await docker(
    [
      "run",
      "--rm",
      "--runtime=runsc",
      "--network",
      resource.network,
      `--add-host=wordpress:${handle.internalIp}`,
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
      "--entrypoint=node",
      browserImage,
      "-e",
      BROWSER_VISIT,
    ],
    120_000,
    Math.ceil(MAX_SCREENSHOT_BYTES / 3) * 4 + 1024,
  );
  if (result.exitCode !== 0) throw new Error("Browser visit failed");
  const encoded = result.stdout.trim();
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
    fired: (await readBeaconCount(resource, issued, docker)) > before,
    screenshot,
  };
}

type ObservationRuntime = {
  readonly active: Map<string, Resources>;
  readonly docker: RunDocker;
  readonly wp: WordPressCommand;
  readonly roles: (
    resource: Resources,
    username: string,
  ) => Promise<WordPressRoleObservation>;
  readonly optionDigest: (resource: Resources, name: string) => Promise<string>;
  readonly nonce: () => string;
  readonly images: { readonly wordpress: string; readonly browser: string };
};

function createCaptureObservations(
  runtime: ObservationRuntime,
): Pick<ObservationMethods, "markCapture" | "readCapture"> {
  const { active, docker } = runtime;
  return {
    async markCapture(handle) {
      const resource = active.get(handle.id);
      if (resource?.handle !== handle) return null;
      const result = await docker([
        "exec",
        resource.recorder,
        "wc",
        "-c",
        "/var/lib/wbh/capture.jsonl",
      ]);
      const marker = result.stdout.trim().split(/\s+/)[0];
      return result.exitCode === 0 &&
        marker !== undefined &&
        /^\d+$/.test(marker)
        ? marker
        : null;
    },
    async readCapture(handle, sinceMarker) {
      const resource = active.get(handle.id);
      if (
        resource?.handle !== handle ||
        !/^\d+$/.test(sinceMarker) ||
        !Number.isSafeInteger(Number(sinceMarker)) ||
        Number(sinceMarker) > 64 * 1024 * 1024
      )
        return { status: "unavailable" };
      const [capture, dropped] = await Promise.all([
        docker(
          [
            "exec",
            resource.recorder,
            "tail",
            "-c",
            `+${Number(sinceMarker) + 1}`,
            "/var/lib/wbh/capture.jsonl",
          ],
          60_000,
          64 * 1024 * 1024 + 1024,
        ),
        docker([
          "exec",
          resource.recorder,
          "sh",
          "-c",
          "cat /var/lib/wbh/dropped 2>/dev/null || printf 0",
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
        bytes: Buffer.from(capture.stdout, "utf8"),
        dropped: count,
      };
    },
  };
}

function createProbeObservation(
  runtime: ObservationRuntime,
): Pick<ObservationMethods, "probe"> {
  const { active, docker } = runtime;
  const options = { images: runtime.images };
  return {
    async probe(handle) {
      const resource = active.get(handle.id);
      const database = handle.database;
      const failed = (): LabReachability => ({
        http: "failed",
        database: database === undefined ? "not-exposed" : "failed",
      });
      if (resource?.handle !== handle) return failed();
      try {
        const result = await docker(
          [
            "run",
            "--rm",
            "--runtime=runsc",
            "--network",
            resource.network,
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
            options.images.wordpress,
            "-r",
            REACHABILITY_PROBE,
          ],
          60_000,
        );
        if (result.exitCode !== 0) return failed();
        const parsed = z
          .strictObject({
            http: z.enum(["ok", "failed"]),
            database: z.enum(["ok", "failed", "not-exposed"]),
          })
          .safeParse(JSON.parse(result.stdout.trim()) as unknown);
        return parsed.success ? parsed.data : failed();
      } catch {
        return failed();
      }
    },
  };
}

function createCanarySetupObservations(
  runtime: ObservationRuntime,
): Pick<
  ObservationMethods,
  "canaryLedger" | "prepareExecutionCanary" | "observeSessionUser"
> {
  const { active, nonce, wp } = runtime;
  return {
    canaryLedger(handle) {
      const resource = active.get(handle.id);
      return resource?.handle === handle ? (resource.canaries ?? null) : null;
    },
    prepareExecutionCanary(handle) {
      const resource = active.get(handle.id);
      if (resource?.handle !== handle) return null;
      const token = nonce();
      if (!/^[A-Za-z0-9-]{1,100}$/.test(token)) return null;
      resource.executionNonces.add(token);
      const path = `/tmp/wbh-execution-${token}`;
      return {
        nonce: token,
        php: `<?php file_put_contents('${path}', hash('sha256', '${token}' . getenv('WBH_EXECUTION_SALT'))); ?>`,
      };
    },
    async observeSessionUser(handle, cookie, scheme = "logged_in") {
      const resource = active.get(handle.id);
      if (resource?.handle !== handle) return { status: "unavailable" };
      // The value travels as an environment variable, never as PHP source.
      if (!/^[A-Za-z0-9%|._@+-]{1,4096}$/.test(cookie))
        return { status: "none" };
      try {
        const result = await wp(
          resource,
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
    },
  };
}

function createCanaryInspectionObservations(
  runtime: ObservationRuntime,
): Pick<
  ObservationMethods,
  "observeCanaryTable" | "observeCanaryFiles" | "prepareScriptCanary"
> {
  const { active, wp, docker, nonce } = runtime;
  return {
    async observeCanaryTable(handle) {
      const resource = active.get(handle.id);
      const canary = resource?.canaries?.sqlCanary;
      if (resource?.handle !== handle || canary === undefined)
        return { status: "unavailable" };
      try {
        const present = await wp(resource, [
          "db",
          "query",
          `SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = '${canary.table}'`,
          "--skip-column-names",
        ]);
        if (present.stdout.trim() === "0") return { status: "changed" };
        const rows = await wp(resource, [
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
    },
    async observeCanaryFiles(handle) {
      const resource = active.get(handle.id);
      const files = resource?.canaries?.fileCanaries;
      if (resource?.handle !== handle || files === undefined)
        return { status: "unavailable" };
      const deleted: WordPressFileCanary["kind"][] = [];
      for (const file of files) {
        const result = await docker(
          ["exec", resource.wordpress, "test", "-e", file.path],
          10_000,
        );
        if (result.exitCode === 1) deleted.push(file.kind);
        else if (result.exitCode !== 0) return { status: "unavailable" };
      }
      return { status: "observed", deleted };
    },
    prepareScriptCanary(handle) {
      const resource = active.get(handle.id);
      if (resource?.handle !== handle) return null;
      const token = nonce();
      if (!/^[A-Za-z0-9-]{1,100}$/.test(token)) return null;
      resource.scriptNonces.add(token);
      const beaconUrl = `http://canary:8080/b/${token}`;
      return {
        nonce: token,
        beaconUrl,
        javascript: `fetch(${JSON.stringify(beaconUrl)}, { method: "POST", headers: { "X-WBH-Script-Canary": ${JSON.stringify(token)} } });`,
        loaderJavascript: `import("//canary:8080/c/${token}")`,
      };
    },
  };
}

function createStoredScriptObservation(
  runtime: ObservationRuntime,
): Pick<ObservationMethods, "observeStoredScript"> {
  const { active, docker } = runtime;
  const options = { images: runtime.images };
  return {
    async observeStoredScript(handle, input) {
      const resource = active.get(handle.id);
      const receiverIp = resource?.receiverIp;
      if (resource?.handle !== handle || receiverIp === undefined)
        return { status: "unavailable", phase: "lab" };
      if (resource.scriptNonces.size === 0) return { status: "not-prepared" };
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
      const issued = new Set(
        [...resource.scriptNonces].map((token) => `/b/${token}`),
      );
      const visit = (
        path: string,
        role: WordPressVictimRoute["role"],
        actions?: readonly z.infer<typeof wordpressVictimActionSchema>[],
      ) =>
        visitStoredScriptPage({
          resource,
          handle,
          receiverIp,
          issued,
          path,
          role,
          ...(actions === undefined ? {} : { actions }),
          browserImage: options.images.browser,
          docker,
        });
      let phase: WordPressStoredScriptFailurePhase = "front";
      try {
        const contexts: WordPressScriptContext[] = [];
        let screenshot: Buffer | undefined;
        const fired = async (
          path: string,
          role: WordPressVictimRoute["role"],
          actions?: readonly z.infer<typeof wordpressVictimActionSchema>[],
        ): Promise<boolean> => {
          const observation = await visit(path, role, actions);
          if (observation.fired) screenshot ??= observation.screenshot;
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
            const actions =
              typeof visit === "string" ? undefined : visit.actions;
            if (await fired(path, victim.data.role, actions)) victimPage = true;
          }
        }
        if (victimPage) contexts.push("victim-route-page");
        const victimRole =
          victim?.success && victimPage ? victim.data.role : undefined;
        const sameAccount =
          (victimRole === "subscriber" || victimRole === "customer") &&
          resource.victimAccounts[victimRole]?.username ===
            handle.attackerAccounts[victimRole]?.username;
        return {
          status: "observed",
          contexts,
          ...(victimRole === undefined
            ? {}
            : { victimRole: sameAccount ? ("self" as const) : victimRole }),
          ...(screenshot === undefined ? {} : { screenshot }),
        };
      } catch {
        return { status: "unavailable", phase };
      }
    },
  };
}

function createFinalObservations(
  runtime: ObservationRuntime,
): Pick<
  ObservationMethods,
  "observeOptions" | "observeAccountRoles" | "observeExecution"
> {
  const { active, optionDigest, roles, docker } = runtime;
  return {
    async observeOptions(handle) {
      const resource = active.get(handle.id);
      const baseline = resource?.optionBaseline;
      if (resource?.handle !== handle || baseline === undefined)
        return { status: "unavailable" };
      try {
        const changed: string[] = [];
        for (const [name, digest] of baseline)
          if ((await optionDigest(resource, name)) !== digest)
            changed.push(name);
        return { status: "observed", changed };
      } catch {
        return { status: "unavailable" };
      }
    },
    async observeAccountRoles(handle, username) {
      const resource = active.get(handle.id);
      return resource?.handle === handle
        ? roles(resource, username)
        : { status: "unavailable" };
    },
    async observeExecution(handle) {
      const resource = active.get(handle.id);
      if (resource?.handle !== handle) return { status: "unavailable" };
      if (resource.executionNonces.size === 0)
        return { status: "not-prepared" };
      try {
        for (const token of resource.executionNonces) {
          const marker = await docker(
            ["exec", resource.wordpress, "cat", `/tmp/wbh-execution-${token}`],
            10_000,
          );
          const expected = createHash("sha256")
            .update(`${token}${resource.executionSalt}`)
            .digest("hex");
          if (marker.exitCode !== 0 || marker.stdout.trim() !== expected)
            continue;
          const found = await docker(
            [
              "exec",
              resource.wordpress,
              "grep",
              "-rlF",
              "--",
              token,
              "/var/www/html",
            ],
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
    },
  };
}

/** The Lab observer keeps the same method contracts across the smaller groups. */
export function createWordPressLabObservations(
  runtime: ObservationRuntime,
): ObservationMethods {
  return {
    ...createCaptureObservations(runtime),
    ...createProbeObservation(runtime),
    ...createCanarySetupObservations(runtime),
    ...createCanaryInspectionObservations(runtime),
    ...createStoredScriptObservation(runtime),
    ...createFinalObservations(runtime),
  };
}
