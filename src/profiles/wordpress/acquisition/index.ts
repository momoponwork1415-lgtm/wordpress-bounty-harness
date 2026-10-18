// Only what code outside this folder (src and tests) imports. Everything else
// is reached through the module that owns it.
export type { TargetIntakePacket, TargetIntakePolicy } from "./contracts.js";
export {
  acquiredSourceFromIntakePacket,
  openLocalDirectoryTargetIntake,
} from "./local-directory-target-intake.js";
export { wordPressOrgTargetObservationRefSchema } from "./wordpress-org-contracts.js";
export type {
  WordPressOrgSourceAdapter,
  WordPressOrgTargetObservation,
  WordPressOrgTargetObservationRef,
  WordPressOrgTargetSource,
} from "./wordpress-org-contracts.js";
export {
  createWordPressOrgFetchAdapter,
  openWordPressOrgTargetSource,
} from "./wordpress-org-target-source.js";
export { openWordPressOrgSnapshotSource } from "./snapshot-source.js";
export {
  openWordPressOrgPluginDependencySource,
  requiredPluginSlugs,
} from "./plugin-dependency-source.js";
export {
  acquirePinnedWordPressOrgSvnSource,
  capturedWordPressOrgSvnPinSchema,
  openCapturedWordPressOrgSvnSource,
} from "./pinned-svn-source.js";
export type { CapturedWordPressOrgSvnPin } from "./pinned-svn-source.js";
export { openMaterializedSources } from "./materialized-sources.js";
export { openWordPressCoreSource } from "./wordpress-core-source.js";
export { openPhpRuntimeSource } from "./php-runtime-source.js";
