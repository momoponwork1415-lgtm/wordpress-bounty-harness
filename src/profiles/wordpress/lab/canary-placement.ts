import { randomBytes, randomUUID } from "node:crypto";

import { canonicalDigest } from "../../../infrastructure/canonical-json.js";
import type { WordPressCanaryLedger, WordPressFileCanary } from "./contract.js";
import type { WordPressLabSession } from "./lab-session.js";
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

export async function placeVerificationCanaries(
  lab: WordPressLabSession,
): Promise<void> {
  const privateValue = `wbh-sensitive-${randomBytes(24).toString("hex")}`;
  const privatePost = (
    await lab.wp([
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
    await lab.wp([
      "user",
      "create",
      `wbh-private-owner-${lab.id.slice(0, 8)}`,
      `wbh-private-owner-${lab.id.slice(0, 8)}@example.invalid`,
      "--role=subscriber",
      `--user_pass=${randomUUID()}`,
      "--porcelain",
    ])
  ).stdout.trim();
  if (!/^[1-9][0-9]*$/.test(privatePost) || !/^[1-9][0-9]*$/.test(ownerId))
    throw new Error("Sensitive canary object ID unavailable");
  await lab.wp([
    "user",
    "meta",
    "add",
    ownerId,
    "wbh_private_note",
    personalValue,
  ]);
  lab.sensitiveCanaries.push(
    { kind: "private-post", objectId: privatePost, value: privateValue },
    { kind: "other-user-meta", objectId: ownerId, value: personalValue },
  );
}

async function placeBasicCanaries(lab: WordPressLabSession): Promise<{
  readonly token: string;
  readonly postId: string;
  readonly adminUser: string;
}> {
  const token = lab.nonce();
  if (!/^[A-Za-z0-9-]{1,100}$/.test(token)) throw new Error("Invalid nonce");
  await lab.wp(["option", "add", `wbh_canary_${token}`, token]);
  const post = await lab.wp([
    "post",
    "create",
    "--post_status=publish",
    `--post_title=wbh-canary-${token}`,
    "--porcelain",
  ]);
  const postId = post.stdout.trim();
  if (!/^\d+$/.test(postId)) throw new Error("Canary post missing");
  await lab.wp(["post", "meta", "add", postId, `wbh_canary_${token}`, token]);
  await lab.requireDocker([
    "exec",
    lab.wordpress,
    "sh",
    "-c",
    `printf %s '${token}' > /var/www/html/wp-content/wbh-canary-${token}.txt`,
  ]);
  await lab.wp([
    "user",
    "create",
    `wbh-canary-${token}`,
    `wbh-canary-${token}@example.invalid`,
    "--role=subscriber",
    `--user_pass=${randomUUID()}`,
  ]);
  const adminUser = `wbh-canary-admin-${token}`;
  await lab.wp([
    "user",
    "create",
    adminUser,
    `${adminUser}@example.invalid`,
    "--role=administrator",
    `--user_pass=${randomUUID()}`,
  ]);
  if (lab.administratorSecondaryLocale !== undefined)
    await lab.wp([
      "eval",
      translatePressCanaryAdministratorLocaleScript(
        adminUser,
        lab.administratorSecondaryLocale,
      ),
    ]);
  return { token, postId, adminUser };
}

async function placeSqlAndFileCanaries(lab: WordPressLabSession): Promise<{
  readonly sqlCanary: { readonly table: string; readonly value: string };
  readonly fileCanaries: readonly WordPressFileCanary[];
}> {
  const sqlCanary = {
    table: SQL_CANARY_TABLE,
    value: randomBytes(16).toString("hex"),
  };
  await lab.wp([
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
    await lab.requireDocker([
      "exec",
      lab.wordpress,
      "sh",
      "-c",
      // Served over HTTP the PHP canary runs and prints nothing; only its source holds the value.
      `printf %s '${file.kind === "php-source" ? `<?php /* ${file.value} */` : file.value}' > ${file.path}`,
    ]);
  return { sqlCanary, fileCanaries };
}

async function captureRoleBaseline(
  lab: WordPressLabSession,
): Promise<Record<string, readonly string[]>> {
  const roleBaseline: Record<string, readonly string[]> = {};
  for (const account of Object.values(lab.handle.attackerAccounts)) {
    const observed = await lab.roles(account.username);
    if (observed.status !== "roles")
      throw new Error("Role baseline unavailable");
    roleBaseline[account.username] = observed.roles;
  }
  return roleBaseline;
}

async function captureOptionBaseline(
  lab: WordPressLabSession,
  canaries: WordPressCanaryLedger,
): Promise<ReadonlyMap<string, string>> {
  const optionBaseline = new Map<string, string>();
  for (const name of watchedOptions(canaries))
    optionBaseline.set(name, await lab.optionDigest(name));
  return optionBaseline;
}

/** Placement happens after discovery is over; values stay in the Lab and Private Evidence. */
export async function seedWordPressCanaries(
  lab: WordPressLabSession,
): Promise<string> {
  const { token, postId, adminUser } = await placeBasicCanaries(lab);
  const { sqlCanary, fileCanaries } = await placeSqlAndFileCanaries(lab);
  const roleBaseline = await captureRoleBaseline(lab);
  lab.canaries = {
    nonce: token,
    adminUser,
    roleBaseline,
    sqlCanary,
    fileCanaries,
    sensitiveCanaries: lab.sensitiveCanaries,
    option: `wbh_canary_${token}`,
    postId,
    postMeta: `wbh_canary_${token}`,
    file: `/var/www/html/wp-content/wbh-canary-${token}.txt`,
    user: `wbh-canary-${token}`,
  };
  lab.optionBaseline = await captureOptionBaseline(lab, lab.canaries);
  return canonicalDigest(lab.canaries);
}

/** Destroys each principal's sessions and application passwords, then sets a fresh password. */
const REVOKE_PRINCIPALS_SCRIPT = `$principals = json_decode((string) getenv("WBH_SETUP_PRINCIPALS"), true); if (!is_array($principals)) exit(1); foreach ($principals as [$login, $password]) { $user = get_user_by("login", $login); if (!$user) exit(2); WP_Session_Tokens::get_instance($user->ID)->destroy_all(); if (class_exists("WP_Application_Passwords")) WP_Application_Passwords::delete_all_application_passwords($user->ID); wp_set_password($password, $user->ID); if (WP_Session_Tokens::get_instance($user->ID)->get_all()) exit(3); }`;

/**
 * Ends handoff precondition setup (#430, ADR 0035). The setup administrator
 * and the canary principals keep no session, application password or known
 * password, so nothing signed in before `setup-done` authenticates after it;
 * the role and option baselines start from the post-setup state.
 */
export async function closeWordPressSetup(
  lab: WordPressLabSession,
): Promise<void> {
  const canaries = lab.canaries;
  if (canaries === undefined) throw new Error("Canaries are not seeded");
  const administratorPassword = randomUUID();
  // Passwords travel as an environment variable, never as PHP source.
  await lab.wp(
    ["eval", REVOKE_PRINCIPALS_SCRIPT],
    [
      `WBH_SETUP_PRINCIPALS=${JSON.stringify([
        ["harness-admin", administratorPassword],
        [canaries.adminUser, randomUUID()],
        [canaries.user, randomUUID()],
      ])}`,
    ],
  );
  lab.adminPassword = administratorPassword;
  lab.canaries = { ...canaries, roleBaseline: await captureRoleBaseline(lab) };
  lab.optionBaseline = await captureOptionBaseline(lab, canaries);
}
