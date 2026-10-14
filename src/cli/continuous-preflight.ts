import type { CliInventoryReport } from "./index.js";

/** A parent may start on the first page only when its listing pool is sealed. */
export function assertInitialContinuousInventory(
  inventory: Pick<CliInventoryReport, "source" | "sourcePoolSealed">,
): void {
  if (
    inventory.source.status !== "available" ||
    inventory.source.requestedListingCoverage !== "all-observed" ||
    !inventory.sourcePoolSealed
  )
    throw new Error("Initial candidate inventory is unverified");
}
