import { randomUUID } from "node:crypto";

import type { WordPressLabSession } from "./lab-session.js";

/** Destroys each principal's sessions and application passwords, then sets a fresh password. */
const REVOKE_PRINCIPALS_SCRIPT = `$principals = json_decode((string) getenv("WBH_SETUP_PRINCIPALS"), true); if (!is_array($principals)) exit(1); foreach ($principals as [$login, $password]) { $user = get_user_by("login", $login); if (!$user) exit(2); WP_Session_Tokens::get_instance($user->ID)->destroy_all(); if (class_exists("WP_Application_Passwords")) WP_Application_Passwords::delete_all_application_passwords($user->ID); wp_set_password($password, $user->ID); if (WP_Session_Tokens::get_instance($user->ID)->get_all()) exit(3); }`;

/**
 * Ends handoff precondition setup (#430, ADR 0035). The setup administrator
 * keeps no session, application password or known password, so nothing
 * signed in before `setup-done` authenticates after it. The Lab seeds no
 * canary since #525 (ADR 0040).
 */
export async function closeWordPressSetup(
  lab: WordPressLabSession,
): Promise<void> {
  const administratorPassword = randomUUID();
  // Passwords travel as an environment variable, never as PHP source.
  await lab.wp(
    ["eval", REVOKE_PRINCIPALS_SCRIPT],
    [
      `WBH_SETUP_PRINCIPALS=${JSON.stringify([
        ["harness-admin", administratorPassword],
      ])}`,
    ],
  );
  lab.adminPassword = administratorPassword;
}
