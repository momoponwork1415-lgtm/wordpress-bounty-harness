import { X509Certificate } from "node:crypto";
import { createServer } from "node:https";
import { connect } from "node:tls";

import { describe, expect, it } from "vitest";

import { createGrantTls } from "../../src/discovery/grant-tls.js";

const handshake = (
  port: number,
  servername: string,
  ca: string,
): Promise<"trusted" | "rejected"> =>
  new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port, servername, ca }, () => {
      socket.end();
      resolve("trusted");
    });
    socket.on("error", () => resolve("rejected"));
  });

describe("per-grant broker TLS", () => {
  it("issues a one-off CA and a server certificate only for the broker name", async () => {
    const notAfter = new Date(Date.now() + 30 * 60_000);
    const tls = createGrantTls({
      hostname: "provider-egress.internal",
      notAfter,
    });
    const ca = new X509Certificate(tls.caPem);
    const leaf = new X509Certificate(tls.certPem);
    expect(ca.ca).toBe(true);
    expect(leaf.ca).toBe(false);
    expect(leaf.verify(ca.publicKey)).toBe(true);
    expect(leaf.checkHost("provider-egress.internal")).toBe(
      "provider-egress.internal",
    );
    expect(leaf.checkHost("chatgpt.com")).toBeUndefined();
    expect(new Date(leaf.validTo).getTime()).toBeLessThanOrEqual(
      notAfter.getTime() + 5 * 60_000,
    );

    const server = createServer(
      { key: tls.keyPem, cert: tls.certPem },
      (_q, r) => r.end(),
    );
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("server unavailable");
    try {
      expect(
        await handshake(address.port, "provider-egress.internal", tls.caPem),
      ).toBe("trusted");
      // Another grant's CA does not vouch for this server.
      const other = createGrantTls({
        hostname: "provider-egress.internal",
        notAfter,
      });
      expect(
        await handshake(address.port, "provider-egress.internal", other.caPem),
      ).toBe("rejected");
      expect(await handshake(address.port, "chatgpt.com", tls.caPem)).toBe(
        "rejected",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("encodes every serial number as valid DER", () => {
    for (let index = 0; index < 200; index++) {
      const tls = createGrantTls({
        hostname: "provider-egress.internal",
        notAfter: new Date(Date.now() + 60_000),
      });
      expect(() => new X509Certificate(tls.certPem)).not.toThrow();
      expect(() => new X509Certificate(tls.caPem)).not.toThrow();
    }
  });

  it("refuses a name that is not a plain DNS label sequence", () => {
    expect(() =>
      createGrantTls({ hostname: "evil.example/", notAfter: new Date() }),
    ).toThrow();
  });
});
