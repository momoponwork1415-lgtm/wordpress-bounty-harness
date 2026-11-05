import { z } from "zod";

import type { WordPressLabSession } from "./lab-session.js";

/**
 * ADR 0026 追記 (#805): a verification Lab's own mail sink. WordPress sends
 * every `wp_mail()` over SMTP to a Mailpit container on the Lab's internal
 * network; nothing leaves the Lab. Only the Harness reads what it caught,
 * through `docker exec` into that container, and decides who sees which
 * message: the attacker side gets only its own (verification), a person in a
 * review Lab gets all of it.
 */

/** The name WordPress and WP-CLI resolve to the mail container's Lab address. */
export const LAB_MAIL_HOST = "mailpit";
const SMTP_PORT = 1025;
const API = "http://127.0.0.1:8025/api/v1";
/** The web UI and API port a review Lab publishes on host loopback. */
export const LAB_MAIL_UI_PORT = 8025;
/** Mailpit drops the oldest beyond this; a Lab sends far fewer. */
const MAX_STORED_MESSAGES = 500;
/** The most messages one read returns, newest first. */
const MAX_READ_MESSAGES = 200;
const MAX_BODY_CHARACTERS = 256 * 1024;
const LAB_MAIL_PLUGIN_PATH =
  "/var/www/html/wp-content/mu-plugins/wbh-lab-mail.php";

/**
 * The must-use plugin the Lab places before the Snapshot's plugins. The
 * default sender `wordpress@wordpress` fails WordPress's own address check
 * (the Lab's host name has no dot), so only that value is replaced; a sender
 * a plugin sets stays.
 */
const LAB_MAIL_PLUGIN = `<?php
/**
 * Harness-owned (ADR 0026, #805): every wp_mail() goes to the Lab's internal
 * mail capture over SMTP. Nothing leaves the Lab.
 */
add_filter('wp_mail_from', static function ($from) {
	return $from === 'wordpress@wordpress' ? 'wordpress@wordpress.invalid' : $from;
}, PHP_INT_MAX);
add_action('phpmailer_init', static function ($phpmailer) {
	$phpmailer->isSMTP();
	$phpmailer->Host = '${LAB_MAIL_HOST}';
	$phpmailer->Port = ${SMTP_PORT};
	$phpmailer->SMTPAuth = false;
	$phpmailer->SMTPSecure = '';
	$phpmailer->SMTPAutoTLS = false;
}, PHP_INT_MAX);
`;

export type LabMailAddress = {
  readonly name: string;
  readonly address: string;
};

/** One message as the Lab caught it; the Harness never forwards the raw source. */
export type LabMailMessage = {
  readonly id: string;
  readonly receivedAt: string;
  readonly from: LabMailAddress | null;
  readonly to: readonly LabMailAddress[];
  readonly cc: readonly LabMailAddress[];
  /** Envelope recipients not named in To or Cc. */
  readonly bcc: readonly LabMailAddress[];
  readonly replyTo: readonly LabMailAddress[];
  readonly subject: string;
  readonly text: string;
  readonly html: string;
};

export type LabMailRead =
  | {
      readonly status: "captured";
      readonly messages: readonly LabMailMessage[];
    }
  /** The Lab has no mail capture (no `images.mail`, or an exploration Lab). */
  | { readonly status: "absent" }
  | { readonly status: "unavailable" };

const addressSchema = z
  .looseObject({ Name: z.string().catch(""), Address: z.string() })
  .transform(({ Name, Address }) => ({ name: Name, address: Address }));
const addressList = z
  .array(addressSchema)
  .nullish()
  .transform((list) => list ?? []);
const summarySchema = z.looseObject({
  ID: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  Created: z.string(),
  To: addressList,
  Cc: addressList,
  Bcc: addressList,
});
const listSchema = z.looseObject({ messages: z.array(summarySchema) });
const detailSchema = z.looseObject({
  ID: z.string(),
  From: addressSchema.nullish(),
  To: addressList,
  Cc: addressList,
  Bcc: addressList,
  ReplyTo: addressList,
  Subject: z.string().catch(""),
  Text: z.string().catch(""),
  HTML: z.string().catch(""),
});
export type LabMailSummary = z.infer<typeof summarySchema>;

/** Docker arguments of the mail container; started before WordPress so WordPress can name it. */
export function mailContainerArgs(
  lab: Pick<WordPressLabSession, "mail" | "network">,
  image: string,
): readonly string[] {
  return [
    "run",
    "--detach",
    "--name",
    lab.mail,
    "--runtime=runsc",
    // The Lab's internal network only: no route out, no port on the host.
    "--network",
    lab.network,
    "--network-alias",
    LAB_MAIL_HOST,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--user=65534:65534",
    "--tmpfs=/data:rw,nosuid,nodev,size=64m",
    "--env",
    "MP_DATABASE=/data/mailpit.db",
    "--env",
    `MP_MAX_MESSAGES=${MAX_STORED_MESSAGES}`,
    // The UI would otherwise ask GitHub for releases, and load remote assets a message names.
    "--env",
    "MP_DISABLE_VERSION_CHECK=true",
    "--env",
    "MP_BLOCK_REMOTE_CSS_AND_FONTS=true",
    image,
  ];
}

/** Places the must-use plugin; the file travels as an environment variable, never as shell source. */
export async function installLabMailPlugin(
  lab: Pick<WordPressLabSession, "wordpress" | "requireDocker">,
): Promise<void> {
  await lab.requireDocker([
    "exec",
    "--user=root",
    "--env",
    `WBH_LAB_MAIL_PLUGIN=${LAB_MAIL_PLUGIN}`,
    lab.wordpress,
    "sh",
    "-c",
    `mkdir -p "$(dirname ${LAB_MAIL_PLUGIN_PATH})" && printf '%s' "$WBH_LAB_MAIL_PLUGIN" > ${LAB_MAIL_PLUGIN_PATH} && chown -R www-data:www-data "$(dirname ${LAB_MAIL_PLUGIN_PATH})"`,
  ]);
}

async function getJson(
  lab: Pick<WordPressLabSession, "mail" | "docker">,
  path: string,
): Promise<unknown> {
  const result = await lab.docker(
    ["exec", lab.mail, "wget", "-qO-", `${API}${path}`],
    30_000,
    4 * 1024 * 1024,
  );
  if (result.exitCode !== 0) throw new Error("Lab mail read failed");
  return JSON.parse(result.stdout) as unknown;
}

const clip = (text: string) =>
  text.length <= MAX_BODY_CHARACTERS
    ? text
    : text.slice(0, MAX_BODY_CHARACTERS);

/**
 * Reads what the Lab caught, newest first, at most `MAX_READ_MESSAGES`.
 * `wanted` picks which summaries are read in full (all by default), so a
 * caller that hands mail on reads only what it may hand on. A message never
 * changes, so its full read is kept on the session.
 */
export async function readLabMail(
  lab: Pick<
    WordPressLabSession,
    "mail" | "docker" | "created" | "mailMessages"
  >,
  wanted: (summary: LabMailSummary) => boolean = () => true,
): Promise<LabMailRead> {
  if (!lab.created.has("mail")) return { status: "absent" };
  try {
    const list = listSchema.parse(
      await getJson(lab, `/messages?limit=${MAX_READ_MESSAGES}`),
    );
    const messages: LabMailMessage[] = [];
    for (const summary of list.messages) {
      if (!wanted(summary)) continue;
      let message = lab.mailMessages.get(summary.ID);
      if (message === undefined) {
        const detail = detailSchema.parse(
          await getJson(lab, `/message/${summary.ID}`),
        );
        if (detail.ID !== summary.ID) throw new Error("Lab mail id differs");
        message = {
          id: summary.ID,
          receivedAt: summary.Created,
          from: detail.From ?? null,
          to: detail.To,
          cc: detail.Cc,
          bcc: detail.Bcc,
          replyTo: detail.ReplyTo,
          subject: detail.Subject,
          text: clip(detail.Text),
          html: clip(detail.HTML),
        };
        lab.mailMessages.set(summary.ID, message);
      }
      messages.push(message);
    }
    return { status: "captured", messages };
  } catch {
    return { status: "unavailable" };
  }
}
