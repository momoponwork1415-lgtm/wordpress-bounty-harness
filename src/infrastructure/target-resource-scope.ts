import { AsyncLocalStorage } from "node:async_hooks";

type Scope = { cleanupUncertain: boolean };

/** Keeps cleanup uncertainty isolated when one campaign runs targets in parallel. */
export class TargetResourceScope {
  readonly #storage = new AsyncLocalStorage<Scope>();

  run<T>(operation: () => Promise<T>): Promise<T> {
    return this.#storage.run({ cleanupUncertain: false }, operation);
  }

  markCleanupUncertain(): void {
    const scope = this.#storage.getStore();
    if (scope !== undefined) scope.cleanupUncertain = true;
  }

  isCleanupUncertain(): boolean {
    return this.#storage.getStore()?.cleanupUncertain ?? false;
  }
}
