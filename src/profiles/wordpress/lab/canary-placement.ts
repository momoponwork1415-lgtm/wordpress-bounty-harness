import { randomBytes, randomUUID } from "node:crypto";

import { canonicalDigest } from "../../../infrastructure/canonical-json.js";
import type {
  DockerResult,
  Resources,
  WordPressCanaryLedger,
  WordPressFileCanary,
  WordPressLabHandle,
  WordPressRoleObservation,
} from "./index.js";
import { translatePressCanaryAdministratorLocaleScript } from "./scenarios.js";

export const SQL_CANARY_TABLE = "wbh_canary";
/** Options whose change alone is a security impact; anything else is not observed. */
export const CRITICAL_OPTIONS = [
  "users_can_register",
  "default_role",
  "siteurl",
  "home",
  "admin_email",
  "active_plugins",
  "wp_user_roles",
];

function watchedOptions(canaries: WordPressCanaryLedger): readonly string[] {
  return [canaries.option, ...CRITICAL_OPTIONS];
}

type WordPressCommand = (
  resource: Resources,
  args: readonly string[],
  environment?: readonly string[],
) => Promise<DockerResult>;
type RequireDocker = (
  args: readonly string[],
  timeoutMs?: number,
) => Promise<DockerResult>;

export async function placeVerificationCanaries(
  resource: Resources,
  wp: WordPressCommand,
): Promise<void> {
  const privateValue = `wbh-sensitive-${randomBytes(24).toString("hex")}`;
  const privatePost = (
    await wp(resource, [
      "post",
      "create",
      "--post_status=private",
      "--post_type=post",
      "--post_title=Harness private note",
      `--post_content=${privateValue}`,
      "--porcelain",
    ])
  ).stdout.trim();
  const personalValue = `wbh-sensitive-${randomBytes(24).toString("hex")}`;
  const ownerId = (
    await wp(resource, [
      "user",
      "create",
      `wbh-private-owner-${resource.id.slice(0, 8)}`,
      `wbh-private-owner-${resource.id.slice(0, 8)}@example.invalid`,
      "--role=subscriber",
      `--user_pass=${randomUUID()}`,
      "--porcelain",
    ])
  ).stdout.trim();
  if (!/^[1-9][0-9]*$/.test(privatePost) || !/^[1-9][0-9]*$/.test(ownerId))
    throw new Error("Sensitive canary object ID unavailable");
  await wp(resource, [
    "user",
    "meta",
    "add",
    ownerId,
    "wbh_private_note",
    personalValue,
  ]);
  resource.sensitiveCanaries.push(
    { kind: "private-post", objectId: privatePost, value: privateValue },
    { kind: "other-user-meta", objectId: ownerId, value: personalValue },
  );
}

export interface CanaryPlacement {
  readonly resource: Resources;
  readonly handle: WordPressLabHandle;
  readonly nonce: () => string;
  readonly wp: WordPressCommand;
  readonly requireDocker: RequireDocker;
  readonly roles: (
    resource: Resources,
    username: string,
  ) => Promise<WordPressRoleObservation>;
  readonly optionDigest: (resource: Resources, name: string) => Promise<string>;
}

async function placeBasicCanaries(input: CanaryPlacement): Promise<{
  readonly token: string;
  readonly postId: string;
  readonly adminUser: string;
}> {
  const { resource, wp, requireDocker } = input;
  const token = input.nonce();
  if (!/^[A-Za-z0-9-]{1,100}$/.test(token)) throw new Error("Invalid nonce");
  await wp(resource, ["option", "add", `wbh_canary_${token}`, token]);
  const post = await wp(resource, [
    "post",
    "create",
    "--post_status=publish",
    `--post_title=wbh-canary-${token}`,
    "--porcelain",
  ]);
  const postId = post.stdout.trim();
  if (!/^\d+$/.test(postId)) throw new Error("Canary post missing");
  await wp(resource, [
    "post",
    "meta",
    "add",
    postId,
    `wbh_canary_${token}`,
    token,
  ]);
  await requireDocker([
    "exec",
    resource.wordpress,
    "sh",
    "-c",
    `printf %s '${token}' > /var/www/html/wp-content/wbh-canary-${token}.txt`,
  ]);
  await wp(resource, [
    "user",
    "create",
    `wbh-canary-${token}`,
    `wbh-canary-${token}@example.invalid`,
    "--role=subscriber",
    `--user_pass=${randomUUID()}`,
  ]);
  const adminUser = `wbh-canary-admin-${token}`;
  await wp(resource, [
    "user",
    "create",
    adminUser,
    `${adminUser}@example.invalid`,
    "--role=administrator",
    `--user_pass=${randomUUID()}`,
  ]);
  if (resource.administratorSecondaryLocale !== undefined)
    await wp(resource, [
      "eval",
      translatePressCanaryAdministratorLocaleScript(
        adminUser,
        resource.administratorSecondaryLocale,
      ),
    ]);
  return { token, postId, adminUser };
}

async function placeSqlAndFileCanaries(input: CanaryPlacement): Promise<{
  readonly sqlCanary: { readonly table: string; readonly value: string };
  readonly fileCanaries: readonly WordPressFileCanary[];
}> {
  const { resource, wp, requireDocker } = input;
  const sqlCanary = {
    table: SQL_CANARY_TABLE,
    value: randomBytes(16).toString("hex"),
  };
  await wp(resource, [
    "db",
    "query",
    `CREATE TABLE ${sqlCanary.table} (id INT PRIMARY KEY, value CHAR(32) NOT NULL); INSERT INTO ${sqlCanary.table} VALUES (1, '${sqlCanary.value}')`,
  ]);
  const fileCanaries: WordPressFileCanary[] = [
    {
      kind: "outside-webroot",
      path: "/etc/wbh-canary",
      value: randomBytes(16).toString("hex"),
    },
    {
      kind: "php-source",
      path: "/var/www/html/wbh-canary.php",
      value: randomBytes(16).toString("hex"),
    },
  ];
  for (const file of fileCanaries)
    await requireDocker([
      "exec",
      resource.wordpress,
      "sh",
      "-c",
      // Served over HTTP the PHP canary runs and prints nothing; only its source holds the value.
      `printf %s '${file.kind === "php-source" ? `<?php /* ${file.value} */` : file.value}' > ${file.path}`,
    ]);
  return { sqlCanary, fileCanaries };
}

async function captureRoleBaseline(
  input: CanaryPlacement,
): Promise<Record<string, readonly string[]>> {
  const { resource, handle, roles } = input;
  const roleBaseline: Record<string, readonly string[]> = {};
  for (const account of Object.values(handle.attackerAccounts)) {
    const observed = await roles(resource, account.username);
    if (observed.status !== "roles")
      throw new Error("Role baseline unavailable");
    roleBaseline[account.username] = observed.roles;
  }
  return roleBaseline;
}

async function captureOptionBaseline(
  input: CanaryPlacement,
  canaries: WordPressCanaryLedger,
): Promise<ReadonlyMap<string, string>> {
  const { resource, optionDigest } = input;
  const optionBaseline = new Map<string, string>();
  for (const name of watchedOptions(canaries))
    optionBaseline.set(name, await optionDigest(resource, name));
  return optionBaseline;
}

/** Placement happens after discovery is over; values stay in the Lab and Private Evidence. */
export async function seedWordPressCanaries(
  input: CanaryPlacement,
): Promise<string> {
  const { resource } = input;
  const { token, postId, adminUser } = await placeBasicCanaries(input);
  const { sqlCanary, fileCanaries } = await placeSqlAndFileCanaries(input);
  const roleBaseline = await captureRoleBaseline(input);
  resource.canaries = {
    nonce: token,
    adminUser,
    roleBaseline,
    sqlCanary,
    fileCanaries,
    sensitiveCanaries: resource.sensitiveCanaries,
    option: `wbh_canary_${token}`,
    postId,
    postMeta: `wbh_canary_${token}`,
    file: `/var/www/html/wp-content/wbh-canary-${token}.txt`,
    user: `wbh-canary-${token}`,
  };
  resource.optionBaseline = await captureOptionBaseline(
    input,
    resource.canaries,
  );
  return canonicalDigest(resource.canaries);
}
