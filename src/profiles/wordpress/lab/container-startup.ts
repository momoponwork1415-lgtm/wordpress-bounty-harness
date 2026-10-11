import { isIP } from "node:net";
import { fileURLToPath } from "node:url";

import type { DockerResult, Resources } from "./index.js";

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

type RunDocker = (
  args: readonly string[],
  timeoutMs?: number,
  maxOutputBytes?: number,
) => Promise<DockerResult>;
type RequireDocker = (
  args: readonly string[],
  timeoutMs?: number,
) => Promise<DockerResult>;

export interface ContainerStartup {
  readonly images: {
    readonly database: string;
    readonly wordpress: string;
    readonly recorder: string;
  };
  readonly attempts: number;
  readonly docker: RunDocker;
  readonly requireDocker: RequireDocker;
}

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

async function startNetworkAndDatabase(
  resource: Resources,
  startup: ContainerStartup,
): Promise<void> {
  const { requireDocker, images } = startup;
  await requireDocker(["network", "create", "--internal", resource.network]);
  resource.networkCreated = true;
  await requireDocker(["volume", "create", resource.volume]);
  resource.volumeCreated = true;
  await requireDocker([
    "run",
    "--detach",
    "--name",
    resource.database,
    "--runtime=runsc",
    "--network",
    resource.network,
    "--security-opt=no-new-privileges",
    "--env",
    `MARIADB_ROOT_PASSWORD=${resource.databasePassword}`,
    "--env",
    "MARIADB_DATABASE=wordpress",
    images.database,
  ]);
  resource.databaseCreated = true;
  resource.databaseIp = privateIpv4(
    (
      await requireDocker([
        "inspect",
        "--format",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
        resource.database,
      ])
    ).stdout,
  );
}

async function startWordPress(
  resource: Resources,
  startup: ContainerStartup,
): Promise<string> {
  const { requireDocker, images } = startup;
  await requireDocker([
    "run",
    "--detach",
    "--name",
    resource.wordpress,
    "--runtime=runsc",
    "--network",
    resource.network,
    "--network-alias",
    "wordpress",
    "--security-opt=no-new-privileges",
    "--volume",
    `${resource.volume}:/var/www/html`,
    "--env",
    `WORDPRESS_DB_HOST=${resource.databaseIp}`,
    "--env",
    "WORDPRESS_DB_NAME=wordpress",
    "--env",
    "WORDPRESS_DB_USER=root",
    "--env",
    `WORDPRESS_DB_PASSWORD=${resource.databasePassword}`,
    "--env",
    `WBH_EXECUTION_SALT=${resource.executionSalt}`,
    images.wordpress,
  ]);
  resource.wordpressCreated = true;
  return privateIpv4(
    (
      await requireDocker([
        "inspect",
        "--format",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
        resource.wordpress,
      ])
    ).stdout,
  );
}

async function startRecorder(
  resource: Resources,
  startup: ContainerStartup,
  internalIp: string,
): Promise<string> {
  const { requireDocker, images } = startup;
  await requireDocker([
    "run",
    "--detach",
    "--name",
    resource.recorder,
    "--runtime=runsc",
    "--network",
    resource.network,
    `--add-host=wordpress:${internalIp}`,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--tmpfs=/var/lib/wbh:rw,nosuid,nodev,size=65m",
    "--env",
    "WBH_UPSTREAM_HOST=wordpress",
    "--volume",
    `${fileURLToPath(new URL("../../../lab-recorder/", import.meta.url))}:/opt/wbh-recorder:ro`,
    "--entrypoint=node",
    images.recorder,
    "/opt/wbh-recorder/cli.js",
  ]);
  resource.recorderCreated = true;
  return privateIpv4(
    (
      await requireDocker([
        "inspect",
        "--format",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
        resource.recorder,
      ])
    ).stdout,
  );
}

async function startReceiver(
  resource: Resources,
  startup: ContainerStartup,
): Promise<void> {
  const { requireDocker, images } = startup;
  await requireDocker([
    "run",
    "--detach",
    "--name",
    resource.receiver,
    "--runtime=runsc",
    "--network",
    resource.network,
    "--network-alias",
    "canary",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--tmpfs=/tmp:rw,nosuid,nodev,size=16m",
    "--entrypoint",
    "sh",
    images.wordpress,
    "-c",
    `echo ${Buffer.from(BEACON_ROUTER).toString("base64")} | base64 -d > /tmp/router.php && exec php -S 0.0.0.0:8080 /tmp/router.php`,
  ]);
  resource.receiverCreated = true;
  resource.receiverIp = privateIpv4(
    (
      await requireDocker([
        "inspect",
        "--format",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
        resource.receiver,
      ])
    ).stdout,
  );
}

async function waitForHealth(
  resource: Resources,
  startup: ContainerStartup,
): Promise<void> {
  const { docker, attempts } = startup;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const [wordpressHealth, databaseHealth] = await Promise.all([
      docker(
        [
          "exec",
          resource.wordpress,
          "php",
          "-r",
          'exit(is_file("/var/www/html/wp-settings.php") ? 0 : 1);',
        ],
        10_000,
      ),
      docker(
        [
          "exec",
          resource.database,
          "mariadb-admin",
          "ping",
          "--host=127.0.0.1",
          "--user=root",
          `--password=${resource.databasePassword}`,
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

/** Starts only runsc containers; caller owns cleanup after any failure. */
export async function startLabContainers(
  resource: Resources,
  startup: ContainerStartup,
): Promise<{ readonly internalIp: string; readonly recorderIp: string }> {
  await startNetworkAndDatabase(resource, startup);
  const internalIp = await startWordPress(resource, startup);
  const recorderIp = await startRecorder(resource, startup, internalIp);
  await startReceiver(resource, startup);
  await waitForHealth(resource, startup);
  return { internalIp, recorderIp };
}
