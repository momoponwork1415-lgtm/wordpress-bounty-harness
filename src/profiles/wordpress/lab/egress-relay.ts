import type { LabEgressDestination } from "../../../lab/egress-plan.js";
import type { WordPressLabSession } from "./lab-session.js";

/**
 * ADR 0046 条件 2・5・6: a verification Lab that needs an external service
 * reaches it through one Harness-owned relay per fixed destination. The relay
 * is a plain TCP forwarder on the bridge, joined to the Lab network; WordPress
 * resolves the destination's name to the relay's Lab address. The relay writes
 * one line per connection (times and byte counts, never content). At
 * `setup-done` the Harness removes the relays and confirms from inside the
 * Lab that the destinations no longer answer, before any attacker data is
 * released.
 */
export const EGRESS_RELAY_SCRIPT = `const net = require("net");
const host = process.env.WBH_EGRESS_HOST;
const port = Number(process.env.WBH_EGRESS_PORT);
const log = (record) => process.stdout.write(JSON.stringify(record) + "\\n");
net.createServer((client) => {
  const openedAt = new Date().toISOString();
  let bytesIn = 0;
  let bytesOut = 0;
  const upstream = net.connect(port, host);
  const close = () => { client.destroy(); upstream.destroy(); };
  client.on("data", (chunk) => { bytesIn += chunk.length; });
  upstream.on("data", (chunk) => { bytesOut += chunk.length; });
  client.on("error", close);
  upstream.on("error", close);
  client.once("close", () => {
    upstream.destroy();
    log({ openedAt, closedAt: new Date().toISOString(), bytesIn, bytesOut });
  });
  client.pipe(upstream);
  upstream.pipe(client);
}).listen(port, "0.0.0.0");`;

export type EgressRelay = {
  readonly destination: LabEgressDestination;
  readonly container: string;
  /** The relay's address on the Lab network, which WordPress resolves the host to. */
  readonly ip: string;
};

export type EgressConnection = {
  readonly destination: LabEgressDestination;
  readonly openedAt: string;
  readonly closedAt: string;
  readonly bytesIn: number;
  readonly bytesOut: number;
};

/** What the Harness recorded when it closed the relays (ADR 0046 条件 6). */
export type EgressClosure = {
  readonly destinations: readonly LabEgressDestination[];
  readonly closedAt: string;
  readonly connections: readonly EgressConnection[];
  /** True when every destination failed to answer from inside the Lab after removal. */
  readonly unreachableConfirmed: boolean;
};

export function egressRelayName(labId: string, index: number): string {
  return `wbh-${labId}-egress${index}`;
}

const connectionLine = (
  destination: LabEgressDestination,
  line: string,
): EgressConnection | null => {
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    if (
      typeof record.openedAt !== "string" ||
      typeof record.closedAt !== "string" ||
      typeof record.bytesIn !== "number" ||
      typeof record.bytesOut !== "number"
    )
      return null;
    return {
      destination,
      openedAt: record.openedAt,
      closedAt: record.closedAt,
      bytesIn: record.bytesIn,
      bytesOut: record.bytesOut,
    };
  } catch {
    return null;
  }
};

/**
 * Starts one relay per destination before WordPress, so WordPress can be
 * given the relays' addresses. Created on the bridge, connected to the Lab
 * network, then started: gVisor reads its networks at boot.
 */
export async function startEgressRelays(
  lab: Pick<WordPressLabSession, "id" | "network" | "images" | "requireDocker">,
  destinations: readonly LabEgressDestination[],
): Promise<EgressRelay[]> {
  const relays: EgressRelay[] = [];
  for (const [index, destination] of destinations.entries()) {
    const container = egressRelayName(lab.id, index + 1);
    await lab.requireDocker([
      "create",
      "--name",
      container,
      "--runtime=runsc",
      "--network",
      "bridge",
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--env",
      `WBH_EGRESS_HOST=${destination.host}`,
      "--env",
      `WBH_EGRESS_PORT=${destination.port}`,
      "--entrypoint=node",
      lab.images.recorder,
      "-e",
      EGRESS_RELAY_SCRIPT,
    ]);
    await lab.requireDocker(["network", "connect", lab.network, container]);
    await lab.requireDocker(["start", container]);
    const ip = (
      await lab.requireDocker([
        "inspect",
        "--format",
        `{{(index .NetworkSettings.Networks "${lab.network}").IPAddress}}`,
        container,
      ])
    ).stdout.trim();
    if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip))
      throw new Error("Egress relay address is unavailable");
    relays.push({ destination, container, ip });
  }
  return relays;
}

/**
 * Removes the relays, keeps their connection lines, and confirms from inside
 * the WordPress container that each destination no longer answers.
 */
export async function closeEgressRelays(
  lab: Pick<WordPressLabSession, "docker" | "wordpress">,
  relays: readonly EgressRelay[],
  clock: () => Date,
): Promise<EgressClosure> {
  const connections: EgressConnection[] = [];
  for (const relay of relays) {
    const logs = await lab.docker(["logs", relay.container]).catch(() => null);
    if (logs !== null && logs.exitCode === 0)
      for (const line of logs.stdout.split("\n")) {
        const connection = connectionLine(relay.destination, line.trim());
        if (connection !== null) connections.push(connection);
      }
    await lab.docker(["rm", "--force", relay.container]).catch(() => null);
  }
  let unreachableConfirmed = relays.length > 0;
  for (const relay of relays) {
    // Exit 7 only when the destination still answers a connection from the Lab.
    const probe = await lab
      .docker([
        "exec",
        lab.wordpress,
        "php",
        "-r",
        "exit(@fsockopen($argv[1], (int) $argv[2], $errno, $errstr, 3) ? 7 : 0);",
        "--",
        relay.destination.host,
        String(relay.destination.port),
      ])
      .catch(() => null);
    if (probe === null || probe.exitCode !== 0) unreachableConfirmed = false;
  }
  return {
    destinations: relays.map((relay) => relay.destination),
    closedAt: clock().toISOString(),
    connections,
    unreachableConfirmed,
  };
}
