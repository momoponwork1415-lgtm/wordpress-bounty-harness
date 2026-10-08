import {
  generateKeyPairSync,
  randomBytes,
  sign,
  type KeyObject,
} from "node:crypto";

/**
 * One-off TLS material for a single egress grant: a CA that exists only for
 * this grant and a server certificate for the broker's fixed name. The CLI in
 * the sandbox trusts only this CA, and the private keys never leave the broker.
 */
export interface GrantTls {
  readonly caPem: string;
  readonly certPem: string;
  readonly keyPem: string;
}

const hostnamePattern =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

// Minimal DER encoding: only the shapes an X.509 v3 certificate needs.
const der = (tag: number, body: Buffer): Buffer => {
  const length =
    body.length < 0x80
      ? Buffer.from([body.length])
      : (() => {
          const bytes: number[] = [];
          for (let value = body.length; value > 0; value >>= 8)
            bytes.unshift(value & 0xff);
          return Buffer.from([0x80 | bytes.length, ...bytes]);
        })();
  return Buffer.concat([Buffer.from([tag]), length, body]);
};
const sequence = (...items: Buffer[]) => der(0x30, Buffer.concat(items));
const set = (...items: Buffer[]) => der(0x31, Buffer.concat(items));
const explicit = (index: number, item: Buffer) => der(0xa0 + index, item);
/** Minimal two's-complement encoding of a non-negative integer. */
const integer = (bytes: Buffer) => {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start++;
  const body = bytes.subarray(start);
  return der(
    0x02,
    (body[0] ?? 0) & 0x80 ? Buffer.concat([Buffer.from([0]), body]) : body,
  );
};
const boolean = (value: boolean) => der(0x01, Buffer.from([value ? 0xff : 0]));
const octets = (bytes: Buffer) => der(0x04, bytes);
const bits = (bytes: Buffer, unused = 0) =>
  der(0x03, Buffer.concat([Buffer.from([unused]), bytes]));
const utf8 = (text: string) => der(0x0c, Buffer.from(text, "utf8"));
const oid = (dotted: string): Buffer => {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const body: number[] = [first * 40 + second];
  for (const arc of rest) {
    const chunk: number[] = [arc & 0x7f];
    for (let value = arc >> 7; value > 0; value >>= 7)
      chunk.unshift(0x80 | (value & 0x7f));
    body.push(...chunk);
  }
  return der(0x06, Buffer.from(body));
};
const utcTime = (date: Date) =>
  der(
    0x17,
    Buffer.from(
      `${date.toISOString().slice(2, 19).replace(/[-:T]/g, "")}Z`,
      "ascii",
    ),
  );
const name = (commonName: string) =>
  sequence(set(sequence(oid("2.5.4.3"), utf8(commonName))));
const extension = (id: string, critical: boolean, value: Buffer) =>
  sequence(oid(id), ...(critical ? [boolean(true)] : []), octets(value));

const ECDSA_WITH_SHA256 = sequence(oid("1.2.840.10045.4.3.2"));

function certificate(options: {
  readonly subject: string;
  readonly issuer: string;
  readonly publicKey: KeyObject;
  readonly signer: KeyObject;
  readonly notBefore: Date;
  readonly notAfter: Date;
  readonly extensions: readonly Buffer[];
}): string {
  const serial = randomBytes(16);
  serial[0] = (serial[0] ?? 0) & 0x7f;
  const tbs = sequence(
    explicit(0, integer(Buffer.from([2]))),
    integer(serial),
    ECDSA_WITH_SHA256,
    name(options.issuer),
    sequence(utcTime(options.notBefore), utcTime(options.notAfter)),
    name(options.subject),
    options.publicKey.export({ type: "spki", format: "der" }),
    explicit(3, sequence(...options.extensions)),
  );
  const signature = sign("sha256", tbs, options.signer);
  const body = sequence(tbs, ECDSA_WITH_SHA256, bits(signature))
    .toString("base64")
    .replace(/(.{64})/g, "$1\n")
    .trimEnd();
  return `-----BEGIN CERTIFICATE-----\n${body}\n-----END CERTIFICATE-----\n`;
}

export function createGrantTls(options: {
  readonly hostname: string;
  readonly notAfter: Date;
}): GrantTls {
  if (!hostnamePattern.test(options.hostname))
    throw new Error("Broker TLS name is invalid");
  const notBefore = new Date(Date.now() - 5 * 60_000);
  const notAfter = new Date(options.notAfter.getTime() + 5 * 60_000);
  if (!(notAfter.getTime() > notBefore.getTime()))
    throw new Error("Broker TLS validity is invalid");
  const ca = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const server = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const caName = `wbh egress grant CA ${randomBytes(6).toString("hex")}`;
  const caPem = certificate({
    subject: caName,
    issuer: caName,
    publicKey: ca.publicKey,
    signer: ca.privateKey,
    notBefore,
    notAfter,
    extensions: [
      extension("2.5.29.19", true, sequence(boolean(true))),
      // keyCertSign only.
      extension("2.5.29.15", true, bits(Buffer.from([0x04]), 2)),
    ],
  });
  const certPem = certificate({
    subject: options.hostname,
    issuer: caName,
    publicKey: server.publicKey,
    signer: ca.privateKey,
    notBefore,
    notAfter,
    extensions: [
      extension("2.5.29.19", true, sequence()),
      // digitalSignature only.
      extension("2.5.29.15", true, bits(Buffer.from([0x80]), 7)),
      extension("2.5.29.37", false, sequence(oid("1.3.6.1.5.5.7.3.1"))),
      extension(
        "2.5.29.17",
        false,
        sequence(der(0x82, Buffer.from(options.hostname, "ascii"))),
      ),
    ],
  });
  return {
    caPem,
    certPem,
    keyPem: server.privateKey
      .export({ type: "pkcs8", format: "pem" })
      .toString(),
  };
}
