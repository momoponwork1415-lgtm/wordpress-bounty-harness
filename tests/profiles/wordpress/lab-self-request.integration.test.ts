import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, it } from "vitest";

import { openMaterializedSources } from "../../../src/profiles/wordpress/acquisition/index.js";
import {
  openWordPressLab,
  type WordPressLabSetup,
} from "../../../src/profiles/wordpress/lab/index.js";
import {
  nativeDockerRunner,
  type DockerRunner,
} from "../../../src/profiles/wordpress/lab/lab-docker.js";
import {
  openSnapshot,
  type AcquiredSource,
} from "../../../src/snapshot/index.js";

const execFile = promisify(execFileCallback);
const imagesJson = process.env.WBH_REAL_LAB_IMAGES;

it.skipIf(imagesJson === undefined)(
  "WordPress can request its own home URL inside a real runsc Lab",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "wbh-self-request-"));
    const plugin = "wbh-self-request-fixture";
    const content = `<?php\n/* Plugin Name: Self Request Fixture\nVersion: 1.0.0 */\n`;
    const source: AcquiredSource = {
      identity: `wporg:${plugin}`,
      version: "1.0.0",
      manifest: {
        kind: "canonical-file-manifest",
        schemaVersion: 1,
        entries: [
          {
            path: `${plugin}.php`,
            digest: `sha256:${createHash("sha256").update(content).digest("hex")}`,
            size: Buffer.byteLength(content),
          },
        ],
      },
      async readFile(path) {
        if (path !== `${plugin}.php`)
          throw new Error("Fixture file unavailable");
        return Buffer.from(content);
      },
    };
    const sources = openMaterializedSources({
      rootDirectory: join(root, "sources"),
    });
    const snapshots = openSnapshot({
      storageDirectory: join(root, "snapshots"),
      source: sources.acquisition({
        acquire: async () => ({ target: source, dependencies: [] }),
      }),
    });

    try {
      const snapshot = await snapshots.freeze(plugin);
      const images = JSON.parse(imagesJson!) as {
        database: string;
        wordpress: string;
        wordpressCli: string;
        browser: string;
        recorder: string;
      };
      // Vitest imports source TS; the recorder's executable is built in dist.
      const sourceRecorder = `${join(process.cwd(), "src/lab-recorder")}/:/opt/wbh-recorder:ro`;
      const builtRecorder = `${join(process.cwd(), "dist/lab-recorder")}:/opt/wbh-recorder:ro`;
      const docker = nativeDockerRunner("/usr/bin/docker");
      const runner: DockerRunner = {
        run: async (request) => {
          return docker.run({
            ...request,
            args: request.args.map((arg) =>
              arg === sourceRecorder ? builtRecorder : arg,
            ),
          });
        },
      };
      const lab = openWordPressLab({
        dockerExecutablePath: "/usr/bin/docker",
        images,
        source: sources,
        runner,
      });
      const setup: WordPressLabSetup = {
        schemaVersion: 1,
        snapshotDigest: snapshot.digest,
        siteTitle: "Self request fixture",
        initialPosts: [],
        customerRole: false,
      };
      const provisioned = await lab.provision(snapshot, setup);
      expect(provisioned).toMatchObject({ status: "ready" });
      if (provisioned.status !== "ready") return;
      try {
        const script = [
          'require "/var/www/html/wp-load.php";',
          '$response = wp_safe_remote_get(home_url("/"), ["timeout" => 8]);',
          'echo is_wp_error($response) ? "ERROR:" . $response->get_error_message() : "HTTP:" . wp_remote_retrieve_response_code($response);',
        ].join(" ");
        const { stdout } = await execFile(
          "/usr/bin/docker",
          ["exec", `wbh-${provisioned.handle.id}-wp`, "php", "-r", script],
          { timeout: 15_000 },
        );
        expect(stdout.trim()).toBe("HTTP:200");

        // Attacker peers must still use the recorder; the self-host mapping
        // above changes only WordPress's own name resolution.
        const marker = await lab.markCapture(provisioned.handle);
        expect(marker).not.toBeNull();
        const peer = await execFile(
          "/usr/bin/docker",
          [
            "run",
            "--rm",
            "--runtime=runsc",
            "--network",
            provisioned.handle.networkName,
            `--add-host=wordpress:${provisioned.handle.recorderIp}`,
            "--read-only",
            "--cap-drop=ALL",
            "--security-opt=no-new-privileges",
            "--entrypoint=php",
            images.wordpress,
            "-r",
            'echo file_get_contents("http://wordpress/?wbh_probe=peer") !== false ? "HTTP:200" : "ERROR";',
          ],
          { timeout: 15_000 },
        );
        expect(peer.stdout.trim()).toBe("HTTP:200");
        const capture = await lab.readCapture(provisioned.handle, marker!);
        expect(capture.status).toBe("captured");
        if (capture.status === "captured") {
          expect(capture.dropped).toBe(0);
          expect(capture.defects).toEqual([]);
          expect(
            capture.exchanges.some(
              (exchange) =>
                exchange.request.path === "/?wbh_probe=peer" &&
                exchange.response.statusCode === 200,
            ),
          ).toBe(true);
        }
      } finally {
        expect(await lab.teardown(provisioned.handle)).toEqual({
          status: "removed",
        });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  180_000,
);
