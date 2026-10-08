import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";

import Database from "better-sqlite3";
import { z } from "zod";

import {
  wordfenceSecretRefSchema,
  type HostPrivateCredentialBroker,
  type OpenSqliteHostPrivateCredentialBrokerOptions,
  type WordfenceSecretRef,
} from "./contracts.js";
import { currentOwnerUid } from "./owner-identity.js";

const expectedSecretRef = "wordfence-v3-api-key";
const expectedProvider = "wordfence";
const expectedPurpose = "wordfence-intelligence-v3-production-feed";

const credentialRowSchema = z.strictObject({
  ref_id: z.literal(expectedSecretRef),
  provider: z.literal(expectedProvider),
  purpose: z.literal(expectedPurpose),
  secret_value: z.string().min(1),
});

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}

function isOwnedByCurrentUser(uid: number): boolean {
  const currentUid = currentOwnerUid();
  return currentUid !== undefined && uid === currentUid;
}

async function requireHostPrivateRegularFile(
  path: string,
  optional: boolean,
): Promise<void> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (optional && hasErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  if (
    !metadata.isFile() ||
    !isOwnedByCurrentUser(metadata.uid) ||
    (metadata.mode & 0o777) !== 0o600
  ) {
    throw new Error("Credential broker storage is not host-private");
  }
}

async function requireHostPrivateBrokerStorage(path: string): Promise<void> {
  const parent = dirname(path);
  const parentMetadata = await lstat(parent);
  if (
    !parentMetadata.isDirectory() ||
    !isOwnedByCurrentUser(parentMetadata.uid) ||
    (parentMetadata.mode & 0o777) !== 0o700 ||
    (await realpath(parent)) !== resolve(parent)
  ) {
    throw new Error("Credential broker storage is not host-private");
  }
  await requireHostPrivateRegularFile(path, false);
  await requireHostPrivateRegularFile(`${path}-wal`, true);
  await requireHostPrivateRegularFile(`${path}-shm`, true);
}

class SqliteHostPrivateCredentialBroker implements HostPrivateCredentialBroker {
  readonly #databasePath: string;

  constructor(options: OpenSqliteHostPrivateCredentialBrokerOptions) {
    if (!isAbsolute(options.databasePath)) {
      throw new Error("Credential broker database path must be absolute");
    }
    this.#databasePath = options.databasePath;
  }

  async resolve<T>(
    referenceValue: WordfenceSecretRef,
    use: (credential: string) => Promise<T>,
  ): Promise<T> {
    const reference = wordfenceSecretRefSchema.parse(referenceValue);
    if (reference.id !== expectedSecretRef) {
      throw new Error("Host-private credential is unavailable");
    }
    let credential: string;
    let database: Database.Database | undefined;
    try {
      if (currentOwnerUid() === undefined) {
        throw new Error("Current owner identity is unavailable");
      }
      await requireHostPrivateBrokerStorage(this.#databasePath);
      database = new Database(this.#databasePath, {
        readonly: true,
        fileMustExist: true,
      });
      const parsed = credentialRowSchema.safeParse(
        database
          .prepare(
            `SELECT ref_id, provider, purpose, secret_value
               FROM secret_values
              WHERE ref_id = ?`,
          )
          .get(reference.id),
      );
      if (!parsed.success) {
        throw new Error("Credential broker row is invalid");
      }
      credential = parsed.data.secret_value;
    } catch {
      throw new Error("Host-private credential is unavailable");
    } finally {
      database?.close();
    }
    return use(credential);
  }
}

export function openSqliteHostPrivateCredentialBroker(
  options: OpenSqliteHostPrivateCredentialBrokerOptions,
): HostPrivateCredentialBroker {
  return new SqliteHostPrivateCredentialBroker(options);
}
