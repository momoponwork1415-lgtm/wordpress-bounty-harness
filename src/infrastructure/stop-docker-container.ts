/** Stop a named Docker container even when its attached `docker run` client is gone. */
export async function stopDockerContainer(
  run: (
    args: readonly string[],
    timeoutMs: number,
  ) => Promise<{ readonly exitCode: number }>,
  name: string,
): Promise<void> {
  try {
    const stopped = await run(["stop", "-t", "10", name], 12_000);
    if (stopped.exitCode === 0) return;
  } catch {
    // A timed-out stop still needs an explicit daemon-side kill.
  }
  const killed = await run(["kill", name], 5_000);
  if (killed.exitCode !== 0) throw new Error("Docker container did not stop");
}
