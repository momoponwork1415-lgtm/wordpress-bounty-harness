import { isIP } from "node:net";
import { fileURLToPath } from "node:url";

import { RECORDER_STATE_DIRECTORY } from "../../../lab/capture.js";
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

async function startNetworkAndDatabase(
  lab: WordPressLabSession,
): Promise<void> {
  await lab.requireDocker(["network", "create", "--internal", lab.network]);
  lab.created.add("network");
  await lab.requireDocker(["volume", "create", lab.volume]);
  lab.created.add("volume");
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

async function startWordPress(lab: WordPressLabSession): Promise<string> {
  await lab.requireDocker([
    "run",
    "--detach",
    "--name",
    lab.wordpress,
    "--runtime=runsc",
    "--network",
    lab.network,
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
    "--env",
    `WBH_EXECUTION_SALT=${lab.executionSalt}`,
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

/** Starts only runsc containers; caller owns cleanup after any failure. */
export async function startLabContainers(
  lab: WordPressLabSession,
  attempts: number,
): Promise<{ readonly internalIp: string; readonly recorderIp: string }> {
  await startNetworkAndDatabase(lab);
  const internalIp = await startWordPress(lab);
  const recorderIp = await startRecorder(lab, internalIp);
  await startReceiver(lab);
  await waitForHealth(lab, attempts);
  return { internalIp, recorderIp };
}
