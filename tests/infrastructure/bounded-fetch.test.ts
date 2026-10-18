import { describe, expect, it, vi } from "vitest";

import {
  fetchBounded,
  readBoundedResponse,
  ResponseTooLargeError,
} from "../../src/infrastructure/bounded-fetch.js";

const base = {
  timeoutMs: 1_000,
  headers: { accept: "application/json" },
} as const;

describe("readBoundedResponse", () => {
  it("returns the whole body within the ceiling", async () => {
    await expect(
      readBoundedResponse(new Response("hello"), 5),
    ).resolves.toEqual(new Uint8Array(Buffer.from("hello")));
  });

  it("rejects a body over the ceiling while streaming", async () => {
    await expect(
      readBoundedResponse(new Response("hello!"), 5),
    ).rejects.toBeInstanceOf(ResponseTooLargeError);
  });

  it("rejects a declared length over the ceiling before reading", async () => {
    const response = new Response("x", { headers: { "content-length": "99" } });
    await expect(readBoundedResponse(response, 5)).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    );
  });
});

describe("fetchBounded", () => {
  it("passes the redirect policy it is given and defers the body read", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response("abc"));
    const { response, readBody } = await fetchBounded(
      fetcher,
      "https://x.test/",
      {
        ...base,
        redirect: "error",
        credentials: "omit",
        maximumBytes: 10,
      },
    );
    expect(fetcher).toHaveBeenCalledWith(
      "https://x.test/",
      expect.objectContaining({ redirect: "error", credentials: "omit" }),
    );
    expect(response.bodyUsed).toBe(false);
    await expect(readBody()).resolves.toEqual(
      new Uint8Array(Buffer.from("abc")),
    );
  });

  it("does not add a method or credentials the caller did not ask for", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response(""));
    await fetchBounded(fetcher, "https://x.test/", {
      ...base,
      redirect: "follow",
      maximumBytes: 1,
    });
    const init = fetcher.mock.calls[0]?.[1];
    expect(init).not.toHaveProperty("method");
    expect(init).not.toHaveProperty("credentials");
    expect(init).toHaveProperty("redirect", "follow");
  });
});
