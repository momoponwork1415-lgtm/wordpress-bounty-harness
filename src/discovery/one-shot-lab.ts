import { constants } from "node:fs";
import { open, rename, rm, truncate, writeFile } from "node:fs/promises";
import { isIP } from "node:net";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { canonicalDigest } from "../infrastructure/canonical-json.js";
import { admittedDockerName } from "./gvisor-container.js";
import {
  admittedOneShotFiles,
  ONE_SHOT_MAX_INPUT_BYTES,
  type OneShotRun,
} from "./one-shot-run.js";

type Files = Pick<OneShotRun, "inputFiles" | "lab">;
export type OneShotLabHandoff = {
  events: {
    event: "setup-done" | "attack-published";
    at: string;
    digest?: string;
  }[];
  failure?: "setup-boundary" | "administrator-expired" | "setup-not-completed";
};

export function admittedOneShotLab(run: Files, now: number): boolean {
  if (run.lab === undefined) return true;
  const lab = run.lab;
  try {
    const endpoint = new URL(lab.endpoint);
    return (
      endpoint.protocol === "http:" &&
      /^[a-z0-9][a-z0-9-]{0,62}$/.test(endpoint.hostname) &&
      endpoint.username === "" &&
      endpoint.password === "" &&
      isIP(lab.internalIp) === 4 &&
      admittedDockerName(lab.networkName) &&
      Date.parse(lab.administratorExpiresAt) > now &&
      typeof lab.closeSetup === "function" &&
      !run.inputFiles.some((file) =>
        ["lab.json", "attack.json", "attack.tmp"].includes(file.name),
      ) &&
      admittedOneShotFiles(
        [...run.inputFiles, { name: "lab.json", content: lab.labJson }],
        ONE_SHOT_MAX_INPUT_BYTES,
      ) &&
      admittedOneShotFiles(
        [
          ...lab.outputFileNames,
          "setup-done.json",
          "observation-ready.json",
        ].map((name) => ({ name, content: "" })),
        0,
      )
    );
  } catch {
    return false;
  }
}

/** Directory binds stay in place: truncate the old inode, then publish a new file. */
export function watchOneShotLab(
  input: string,
  output: string,
  lab: NonNullable<OneShotRun["lab"]>,
  abort: () => void,
  signal: AbortSignal,
) {
  const state: OneShotLabHandoff = { events: [] };
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  const stopped = new Promise<undefined>((resolve) => {
    controller.signal.addEventListener("abort", () => resolve(undefined), {
      once: true,
    });
    if (controller.signal.aborted) resolve(undefined);
  });
  let closed: Promise<string | undefined> | undefined;
  const close = () =>
    (closed ??= (async () => {
      await truncate(join(input, "lab.json"), 0);
      await rm(join(input, "lab.json"));
      return Promise.race([lab.closeSetup(controller.signal), stopped]);
    })());
  const fail = (reason: NonNullable<OneShotLabHandoff["failure"]>) => {
    state.failure = reason;
    abort();
  };
  const expiry = setTimeout(
    () => fail("administrator-expired"),
    Math.max(1, Date.parse(lab.administratorExpiresAt) - Date.now()),
  );
  const done = (async () => {
    try {
      while (!controller.signal.aborted) {
        if (Date.now() >= Date.parse(lab.administratorExpiresAt)) {
          fail("administrator-expired");
          return;
        }
        const marker = await open(
          join(output, "setup-done.json"),
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        ).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return undefined;
          throw error;
        });
        if (marker !== undefined) {
          try {
            const info = await marker.stat();
            if (!info.isFile() || info.size > 1024)
              throw new Error("Invalid setup marker");
            const bytes = Buffer.alloc(1025);
            const { bytesRead } = await marker.read(bytes, 0, bytes.length, 0);
            if (bytesRead > 1024) throw new Error("Invalid setup marker");
            JSON.parse(bytes.subarray(0, bytesRead).toString("utf8"));
          } finally {
            await marker.close();
          }
          state.events.push({
            event: "setup-done",
            at: new Date().toISOString(),
          });
          const attack = await close();
          if (controller.signal.aborted) return;
          if (Date.now() >= Date.parse(lab.administratorExpiresAt)) {
            fail("administrator-expired");
            return;
          }
          if (
            attack === undefined ||
            !admittedOneShotFiles(
              [{ name: "attack.json", content: attack }],
              ONE_SHOT_MAX_INPUT_BYTES,
            )
          )
            throw new Error("Setup boundary failed");
          await writeFile(join(input, "attack.tmp"), attack, {
            flag: "wx",
            mode: 0o400,
          });
          await rename(join(input, "attack.tmp"), join(input, "attack.json"));
          state.events.push({
            event: "attack-published",
            at: new Date().toISOString(),
            digest: canonicalDigest(attack),
          });
          clearTimeout(expiry);
          return;
        }
        await sleep(10, undefined, { signal: controller.signal });
      }
    } catch {
      if (!controller.signal.aborted) fail("setup-boundary");
    }
  })();
  return {
    state,
    async stop() {
      controller.abort();
      clearTimeout(expiry);
      signal.removeEventListener("abort", onAbort);
      await done;
      if (state.events.at(-1)?.event !== "attack-published") {
        state.failure ??= "setup-not-completed";
        await close().catch(() => {
          state.failure = "setup-boundary";
        });
      }
    },
  };
}
