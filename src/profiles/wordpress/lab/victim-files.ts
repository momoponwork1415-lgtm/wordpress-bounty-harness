import { createHash } from "node:crypto";

/**
 * Files the Lab observer may put into a victim page's file input (#468). The
 * Harness owns every byte: a route names a fixture, never content, so the
 * observer acting as the victim after `setup-done` cannot carry what the
 * Verifier wrote (ADR 0035).
 */
export const MAX_VICTIM_FILE_BYTES = 64 * 1024;

const fixtures = {
  /** An 8x8 white PNG. */
  "image-png": {
    extension: "png",
    mimeType: "image/png",
    base64:
      "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAFUlEQVR42mP8//8/AzbAxIADDE4JAFbUAw3/dxQWAAAAAElFTkSuQmCC",
  },
  /** An 8x8 white JPEG. */
  "image-jpeg": {
    extension: "jpg",
    mimeType: "image/jpeg",
    base64:
      "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAIAAgDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD9U6KKKAP/2Q==",
  },
  /** One line of plain text. */
  "text-plain": {
    extension: "txt",
    mimeType: "text/plain",
    base64: Buffer.from("Harness fixture file.\n", "utf8").toString("base64"),
  },
} as const;

export type WordPressVictimFileFixture = keyof typeof fixtures;
export const WORDPRESS_VICTIM_FILE_FIXTURES = Object.keys(fixtures) as [
  WordPressVictimFileFixture,
  ...WordPressVictimFileFixture[],
];

/** A name the observer gives the file; its extension is the fixture's. */
export function victimFileNameFits(
  fixture: WordPressVictimFileFixture,
  fileName: string,
): boolean {
  return fileName.toLowerCase().endsWith(`.${fixtures[fixture].extension}`);
}

export interface WordPressVictimFile {
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: Buffer;
  readonly sha256: string;
}

export function victimFile(
  fixture: WordPressVictimFileFixture,
  fileName?: string,
): WordPressVictimFile {
  const { extension, mimeType, base64 } = fixtures[fixture];
  const bytes = Buffer.from(base64, "base64");
  if (bytes.length === 0 || bytes.length > MAX_VICTIM_FILE_BYTES)
    throw new Error("Victim file fixture exceeds the size limit");
  return {
    name: fileName ?? `wbh-fixture.${extension}`,
    mimeType,
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}
