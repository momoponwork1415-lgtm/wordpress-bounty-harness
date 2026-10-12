import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BEACON_LOG,
  BEACON_ROUTER,
} from "../../../src/profiles/wordpress/lab/container-startup.js";

const phpAvailable =
  spawnSync("php", ["-v"], { encoding: "utf8" }).status === 0;

describe.skipIf(!phpAvailable)("script canary receiver", () => {
  it("logs only a nonce-bound JavaScript POST after an unlogged CORS preflight", async () => {
    const root = await mkdtemp(join(tmpdir(), "wbh-script-beacon-"));
    const router = join(root, "router.php");
    const log = join(root, "beacons");
    await writeFile(router, BEACON_ROUTER.replaceAll(BEACON_LOG, log));
    const send = (
      method: string,
      origin: string,
      nonceHeader?: string,
      path = "/b/issued-nonce",
    ): string => {
      const server = {
        REQUEST_URI: path,
        REQUEST_METHOD: method,
        HTTP_ORIGIN: origin,
        ...(nonceHeader === undefined
          ? {}
          : { HTTP_X_WBH_SCRIPT_CANARY: nonceHeader }),
      };
      const result = spawnSync(
        "php",
        [
          "-r",
          '$_SERVER = json_decode($argv[1], true); include $argv[2]; echo "CODE=" . http_response_code();',
          JSON.stringify(server),
          router,
        ],
        { encoding: "utf8" },
      );
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    const lines = async () =>
      (await readFile(log, "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .filter(Boolean);

    try {
      expect(send("OPTIONS", "http://wordpress")).toBe("CODE=204");
      expect(
        send("OPTIONS", "http://wordpress", undefined, "/c/issued-nonce"),
      ).toBe("CODE=403");
      expect(
        send("POST", "http://wordpress", "issued-nonce", "/c/issued-nonce"),
      ).toBe("CODE=403");
      expect(
        send("GET", "http://elsewhere", undefined, "/c/issued-nonce"),
      ).toBe("CODE=403");
      expect(
        send("GET", "http://wordpress", undefined, "/c/issued-nonce"),
      ).toBe(
        'fetch("http://canary:8080/b/issued-nonce",{method:"POST",headers:{"X-WBH-Script-Canary":"issued-nonce"}});CODE=200',
      );
      expect(send("GET", "http://wordpress", "issued-nonce")).toBe("CODE=403");
      expect(send("POST", "http://wordpress")).toBe("CODE=403");
      expect(send("POST", "http://wordpress", "wrong-nonce")).toBe("CODE=403");
      expect(send("POST", "http://elsewhere", "issued-nonce")).toBe("CODE=403");
      expect(
        send("POST", "http://wordpress", "issued-nonce", "/b/nope/extra"),
      ).toBe("CODE=403");
      expect(await lines()).toEqual([]);

      expect(send("POST", "http://wordpress", "issued-nonce")).toBe("CODE=204");
      expect(await lines()).toEqual(["/b/issued-nonce"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
