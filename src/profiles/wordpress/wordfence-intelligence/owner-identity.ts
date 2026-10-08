export function currentOwnerUid(): number | undefined {
  return process.getuid?.();
}
