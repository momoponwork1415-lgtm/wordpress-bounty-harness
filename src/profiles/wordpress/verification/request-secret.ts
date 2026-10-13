/** A request that carried a Lab secret cannot establish unauthorized disclosure. */
export function requestContainsSecret(value: unknown, secret: string): boolean {
  const raw = JSON.stringify(value ?? null);
  if (raw.includes(secret)) return true;
  const decoded = raw.replace(/(?:%[0-9a-fA-F]{2})+/g, (part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  if (decoded.includes(secret)) return true;
  for (const source of [raw, decoded]) {
    for (const token of source.match(/[A-Za-z0-9+/]{16,}={0,2}/g) ?? [])
      if (Buffer.from(token, "base64").toString("utf8").includes(secret))
        return true;
    for (const token of source.match(/[a-fA-F0-9]{16,}/g) ?? [])
      if (Buffer.from(token, "hex").toString("utf8").includes(secret))
        return true;
  }
  return false;
}
