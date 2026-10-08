import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, lstatSync, type Stats } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

import Database from "better-sqlite3";

import { currentOwnerUid } from "./owner-identity.js";
import {
  SnapshotConflictError,
  requireProductionStorageFormat,
} from "./storage-format.js";

class ArtifactConflictError extends Error {
  constructor() {
    super("Wordfence Intelligence artifact conflict");
    this.name = "ArtifactConflictError";
  }
}

export class HostPrivateStorageError extends Error {
  readonly code = "EACCES";

  constructor() {
    super("Wordfence Intelligence storage is not host-private");
    this.name = "HostPrivateStorageError";
  }
}

async function useFileHandle<T>(
  handle: FileHandle,
  operation: (selected: FileHandle) => Promise<T>,
): Promise<T> {
  let result: T;
  try {
    result = await operation(handle);
  } catch (error) {
    try {
      await handle.close();
    } catch {
      // Preserve the primary operation failure.
    }
    throw error;
  }
  await handle.close();
  return result;
}

const storageFailureCodes = new Set([
  "EACCES",
  "EBUSY",
  "EDQUOT",
  "EIO",
  "EISDIR",
  "ELOOP",
  "EEXIST",
  "EMFILE",
  "ENAMETOOLONG",
  "ENOENT",
  "ENFILE",
  "ENOMEM",
  "ENOSPC",
  "ENOTDIR",
  "EPERM",
  "EROFS",
  "SQLITE_BUSY",
  "SQLITE_CANTOPEN",
  "SQLITE_FULL",
  "SQLITE_LOCKED",
  "SQLITE_NOMEM",
  "SQLITE_PERM",
  "SQLITE_READONLY",
]);

export function isStorageFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = error.code;
  return (
    typeof code === "string" &&
    (storageFailureCodes.has(code) || code.startsWith("SQLITE_IOERR"))
  );
}

export function rawDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function selectedPathMetadataSynchronously(
  path: string,
): Stats | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

export function requireMatchingRegularFileMetadata(
  expected: Stats,
  selected: Stats | undefined,
): Stats {
  if (
    !expected.isFile() ||
    selected === undefined ||
    !selected.isFile() ||
    expected.dev !== selected.dev ||
    expected.ino !== selected.ino
  ) {
    throw new HostPrivateStorageError();
  }
  return selected;
}

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

async function requireRealDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory()) {
    throw new HostPrivateStorageError();
  }
}

async function createDirectoryPathWithoutSymlinks(path: string): Promise<void> {
  const absolutePath = resolve(path);
  const root = parse(absolutePath).root;
  const remainder = relative(root, absolutePath);
  if (remainder.length === 0) {
    throw new HostPrivateStorageError();
  }
  let current = root;
  for (const component of remainder.split(sep)) {
    current = join(current, component);
    try {
      await requireRealDirectory(current);
      continue;
    } catch (error) {
      if (!hasErrorCode(error, "ENOENT")) {
        throw error;
      }
    }
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
    }
    await requireRealDirectory(current);
  }
}

async function secureHostPrivateDirectory(path: string): Promise<void> {
  if (!isAbsolute(path)) {
    throw new HostPrivateStorageError();
  }
  await createDirectoryPathWithoutSymlinks(path);
  if ((await realpath(path)) !== resolve(path)) {
    throw new HostPrivateStorageError();
  }
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isDirectory() || !isOwnedByCurrentUser(metadata.uid)) {
      throw new HostPrivateStorageError();
    }
    await handle.chmod(0o700);
    const secured = await handle.stat();
    if (!secured.isDirectory() || (secured.mode & 0o077) !== 0) {
      throw new HostPrivateStorageError();
    }
  } finally {
    await handle.close();
  }
}

export interface PinnedHostPrivateDirectory {
  readonly device: number;
  readonly handle: FileHandle;
  readonly inode: number;
  readonly path: string;
}

export interface HostPrivateFileIdentity {
  readonly device: number;
  readonly inode: number;
}

interface PinnedSqliteInspection<T> {
  readonly identity: HostPrivateFileIdentity;
  readonly value: T;
}

export interface ProductionIndexIdentity {
  readonly database: HostPrivateFileIdentity;
  readonly directory: HostPrivateFileIdentity;
  readonly shm: HostPrivateFileIdentity | undefined;
  readonly wal: HostPrivateFileIdentity | undefined;
}

interface PreparedProductionStorage {
  readonly indexIdentity: ProductionIndexIdentity;
  readonly mode: "new-production" | "production";
}

function requireHostPrivateDirectoryMetadata(metadata: Stats): void {
  if (
    !metadata.isDirectory() ||
    !isOwnedByCurrentUser(metadata.uid) ||
    (metadata.mode & 0o777) !== 0o700
  ) {
    throw new HostPrivateStorageError();
  }
}

async function requireHostPrivateDirectorySelection(
  path: string,
): Promise<void> {
  if (!isAbsolute(path)) {
    throw new HostPrivateStorageError();
  }
  requireHostPrivateDirectoryMetadata(await lstat(path));
  if ((await realpath(path)) !== resolve(path)) {
    throw new HostPrivateStorageError();
  }
}

async function requirePinnedHostPrivateDirectory(
  directory: PinnedHostPrivateDirectory,
): Promise<void> {
  const pinnedMetadata = await directory.handle.stat();
  requireHostPrivateDirectoryMetadata(pinnedMetadata);
  if (
    pinnedMetadata.dev !== directory.device ||
    pinnedMetadata.ino !== directory.inode ||
    (await realpath(directory.path)) !== directory.path
  ) {
    throw new HostPrivateStorageError();
  }
  const selectedHandle = await open(
    directory.path,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const selectedMetadata = await selectedHandle.stat();
    requireHostPrivateDirectoryMetadata(selectedMetadata);
    if (
      selectedMetadata.dev !== directory.device ||
      selectedMetadata.ino !== directory.inode
    ) {
      throw new HostPrivateStorageError();
    }
  } finally {
    await selectedHandle.close();
  }
}

async function openPinnedHostPrivateDirectory(
  path: string,
): Promise<PinnedHostPrivateDirectory> {
  if (!isAbsolute(path)) {
    throw new HostPrivateStorageError();
  }
  const normalizedPath = resolve(path);
  await requireHostPrivateDirectorySelection(path);
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    requireHostPrivateDirectoryMetadata(metadata);
    const directory = {
      device: metadata.dev,
      handle,
      inode: metadata.ino,
      path: normalizedPath,
    };
    await requirePinnedHostPrivateDirectory(directory);
    return directory;
  } catch (error) {
    await handle.close();
    throw error;
  }
}

async function requireHostPrivateDirectory(path: string): Promise<void> {
  const directory = await openPinnedHostPrivateDirectory(path);
  await directory.handle.close();
}

async function selectedPathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

async function openHostPrivateRegularFile(path: string, create: boolean) {
  const existingFlags = fsConstants.O_RDWR | fsConstants.O_NOFOLLOW;
  try {
    return await open(path, existingFlags);
  } catch (error) {
    if (!create || !hasErrorCode(error, "ENOENT")) {
      throw error;
    }
  }
  try {
    return await open(
      path,
      existingFlags | fsConstants.O_CREAT | fsConstants.O_EXCL,
      0o600,
    );
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) {
      throw error;
    }
    return open(path, existingFlags);
  }
}

async function secureHostPrivateRegularFile(
  path: string,
  create: boolean,
): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await openHostPrivateRegularFile(path, create);
  } catch (error) {
    if (!create && hasErrorCode(error, "ENOENT")) {
      return;
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || !isOwnedByCurrentUser(metadata.uid)) {
      throw new HostPrivateStorageError();
    }
    await handle.chmod(0o600);
    const secured = await handle.stat();
    if (!secured.isFile() || (secured.mode & 0o077) !== 0) {
      throw new HostPrivateStorageError();
    }
  } finally {
    await handle.close();
  }
}

async function inspectPinnedSqlite<T>(
  path: string,
  inspection: (database: Database.Database) => T,
): Promise<PinnedSqliteInspection<T>> {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (!before.isFile() || !isOwnedByCurrentUser(before.uid)) {
      throw new HostPrivateStorageError();
    }
    let database: Database.Database | undefined;
    try {
      database = new Database(`/proc/self/fd/${handle.fd}`, {
        fileMustExist: true,
        readonly: true,
      });
      const result = inspection(database);
      const after = await handle.stat();
      if (
        !after.isFile() ||
        !isOwnedByCurrentUser(after.uid) ||
        after.dev !== before.dev ||
        after.ino !== before.ino
      ) {
        throw new HostPrivateStorageError();
      }
      return {
        identity: { device: after.dev, inode: after.ino },
        value: result,
      };
    } catch (error) {
      if (
        error instanceof SnapshotConflictError ||
        error instanceof HostPrivateStorageError
      ) {
        throw error;
      }
      throw new SnapshotConflictError();
    } finally {
      database?.close();
    }
  } finally {
    await handle.close();
  }
}

async function prepareHostPrivateSqliteStorage(path: string): Promise<void> {
  if (!isAbsolute(path)) {
    throw new HostPrivateStorageError();
  }
  await secureHostPrivateDirectory(dirname(path));
  await secureHostPrivateRegularFile(path, true);
}

export async function secureCreatedSqliteSidecars(
  path: string,
  prepared: ProductionIndexIdentity,
): Promise<void> {
  if (prepared.wal === undefined) {
    await secureHostPrivateRegularFile(`${path}-wal`, false);
  }
  if (prepared.shm === undefined) {
    await secureHostPrivateRegularFile(`${path}-shm`, false);
  }
}

async function hostPrivateRegularFileIdentity(
  path: string,
  optional = false,
): Promise<HostPrivateFileIdentity | undefined> {
  const selectedMetadata = await hostPrivateRegularFileSelection(
    path,
    optional,
  );
  if (selectedMetadata === undefined) {
    return undefined;
  }
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    if (optional && hasErrorCode(error, "ENOENT")) {
      return undefined;
    }
    if (hasErrorCode(error, "ELOOP")) {
      throw new HostPrivateStorageError();
    }
    throw error;
  }
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      !isOwnedByCurrentUser(metadata.uid) ||
      (metadata.mode & 0o777) !== 0o600 ||
      metadata.dev !== selectedMetadata.dev ||
      metadata.ino !== selectedMetadata.ino
    ) {
      throw new HostPrivateStorageError();
    }
    return { device: metadata.dev, inode: metadata.ino };
  } finally {
    await handle.close();
  }
}

async function hostPrivateRegularFileSelection(
  path: string,
  optional = false,
): Promise<Stats | undefined> {
  let metadata: Stats;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (optional && hasErrorCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
  if (
    !metadata.isFile() ||
    !isOwnedByCurrentUser(metadata.uid) ||
    (metadata.mode & 0o777) !== 0o600
  ) {
    throw new HostPrivateStorageError();
  }
  return metadata;
}

export function sameFileIdentity(
  left: HostPrivateFileIdentity | undefined,
  right: HostPrivateFileIdentity | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.device === right.device &&
    left.inode === right.inode
  );
}

export function requirePreparedIndexIdentity(
  prepared: ProductionIndexIdentity,
  opened: ProductionIndexIdentity,
): void {
  if (
    !sameFileIdentity(prepared.directory, opened.directory) ||
    !sameFileIdentity(prepared.database, opened.database) ||
    (prepared.wal !== undefined &&
      !sameFileIdentity(prepared.wal, opened.wal)) ||
    (prepared.shm !== undefined && !sameFileIdentity(prepared.shm, opened.shm))
  ) {
    throw new HostPrivateStorageError();
  }
}

function requireMatchingIndexIdentity(
  expected: ProductionIndexIdentity,
  selected: ProductionIndexIdentity,
): void {
  if (
    !sameFileIdentity(expected.directory, selected.directory) ||
    !sameFileIdentity(expected.database, selected.database) ||
    !sameFileIdentity(expected.wal, selected.wal) ||
    !sameFileIdentity(expected.shm, selected.shm)
  ) {
    throw new HostPrivateStorageError();
  }
}

export async function productionIndexIdentity(
  databasePath: string,
  requireSidecars: boolean,
): Promise<ProductionIndexIdentity> {
  const indexDirectory = await openPinnedHostPrivateDirectory(
    dirname(databasePath),
  );
  try {
    const database = await hostPrivateRegularFileIdentity(databasePath);
    const wal = await hostPrivateRegularFileIdentity(
      `${databasePath}-wal`,
      !requireSidecars,
    );
    const shm = await hostPrivateRegularFileIdentity(
      `${databasePath}-shm`,
      !requireSidecars,
    );
    if (
      database === undefined ||
      (requireSidecars && (wal === undefined || shm === undefined))
    ) {
      throw new HostPrivateStorageError();
    }
    return {
      database,
      directory: {
        device: indexDirectory.device,
        inode: indexDirectory.inode,
      },
      shm,
      wal,
    };
  } finally {
    await indexDirectory.handle.close();
  }
}

export async function prepareProductionStorage(
  databasePath: string,
  artifactDirectory: string,
): Promise<PreparedProductionStorage> {
  const rawDirectory = join(artifactDirectory, "wordfence-intelligence-v3");
  const databaseExists = await selectedPathExists(databasePath);
  const walExists = await selectedPathExists(`${databasePath}-wal`);
  const shmExists = await selectedPathExists(`${databasePath}-shm`);
  const rawDirectoryExists = await selectedPathExists(rawDirectory);

  if (!databaseExists) {
    if (walExists || shmExists) {
      throw new HostPrivateStorageError();
    }
    if (rawDirectoryExists) {
      await requireHostPrivateDirectorySelection(rawDirectory);
    }
    await prepareHostPrivateSqliteStorage(databasePath);
    if (rawDirectoryExists) {
      await requireHostPrivateDirectory(rawDirectory);
    } else {
      await secureHostPrivateDirectory(rawDirectory);
    }
    return {
      indexIdentity: await productionIndexIdentity(databasePath, false),
      mode: "new-production",
    };
  }

  if (!rawDirectoryExists) {
    throw new HostPrivateStorageError();
  }
  await requireHostPrivateDirectorySelection(dirname(databasePath));
  await hostPrivateRegularFileSelection(databasePath);
  await hostPrivateRegularFileSelection(`${databasePath}-wal`, true);
  await hostPrivateRegularFileSelection(`${databasePath}-shm`, true);
  await requireHostPrivateDirectorySelection(rawDirectory);
  await inspectPinnedSqlite(databasePath, (database) => {
    requireProductionStorageFormat(database);
  });
  return {
    indexIdentity: await productionIndexIdentity(databasePath, false),
    mode: "production",
  };
}

export async function requireProductionStorage(
  databasePath: string,
  artifactDirectory: string,
  expectedIndexIdentity: ProductionIndexIdentity,
): Promise<{
  readonly artifactDirectory: PinnedHostPrivateDirectory;
  readonly indexIdentity: ProductionIndexIdentity;
}> {
  const indexIdentity = await productionIndexIdentity(databasePath, true);
  requireMatchingIndexIdentity(expectedIndexIdentity, indexIdentity);
  return {
    artifactDirectory: await openPinnedHostPrivateDirectory(
      join(artifactDirectory, "wordfence-intelligence-v3"),
    ),
    indexIdentity,
  };
}

export async function requireProductionIndexIdentity(
  databasePath: string,
  expectedIndexIdentity: ProductionIndexIdentity,
): Promise<void> {
  const selectedIndexIdentity = await productionIndexIdentity(
    databasePath,
    true,
  );
  requireMatchingIndexIdentity(expectedIndexIdentity, selectedIndexIdentity);
}

async function verifyHostPrivateArtifact(
  path: string,
  bytes: Uint8Array,
  requireHostPrivateMode: boolean,
): Promise<void> {
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    if (hasErrorCode(error, "ELOOP")) {
      throw new ArtifactConflictError();
    }
    throw error;
  }
  await useFileHandle(handle, async (selected) => {
    const metadata = await selected.stat();
    if (
      !metadata.isFile() ||
      (requireHostPrivateMode &&
        (!isOwnedByCurrentUser(metadata.uid) ||
          (metadata.mode & 0o777) !== 0o400))
    ) {
      throw new ArtifactConflictError();
    }
    const existing = await selected.readFile();
    if (!existing.equals(bytes)) {
      throw new ArtifactConflictError();
    }
  });
}

export async function verifyStoredArtifact(
  directory: PinnedHostPrivateDirectory,
  contentDigest: string,
): Promise<void> {
  await requirePinnedHostPrivateDirectory(directory);
  let handle: FileHandle;
  try {
    handle = await open(
      join(
        `/proc/self/fd/${directory.handle.fd}`,
        `${contentDigest.slice("sha256:".length)}.json`,
      ),
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    if (hasErrorCode(error, "ELOOP")) {
      throw new ArtifactConflictError();
    }
    throw error;
  }
  await useFileHandle(handle, async (selected) => {
    const metadata = await selected.stat();
    if (
      !metadata.isFile() ||
      !isOwnedByCurrentUser(metadata.uid) ||
      (metadata.mode & 0o777) !== 0o400
    ) {
      throw new ArtifactConflictError();
    }
    if (rawDigest(await selected.readFile()) !== contentDigest) {
      throw new ArtifactConflictError();
    }
  });
  await requirePinnedHostPrivateDirectory(directory);
}

export async function persistBytes(
  path: string,
  bytes: Uint8Array,
  pinnedDirectory?: PinnedHostPrivateDirectory,
): Promise<void> {
  const directory = dirname(path);
  if (
    pinnedDirectory !== undefined &&
    resolve(directory) !== pinnedDirectory.path
  ) {
    throw new HostPrivateStorageError();
  }
  if (pinnedDirectory !== undefined) {
    await requirePinnedHostPrivateDirectory(pinnedDirectory);
  }
  const operationDirectory =
    pinnedDirectory === undefined
      ? directory
      : `/proc/self/fd/${pinnedDirectory.handle.fd}`;
  const finalPath = join(operationDirectory, basename(path));
  const temporaryPath = join(
    operationDirectory,
    `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`,
  );
  const directoryHandle =
    pinnedDirectory?.handle ??
    (await open(
      directory,
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
    ));
  const ownsDirectoryHandle = pinnedDirectory === undefined;
  let ownsTemporaryPath = false;
  let operationError: unknown;
  let operationFailed = false;
  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    ownsTemporaryPath = true;
    await useFileHandle(handle, async (selected) => {
      await selected.writeFile(bytes);
      await selected.sync();
      await selected.chmod(0o400);
      await selected.sync();
    });
    try {
      await link(temporaryPath, finalPath);
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) {
        throw error;
      }
    }
    await verifyHostPrivateArtifact(
      finalPath,
      bytes,
      pinnedDirectory !== undefined,
    );
  } catch (error) {
    operationFailed = true;
    operationError = error;
  } finally {
    let finalizationError: unknown;
    if (ownsTemporaryPath) {
      try {
        await unlink(temporaryPath);
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) {
          finalizationError = error;
        }
      }
    }
    try {
      await directoryHandle.sync();
    } catch (error) {
      finalizationError ??= error;
    }
    if (ownsDirectoryHandle) {
      try {
        await directoryHandle.close();
      } catch (error) {
        finalizationError ??= error;
      }
    }
    if (pinnedDirectory !== undefined) {
      try {
        await requirePinnedHostPrivateDirectory(pinnedDirectory);
      } catch (error) {
        finalizationError ??= error;
      }
    }
    if (operationFailed) {
      throw operationError;
    }
    if (finalizationError !== undefined) {
      throw finalizationError;
    }
  }
}
