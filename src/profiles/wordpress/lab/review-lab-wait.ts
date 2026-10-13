/** Keeps a human review Lab alive until a signal or explicit close releases it. */
export function createReviewLabWaiter(): {
  wait(): Promise<void>;
  release(): void;
} {
  let finished = false;
  let pending: Promise<void> | undefined;
  let finishPending: (() => void) | undefined;

  return {
    wait() {
      if (finished) return Promise.resolve();
      if (pending !== undefined) return pending;
      pending = new Promise<void>((resolve) => {
        // Signal listeners alone do not keep Node's event loop alive.
        const keepAlive = setInterval(() => undefined, 60_000);
        const finish = () => {
          clearInterval(keepAlive);
          process.off("SIGINT", finish);
          process.off("SIGTERM", finish);
          finishPending = undefined;
          finished = true;
          resolve();
        };
        finishPending = finish;
        process.once("SIGINT", finish);
        process.once("SIGTERM", finish);
      });
      return pending;
    },
    release() {
      if (finished) return;
      if (finishPending === undefined) finished = true;
      else finishPending();
    },
  };
}
