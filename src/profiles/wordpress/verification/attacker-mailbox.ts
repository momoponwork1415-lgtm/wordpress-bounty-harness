import type {
  LabMailAddress,
  LabMailMessage,
  LabMailSummary,
} from "../lab/index.js";

/**
 * ADR 0026 追記 (#805): the attacker side of a handoff reads only mail it
 * would receive on a real site. A message counts as the attacker's when one
 * of its recipients (To, Cc or the envelope's Bcc) is
 *
 * - the Lab's attacker account address, for a logged-in position, or
 * - any address at `ATTACKER_MAIL_DOMAIN`, which no Lab account uses: an
 *   attacker in any position enters such an address into a form (a
 *   subscription, a guest order) and reads what the site sends there.
 *
 * The Harness filters here, never the operator; the other recipients' mail
 * stays with the Lab and with a person in a review Lab.
 */
export const ATTACKER_MAIL_DOMAIN = "attacker.invalid";

export type AttackerMailRecipients = {
  /** The attacker account's own address; empty for an unauthenticated position. */
  readonly addresses: readonly string[];
  /** Every address at this domain is the attacker's. */
  readonly domain: typeof ATTACKER_MAIL_DOMAIN;
};

/** One message as the attacker side receives it: no other Bcc recipient, no raw source. */
export type AttackerMailMessage = {
  readonly id: string;
  readonly receivedAt: string;
  readonly from: LabMailAddress | null;
  readonly to: readonly LabMailAddress[];
  readonly cc: readonly LabMailAddress[];
  /** Only the attacker's own addresses among the envelope's Bcc recipients. */
  readonly bcc: readonly LabMailAddress[];
  readonly replyTo: readonly LabMailAddress[];
  readonly subject: string;
  readonly text: string;
  readonly html: string;
};

const normalized = (address: string) => address.trim().toLowerCase();

export function attackerMailRecipients(
  accountAddress?: string,
): AttackerMailRecipients {
  return {
    addresses: accountAddress === undefined ? [] : [normalized(accountAddress)],
    domain: ATTACKER_MAIL_DOMAIN,
  };
}

/** True only for the attacker's own address or one at the attacker domain. */
export function isAttackerAddress(
  recipients: AttackerMailRecipients,
  address: string,
): boolean {
  const value = normalized(address);
  const at = value.lastIndexOf("@");
  if (at <= 0 || at !== value.indexOf("@")) return false;
  return (
    recipients.addresses.includes(value) ||
    value.slice(at + 1) === recipients.domain
  );
}

type Recipients = Pick<LabMailSummary, "To" | "Cc" | "Bcc">;

/** For `readMail`: read in full only the summaries one of whose recipients is the attacker's. */
export function addressedToAttacker(
  recipients: AttackerMailRecipients,
): (summary: Recipients) => boolean {
  return (summary) =>
    [...summary.To, ...summary.Cc, ...summary.Bcc].some((entry) =>
      isAttackerAddress(recipients, entry.address),
    );
}

/**
 * The attacker's mailbox: messages addressed to the attacker, oldest first,
 * each without the Bcc recipients that are not the attacker's.
 */
export function attackerMailbox(
  messages: readonly LabMailMessage[],
  recipients: AttackerMailRecipients,
): AttackerMailMessage[] {
  const mine = (entry: LabMailAddress) =>
    isAttackerAddress(recipients, entry.address);
  return messages
    .filter((message) =>
      [...message.to, ...message.cc, ...message.bcc].some(mine),
    )
    .map((message) => ({
      id: message.id,
      receivedAt: message.receivedAt,
      from: message.from,
      to: message.to,
      cc: message.cc,
      bcc: message.bcc.filter(mine),
      replyTo: message.replyTo,
      subject: message.subject,
      text: message.text,
      html: message.html,
    }))
    .sort((a, b) =>
      a.receivedAt === b.receivedAt
        ? a.id.localeCompare(b.id)
        : a.receivedAt.localeCompare(b.receivedAt),
    );
}
