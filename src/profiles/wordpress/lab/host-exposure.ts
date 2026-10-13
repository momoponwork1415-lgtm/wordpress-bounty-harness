import type { DockerResult, Resources, WordPressLabHandle } from "./index.js";

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

type RequireDocker = (
  args: readonly string[],
  timeoutMs?: number,
) => Promise<DockerResult>;

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

const port = (value: number) =>
  Number.isSafeInteger(value) && value >= 1 && value <= 65535;

export async function exposeWordPressLabToHost(input: {
  readonly resource: Resources;
  readonly handle: WordPressLabHandle;
  readonly image: string;
  readonly httpPort: number;
  readonly databasePort?: number;
  readonly requireDocker: RequireDocker;
}): Promise<HostExposure> {
  const { resource, handle, requireDocker } = input;
  if (
    !port(input.httpPort) ||
    (input.databasePort !== undefined && !port(input.databasePort))
  )
    return { status: "unavailable", diagnostic: "Host port is out of range" };
  const database =
    handle.database === undefined || input.databasePort === undefined
      ? null
      : { ip: handle.database.ipv4, port: input.databasePort };
  const container = hostGatewayName(resource.id);
  try {
    await requireDocker([
      "create",
      "--name",
      container,
      "--runtime=runsc",
      "--network",
      "bridge",
      "--publish",
      `127.0.0.1:${input.httpPort}:80`,
      ...(database === null
        ? []
        : ["--publish", `127.0.0.1:${database.port}:3306`]),
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges",
      "--env",
      `WBH_WP_IP=${handle.internalIp}`,
      ...(database === null ? [] : ["--env", `WBH_DB_IP=${database.ip}`]),
      "--entrypoint=node",
      input.image,
      "-e",
      HOST_GATEWAY_SCRIPT,
    ]);
    await requireDocker(["network", "connect", resource.network, container]);
    await requireDocker(["start", container]);
  } catch (error: unknown) {
    return {
      status: "unavailable",
      diagnostic:
        error instanceof Error && "diagnostic" in error
          ? String(error.diagnostic)
          : "The host gateway could not be started",
    };
  }
  return {
    status: "exposed",
    container,
    httpPort: input.httpPort,
    databasePort: database?.port ?? null,
  };
}
