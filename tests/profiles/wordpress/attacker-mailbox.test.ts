import { describe, expect, it } from "vitest";

import type { LabMailMessage } from "../../../src/profiles/wordpress/lab/index.js";
import {
  addressedToAttacker,
  ATTACKER_MAIL_DOMAIN,
  attackerMailbox,
  attackerMailRecipients,
  isAttackerAddress,
} from "../../../src/profiles/wordpress/verification/attacker-mailbox.js";

const address = (value: string) => ({ name: "", address: value });
const message = (
  id: string,
  recipients: {
    readonly to?: readonly string[];
    readonly cc?: readonly string[];
    readonly bcc?: readonly string[];
  },
  receivedAt = "2026-11-03T00:00:00.000Z",
): LabMailMessage => ({
  id,
  receivedAt,
  from: address("wordpress@wordpress.invalid"),
  to: (recipients.to ?? []).map(address),
  cc: (recipients.cc ?? []).map(address),
  bcc: (recipients.bcc ?? []).map(address),
  replyTo: [],
  subject: `subject ${id}`,
  text: `text ${id}`,
  html: "",
});

const subscriber = attackerMailRecipients(
  "wbh-subscriber-1a2b3c4d@example.invalid",
);
const unauthenticated = attackerMailRecipients();

describe("the attacker's mailbox (#805)", () => {
  it("takes the logged-in attacker's own address and any address at the attacker domain", () => {
    expect(subscriber).toEqual({
      addresses: ["wbh-subscriber-1a2b3c4d@example.invalid"],
      domain: ATTACKER_MAIL_DOMAIN,
    });
    expect(unauthenticated).toEqual({
      addresses: [],
      domain: "attacker.invalid",
    });
    for (const own of [
      "wbh-subscriber-1a2b3c4d@example.invalid",
      " WBH-Subscriber-1A2B3C4D@Example.Invalid ",
      "newsletter@attacker.invalid",
      "Guest.Order+1@ATTACKER.invalid",
    ])
      expect(isAttackerAddress(subscriber, own)).toBe(true);
    for (const other of [
      "harness-admin@example.invalid",
      "wbh-victim-subscriber-1a2b3c4d@example.invalid",
      "wbh-customer-1a2b3c4d@example.invalid",
      "lab-reader@example.invalid",
      "attacker.invalid@example.invalid",
      "someone@sub.attacker.invalid",
      "someone@attacker.invalid.example",
      "harness-admin@example.invalid@attacker.invalid",
      "@attacker.invalid",
      "",
    ])
      expect(isAttackerAddress(subscriber, other)).toBe(false);
    // An unauthenticated attacker has no account address to read.
    expect(
      isAttackerAddress(
        unauthenticated,
        "wbh-subscriber-1a2b3c4d@example.invalid",
      ),
    ).toBe(false);
    expect(isAttackerAddress(unauthenticated, "me@attacker.invalid")).toBe(
      true,
    );
  });

  it("hands on only messages one of whose recipients is the attacker's", () => {
    const messages = [
      message("admin", { to: ["harness-admin@example.invalid"] }),
      message("victim", {
        to: ["wbh-victim-subscriber-1a2b3c4d@example.invalid"],
      }),
      message("own", { to: ["wbh-subscriber-1a2b3c4d@example.invalid"] }),
      message("declared", { to: ["me@attacker.invalid"] }),
      message("copied", {
        to: ["harness-admin@example.invalid"],
        cc: ["me@attacker.invalid"],
      }),
      message("blind", {
        to: ["harness-admin@example.invalid"],
        bcc: ["me@attacker.invalid", "auditor@example.invalid"],
      }),
      message("admin-blind", {
        to: ["wbh-subscriber-1a2b3c4d@example.invalid"],
        bcc: ["harness-admin@example.invalid"],
      }),
    ];
    const mailbox = attackerMailbox(messages, subscriber);
    expect(mailbox.map((entry) => entry.id).sort()).toEqual(
      ["admin-blind", "blind", "copied", "declared", "own"].sort(),
    );
    // The attacker sees a Bcc copy as its own, never who else was blind-copied.
    expect(mailbox.find((entry) => entry.id === "blind")?.bcc).toEqual([
      address("me@attacker.invalid"),
    ]);
    expect(mailbox.find((entry) => entry.id === "admin-blind")?.bcc).toEqual(
      [],
    );
    expect(JSON.stringify(mailbox)).not.toContain("auditor@example.invalid");

    expect(
      attackerMailbox(messages, unauthenticated).map((entry) => entry.id),
    ).toEqual(["blind", "copied", "declared"].sort());
    expect(attackerMailbox([messages[0]!, messages[1]!], subscriber)).toEqual(
      [],
    );
  });

  it("orders the mailbox oldest first", () => {
    const mailbox = attackerMailbox(
      [
        message(
          "late",
          { to: ["me@attacker.invalid"] },
          "2026-11-03T00:02:00Z",
        ),
        message(
          "early",
          { to: ["me@attacker.invalid"] },
          "2026-11-03T00:01:00Z",
        ),
      ],
      unauthenticated,
    );
    expect(mailbox.map((entry) => entry.id)).toEqual(["early", "late"]);
  });

  it("reads in full only the summaries addressed to the attacker", () => {
    const wanted = addressedToAttacker(unauthenticated);
    const summary = (to: string[], cc: string[] = [], bcc: string[] = []) => ({
      To: to.map((value) => ({ name: "", address: value })),
      Cc: cc.map((value) => ({ name: "", address: value })),
      Bcc: bcc.map((value) => ({ name: "", address: value })),
    });
    expect(wanted(summary(["harness-admin@example.invalid"]))).toBe(false);
    expect(wanted(summary(["me@attacker.invalid"]))).toBe(true);
    expect(wanted(summary([], ["me@attacker.invalid"]))).toBe(true);
    expect(wanted(summary([], [], ["me@attacker.invalid"]))).toBe(true);
  });
});
