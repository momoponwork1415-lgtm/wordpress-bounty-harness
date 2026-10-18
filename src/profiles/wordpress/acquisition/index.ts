export {
  intakeDispositionSchema,
  intakeReceiptSchema,
  manualTargetIntakeRequestSchema,
  readyIntakeDispositionSchema,
  targetIntakePacketSchema,
  targetIntakePolicySchema,
  targetIntakeReasonSchema,
} from "./contracts.js";
export type {
  IntakeDisposition,
  IntakeReceipt,
  ManualTargetIntakeRequest,
  ReadyIntakeDisposition,
  TargetIntake,
  TargetIntakePolicy,
  TargetIntakePacket,
  TargetIntakeReason,
} from "./contracts.js";
export { openLocalDirectoryTargetIntake } from "./local-directory-target-intake.js";
export {
  wordPressOrgAcquireRequestSchema,
  wordPressOrgAcquisitionOriginalSchema,
  wordPressOrgObserveRequestSchema,
  wordPressOrgSourceRequestSchema,
  wordPressOrgSourceResponseSchema,
  wordPressOrgTargetObservationRefSchema,
  wordPressOrgTargetObservationSchema,
} from "./wordpress-org-contracts.js";
export type {
  ObservedWordPressOrgTarget,
  OpenWordPressOrgTargetSourceOptions,
  WordPressOrgAcquisitionFailureWithOriginal,
  WordPressOrgAcquisitionFailure,
  WordPressOrgAcquireRequest,
  WordPressOrgAcquisitionOriginal,
  WordPressOrgAcquisitionResult,
  WordPressOrgAcquisitionWithIntake,
  WordPressOrgArchiveRejected,
  WordPressOrgFetchAdapterOptions,
  WordPressOrgObservationResult,
  WordPressOrgObservationFailure,
  WordPressOrgObserveRequest,
  WordPressOrgSourceAdapter,
  WordPressOrgSourceFailure,
  WordPressOrgSourceRequest,
  WordPressOrgSourceResponse,
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
export { acquiredSourceFromIntakePacket } from "./intake-packet-source.js";
export { acquirePinnedWordPressOrgSvnSource } from "./pinned-svn-source.js";
export { openMaterializedSources } from "./materialized-sources.js";
export {
  openWordPressCoreSource,
  WORDPRESS_CORE_IDENTITY,
} from "./wordpress-core-source.js";
export {
  openPhpRuntimeSource,
  PHP_RUNTIME_SOURCE_IDENTITY,
} from "./php-runtime-source.js";
