import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute } from "node:path";

/** Reads a host-private file: absolute, not a link, owner-only, single-linked. */
async function readPrivateFile(path: string): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new Error("credential path is unavailable");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    const expectedUid =
      typeof process.getuid === "function" ? process.getuid() : undefined;
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      (metadata.mode & 0o077) !== 0 ||
      (expectedUid !== undefined && metadata.uid !== expectedUid) ||
      metadata.size <= 0 ||
      metadata.size > 16_384
    ) {
      throw new Error("credential file is unavailable");
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

export async function readPrivateProviderCredential(
  path: string,
): Promise<string> {
  const value = (await readPrivateFile(path)).trim();
  if (value.length < 8 || value.length > 16_384 || /[\0\r\n]/u.test(value)) {
    throw new Error("credential value is unavailable");
  }
  return value;
}

/** The parts of a Codex CLI ChatGPT login the egress broker forwards. */
export interface PrivateChatgptLogin {
  readonly accessToken: string;
  readonly accountId: string;
  readonly expiresAt: Date;
}

const tokenPattern = /^[A-Za-z0-9._~+/=-]{8,16384}$/u;

function accessTokenExpiry(accessToken: string): number | undefined {
  const payload = accessToken.split(".")[1];
  if (payload === undefined) return undefined;
  try {
    const claims = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    ) as unknown;
    return typeof claims === "object" &&
      claims !== null &&
      "exp" in claims &&
      typeof claims.exp === "number" &&
      Number.isFinite(claims.exp)
      ? claims.exp * 1000
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads the Codex CLI `auth.json` of a ChatGPT login. The access token must
 * outlive the grant; this broker does not refresh it, so an expiring login is
 * an unavailable credential rather than a mid-run failure.
 */
export async function readPrivateChatgptLogin(
  path: string,
  mustOutlive: Date,
): Promise<PrivateChatgptLogin> {
  let file: unknown;
  try {
    file = JSON.parse(await readPrivateFile(path)) as unknown;
  } catch {
    throw new Error("credential value is unavailable");
  }
  const tokens =
    typeof file === "object" && file !== null && "tokens" in file
      ? file.tokens
      : undefined;
  if (
    typeof file !== "object" ||
    file === null ||
    ("auth_mode" in file && file.auth_mode !== "chatgpt") ||
    ("OPENAI_API_KEY" in file && file.OPENAI_API_KEY !== null) ||
    typeof tokens !== "object" ||
    tokens === null ||
    !("access_token" in tokens) ||
    typeof tokens.access_token !== "string" ||
    !tokenPattern.test(tokens.access_token) ||
    !("account_id" in tokens) ||
    typeof tokens.account_id !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(tokens.account_id)
  ) {
    throw new Error("credential value is unavailable");
  }
  const expiry = accessTokenExpiry(tokens.access_token);
  if (expiry === undefined || expiry <= mustOutlive.getTime()) {
    throw new Error("credential is expired");
  }
  return {
    accessToken: tokens.access_token,
    accountId: tokens.account_id,
    expiresAt: new Date(expiry),
  };
}
