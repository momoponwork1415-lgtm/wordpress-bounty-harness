import type { LabHandle, TrialLab } from "../../src/lab/index.js";

/**
 * A ready exploration Lab that answers nothing and seals an empty record, for
 * pipeline tests whose subject is not the Lab. Every Trial has one (owner
 * decision 2026-11-05: `discovery.lab: none` was removed).
 */
export function fakeExplorationLab(setupDigest: string) {
  let labs = 0;
  return {
    lab: {
      provision: async (snapshot: unknown) => ({
        status: "ready" as const,
        handle: {
          id: `00000000-0000-4000-8000-${String(++labs).padStart(12, "0")}`,
          snapshotDigest: (snapshot as { digest: string }).digest,
          setupDigest,
          endpoint: "http://wordpress",
        },
      }),
      teardown: async () => ({ status: "removed" as const }),
    },
    explorationLab: (handle: LabHandle): TrialLab => ({
      labId: handle.id,
      open: async () => {},
      seal: async () => ({
        requests: 0,
        droppedRequests: 0,
        resets: 0,
        refusedResets: 0,
        droppedAnswers: 0,
        observations: 0,
        refusedObservations: 0,
      }),
    }),
  };
}
