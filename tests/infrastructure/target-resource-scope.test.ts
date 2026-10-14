import { expect, it } from "vitest";

import { TargetResourceScope } from "../../src/infrastructure/target-resource-scope.js";

it("keeps cleanup uncertainty within the target that observed it", async () => {
  const scope = new TargetResourceScope();
  let releaseOther!: () => void;
  const otherStarted = new Promise<void>((resolve) => {
    releaseOther = resolve;
  });
  const results = await Promise.all([
    scope.run(async () => {
      scope.markCleanupUncertain();
      releaseOther();
      await Promise.resolve();
      return scope.isCleanupUncertain();
    }),
    scope.run(async () => {
      await otherStarted;
      return scope.isCleanupUncertain();
    }),
  ]);
  expect(results).toEqual([true, false]);
  expect(scope.isCleanupUncertain()).toBe(false);
});
