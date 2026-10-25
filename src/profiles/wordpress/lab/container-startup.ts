import { isIP } from "node:net";
import { fileURLToPath } from "node:url";

import { RECORDER_STATE_DIRECTORY } from "../../../lab/capture.js";
import { CONTROL_STATE_DIRECTORY } from "../../../lab/control/index.js";
import type { WordPressLabSession } from "./lab-session.js";

export const BEACON_LOG = "/tmp/wbh-beacons";
/** Only a browser script can send the nonce-bound custom header on a POST. */
export const BEACON_ROUTER = `<?php
$path = (string) parse_url((string) ($_SERVER['REQUEST_URI'] ?? ''), PHP_URL_PATH);
$origin = (string) ($_SERVER['HTTP_ORIGIN'] ?? '');
$method = (string) ($_SERVER['REQUEST_METHOD'] ?? '');
if ($origin !== 'http://wordpress' || !preg_match('#^/(b|c)/([A-Za-z0-9-]{1,100})$#', $path, $match)) {
  http_response_code(403);
  return;
}
header('Access-Control-Allow-Origin: http://wordpress');
header('Vary: Origin');
if ($match[1] === 'c') {
  if ($method !== 'GET') {
    http_response_code(403);
    return;
  }
  header('Content-Type: application/javascript; charset=utf-8');
  http_response_code(200);
  echo 'fetch("http://canary:8080/b/' . $match[2] . '",{method:"POST",headers:{"X-WBH-Script-Canary":"' . $match[2] . '"}});';
  return;
}
if ($method === 'OPTIONS') {
  header('Access-Control-Allow-Methods: POST, OPTIONS');
  header('Access-Control-Allow-Headers: X-WBH-Script-Canary');
  http_response_code(204);
  return;
}
if ($method !== 'POST' || !hash_equals($match[2], (string) ($_SERVER['HTTP_X_WBH_SCRIPT_CANARY'] ?? ''))) {
  http_response_code(403);
  return;
}
file_put_contents('${BEACON_LOG}', $path . "\\n", FILE_APPEND | LOCK_EX);
http_response_code(204);
`;

function privateIpv4(output: string): string {
  const address = output.trim();
  const octets = address.split(".").map(Number);
  if (
    isIP(address) !== 4 ||
    !(
      octets[0] === 10 ||
      (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) ||
      (octets[0] === 192 && octets[1] === 168)
    )
  )
    throw new Error("Lab internal address is unavailable");
  return address;
}

async function containerIp(
  lab: WordPressLabSession,
  container: string,
): Promise<string> {
  return privateIpv4(
    (
      await lab.requireDocker([
        "inspect",
        "--format",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
        container,
      ])
    ).stdout,
  );
}

/** The address `offset` places after the network address of an IPv4 subnet. */
function subnetAddress(base: string, offset: number): string {
  const value =
    base.split(".").reduce((sum, octet) => sum * 256 + Number(octet), 0) +
    offset;
  return [24, 16, 8, 0].map((shift) => (value >>> shift) & 255).join(".");
}

/** A locally administered MAC derived from an IPv4 address, as Docker once did. */
function macFor(address: string): string {
  return [
    "02",
    "42",
    ...address
      .split(".")
      .map((octet) => Number(octet).toString(16).padStart(2, "0")),
  ].join(":");
}

/**
 * Exploration Labs: Docker picks a free subnet, then the network is made
 * again with that subnet given explicitly, which Docker requires before a
 * container may take a fixed address. Dynamic addresses come from the upper
 * half only, so the fixed WordPress address stays free across resets.
 */
async function createFixedSubnetNetwork(
  lab: WordPressLabSession,
): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    await lab.requireDocker(["network", "create", "--internal", lab.network]);
    lab.created.add("network");
    const subnet = (
      await lab.requireDocker([
        "network",
        "inspect",
        "--format",
        "{{range .IPAM.Config}}{{.Subnet}}{{end}}",
        lab.network,
      ])
    ).stdout.trim();
    await lab.requireDocker(["network", "rm", lab.network]);
    lab.created.delete("network");
    const match = /^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/.exec(subnet);
    const prefix = Number(match?.[2]);
    if (match === null || isIP(match[1]!) !== 4 || prefix < 8 || prefix > 24)
      throw new Error("Lab subnet is unavailable");
    const base = privateIpv4(match[1]!);
    const upperHalf = subnetAddress(base, 2 ** (32 - prefix - 1));
    // Another network can take the subnet between the two calls; try again.
    const created = await lab.docker([
      "network",
      "create",
      "--internal",
      `--subnet=${subnet}`,
      `--ip-range=${upperHalf}/${prefix + 1}`,
      lab.network,
    ]);
    if (created.exitCode === 0) {
      lab.created.add("network");
      lab.wordpressIp = subnetAddress(base, 10);
      return;
    }
  }
  throw new Error("Lab network with a fixed subnet is unavailable");
}

async function startDatabase(lab: WordPressLabSession): Promise<void> {
  await lab.requireDocker([
    "run",
    "--detach",
    "--name",
    lab.database,
    "--runtime=runsc",
    "--network",
    lab.network,
    "--security-opt=no-new-privileges",
    "--env",
    `MARIADB_ROOT_PASSWORD=${lab.databasePassword}`,
    "--env",
    "MARIADB_DATABASE=wordpress",
    lab.images.database,
  ]);
  lab.created.add("database");
  lab.databaseIp = await containerIp(lab, lab.database);
}

async function startNetworkAndDatabase(
  lab: WordPressLabSession,
): Promise<void> {
  if (lab.exploration) await createFixedSubnetNetwork(lab);
  else {
    await lab.requireDocker(["network", "create", "--internal", lab.network]);
    lab.created.add("network");
  }
  await lab.requireDocker(["volume", "create", lab.volume]);
  lab.created.add("volume");
  await startDatabase(lab);
}

async function startWordPress(lab: WordPressLabSession): Promise<string> {
  await lab.requireDocker([
    "run",
    "--detach",
    "--name",
    lab.wordpress,
    "--runtime=runsc",
    "--network",
    lab.network,
    // The MAC follows the address too: the recorder's gVisor neighbour cache
    // keeps the old one for about a minute after a reset otherwise.
    ...(lab.wordpressIp === undefined
      ? []
      : [
          `--ip=${lab.wordpressIp}`,
          `--mac-address=${macFor(lab.wordpressIp)}`,
        ]),
    "--network-alias",
    "wordpress",
    // runsc cannot reliably resolve Docker's alias from inside this container.
    // Keep WordPress self-requests on its own loopback interface.
    "--add-host=wordpress:127.0.0.1",
    "--security-opt=no-new-privileges",
    "--volume",
    `${lab.volume}:/var/www/html`,
    "--env",
    `WORDPRESS_DB_HOST=${lab.databaseIp}`,
    "--env",
    "WORDPRESS_DB_NAME=wordpress",
    "--env",
    "WORDPRESS_DB_USER=root",
    "--env",
    `WORDPRESS_DB_PASSWORD=${lab.databasePassword}`,
    lab.images.wordpress,
  ]);
  lab.created.add("wordpress");
  return containerIp(lab, lab.wordpress);
}

async function startRecorder(
  lab: WordPressLabSession,
  internalIp: string,
): Promise<string> {
  await lab.requireDocker([
    "run",
    "--detach",
    "--name",
    lab.recorder,
    "--runtime=runsc",
    "--network",
    lab.network,
    `--add-host=wordpress:${internalIp}`,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    `--tmpfs=${RECORDER_STATE_DIRECTORY}:rw,nosuid,nodev,size=65m`,
    "--env",
    "WBH_UPSTREAM_HOST=wordpress",
    "--volume",
    `${fileURLToPath(new URL("../../../lab-recorder/", import.meta.url))}:/opt/wbh-recorder:ro`,
    "--entrypoint=node",
    lab.images.recorder,
    "/opt/wbh-recorder/cli.js",
  ]);
  lab.created.add("recorder");
  return containerIp(lab, lab.recorder);
}

async function startReceiver(lab: WordPressLabSession): Promise<void> {
  await lab.requireDocker([
    "run",
    "--detach",
    "--name",
    lab.receiver,
    "--runtime=runsc",
    "--network",
    lab.network,
    "--network-alias",
    "canary",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--tmpfs=/tmp:rw,nosuid,nodev,size=16m",
    "--entrypoint",
    "sh",
    lab.images.wordpress,
    "-c",
    `echo ${Buffer.from(BEACON_ROUTER).toString("base64")} | base64 -d > /tmp/router.php && exec php -S 0.0.0.0:8080 /tmp/router.php`,
  ]);
  lab.created.add("receiver");
  lab.receiverIp = await containerIp(lab, lab.receiver);
}

async function waitForHealth(
  lab: WordPressLabSession,
  attempts: number,
): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const [wordpressHealth, databaseHealth] = await Promise.all([
      lab.docker(
        [
          "exec",
          lab.wordpress,
          "php",
          "-r",
          'exit(is_file("/var/www/html/wp-settings.php") ? 0 : 1);',
        ],
        10_000,
      ),
      lab.docker(
        [
          "exec",
          lab.database,
          "mariadb-admin",
          "ping",
          "--host=127.0.0.1",
          "--user=root",
          `--password=${lab.databasePassword}`,
          "--silent",
        ],
        10_000,
      ),
    ]);
    if (wordpressHealth.exitCode === 0 && databaseHealth.exitCode === 0) return;
    if (attempt + 1 < attempts)
      await new Promise<void>((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("WordPress health check failed");
}

/** Where the control endpoint's code is mounted, read-only, like the recorder's. */
const CONTROL_MOUNT = "/opt/wbh-control";

/**
 * Exploration Labs: the control endpoint the agent calls (`http://labctl/`).
 * It only relays commands to the host Harness, which polls it with `docker exec`.
 */
async function startControl(lab: WordPressLabSession): Promise<void> {
  await lab.requireDocker([
    "run",
    "--detach",
    "--name",
    lab.control,
    "--runtime=runsc",
    "--network",
    lab.network,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    `--tmpfs=${CONTROL_STATE_DIRECTORY}:rw,nosuid,nodev,size=1m`,
    "--volume",
    `${fileURLToPath(new URL("../../../lab-control/", import.meta.url))}:${CONTROL_MOUNT}:ro`,
    "--entrypoint=node",
    lab.images.recorder,
    `${CONTROL_MOUNT}/cli.js`,
    "serve",
  ]);
  lab.created.add("control");
  lab.controlIp = await containerIp(lab, lab.control);
}

/** The command line that runs one control mode inside the endpoint's container. */
export function controlCommand(
  lab: WordPressLabSession,
  args: readonly string[],
): readonly string[] {
  return ["exec", lab.control, "node", `${CONTROL_MOUNT}/cli.js`, ...args];
}

/**
 * Starts only runsc containers; caller owns cleanup after any failure. A
 * verification Lab gets the beacon receiver; an exploration Lab gets the
 * control endpoint instead and no canary receiver.
 */
export async function startLabContainers(
  lab: WordPressLabSession,
  attempts: number,
): Promise<{ readonly internalIp: string; readonly recorderIp: string }> {
  await startNetworkAndDatabase(lab);
  const internalIp = await startWordPress(lab);
  const recorderIp = await startRecorder(lab, internalIp);
  if (lab.exploration) await startControl(lab);
  else await startReceiver(lab);
  await waitForHealth(lab, attempts);
  return { internalIp, recorderIp };
}

/**
 * An exploration Lab's reset: WordPress, its database and the site volume are
 * removed and made again; WordPress takes its fixed address back, so the
 * network, recorder and control endpoint (and the sandbox's view of them)
 * stay. The caller initializes WordPress from the same setup afterwards.
 */
export async function recreateSiteContainers(
  lab: WordPressLabSession,
  attempts: number,
): Promise<void> {
  if (!lab.exploration || lab.wordpressIp === undefined)
    throw new Error("Only an exploration Lab is reset");
  await lab.requireDocker(["rm", "--force", lab.wordpress, lab.database]);
  lab.created.delete("wordpress");
  lab.created.delete("database");
  await lab.requireDocker(["volume", "rm", "--force", lab.volume]);
  lab.created.delete("volume");
  await lab.requireDocker(["volume", "create", lab.volume]);
  lab.created.add("volume");
  await startDatabase(lab);
  if ((await startWordPress(lab)) !== lab.wordpressIp)
    throw new Error("WordPress did not take its fixed address back");
  await waitForHealth(lab, attempts);
}
