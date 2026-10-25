import type { WordPressLabSession } from "./lab-session.js";

/**
 * A Harness-owned TCP forwarder that publishes the Lab's WordPress and, when
 * the Lab exposes it, the read-only database on the host loopback (#186,
 * `lab up`). The container is created on the bridge (an internal network
 * publishes nothing), connected to the Lab network, and only then started:
 * gVisor configures its interfaces at boot and ignores networks connected to
 * a running sandbox.
 */
export const HOST_GATEWAY_SCRIPT = `const net = require("net");
const forward = (listenPort, host, port) =>
  net.createServer((client) => {
    const upstream = net.connect(port, host);
    const close = () => { client.destroy(); upstream.destroy(); };
    client.on("error", close);
    upstream.on("error", close);
    client.pipe(upstream);
    upstream.pipe(client);
  }).listen(listenPort, "0.0.0.0");
forward(80, process.env.WBH_WP_IP, 80);
if (process.env.WBH_DB_IP) forward(3306, process.env.WBH_DB_IP, 3306);`;

export type HostExposure =
  | {
      readonly status: "exposed";
      readonly container: string;
      readonly httpPort: number;
      readonly databasePort: number | null;
    }
  | { readonly status: "unavailable"; readonly diagnostic: string };

export function hostGatewayName(labId: string): string {
  return `wbh-${labId}-host`;
}

/** 0 asks Docker for a free loopback port, so any number of Labs can be exposed at once (#432). */
const port = (value: number) =>
  Number.isSafeInteger(value) && value >= 0 && value <= 65535;
const publish = (hostPort: number, containerPort: number) =>
  hostPort === 0
    ? `127.0.0.1::${containerPort}`
    : `127.0.0.1:${hostPort}:${containerPort}`;

/** The loopback port Docker bound for `containerPort`; null when it bound none. */
async function boundPort(
  lab: Pick<WordPressLabSession, "requireDocker">,
  container: string,
  containerPort: number,
): Promise<number | null> {
  const result = await lab.requireDocker([
    "port",
    container,
    `${containerPort}/tcp`,
  ]);
  for (const line of result.stdout.split("\n")) {
    const match = /^127\.0\.0\.1:(\d{1,5})$/.exec(line.trim());
    const value = match === null ? NaN : Number(match[1]);
    if (port(value) && value !== 0) return value;
  }
  return null;
}

export async function exposeWordPressLabToHost(
  lab: Pick<WordPressLabSession, "id" | "network" | "handle" | "requireDocker">,
  input: {
    readonly image: string;
    /** A fixed loopback port, or 0 for a free one Docker picks. */
    readonly httpPort: number;
    readonly databasePort?: number;
    /** `recorder` routes host HTTP through the Lab recorder so it is captured (#352). */
    readonly via?: "wordpress" | "recorder";
  },
): Promise<HostExposure> {
  if (
    !port(input.httpPort) ||
    (input.databasePort !== undefined && !port(input.databasePort))
  )
    return { status: "unavailable", diagnostic: "Host port is out of range" };
  const { handle } = lab;
  const database =
    handle.database === undefined || input.databasePort === undefined
      ? null
      : { ip: handle.database.ipv4, port: input.databasePort };
  const container = hostGatewayName(lab.id);
  // A half-started gateway would keep the Lab network in use at teardown.
  const removeGateway = () =>
    lab.requireDocker(["rm", "--force", container]).then(
      () => undefined,
      () => undefined,
    );
  try {
    await lab.requireDocker([
      "create",
      "--name",
      container,
      "--runtime=runsc",
      "--network",
      "bridge",
      "--publish",
      publish(input.httpPort, 80),
      ...(database === null ? [] : ["--publish", publish(database.port, 3306)]),
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--env",
      `WBH_WP_IP=${input.via === "recorder" ? handle.recorderIp : handle.internalIp}`,
      ...(database === null ? [] : ["--env", `WBH_DB_IP=${database.ip}`]),
      "--entrypoint=node",
      input.image,
      "-e",
      HOST_GATEWAY_SCRIPT,
    ]);
    await lab.requireDocker(["network", "connect", lab.network, container]);
    await lab.requireDocker(["start", container]);
    // The ports Docker actually bound are what the skill and the operator read.
    const httpPort = await boundPort(lab, container, 80);
    const databasePort =
      database === null ? null : await boundPort(lab, container, 3306);
    if (httpPort !== null && (database === null || databasePort !== null))
      return { status: "exposed", container, httpPort, databasePort };
    await removeGateway();
    return {
      status: "unavailable",
      diagnostic: "The host gateway bound no loopback port",
    };
  } catch (error: unknown) {
    await removeGateway();
    return {
      status: "unavailable",
      diagnostic:
        error instanceof Error && "diagnostic" in error
          ? String(error.diagnostic)
          : "The host gateway could not be started",
    };
  }
}

/** Removes the host gateway so the Lab network can be torn down; true when gone. */
export async function withdrawWordPressLabFromHost(
  lab: Pick<WordPressLabSession, "id" | "docker">,
): Promise<boolean> {
  try {
    const result = await lab.docker(["rm", "--force", hostGatewayName(lab.id)]);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}
