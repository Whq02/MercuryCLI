// ============================================================================
//  src/utils/config.ts — the compatibility barrel over src/utils/config/.
//  The frozen public surface is pinned by
//  scripts/ownership/contract-inventory.json — add new exports on the
//  submodules, not here, unless the contract deliberately grows (then
//  re-record the inventory).
// ============================================================================
export {
  DEFAULT_GLOBAL_CONFIG,
  EDITOR_MODES,
  GLOBAL_CONFIG_KEYS,
  NOTIFICATION_CHANNELS,
  PROJECT_CONFIG_KEYS,
  isGlobalConfigKey,
  isProjectConfigKey,
} from './config/schema.js'
export type {
  AccountInfo,
  DiffTool,
  EditorMode,
  GlobalConfig,
  GlobalConfigKey,
  HistoryEntry,
  InstallMethod,
  NotificationChannel,
  PastedContent,
  ProjectConfig,
  ProjectConfigKey,
  ReleaseChannel,
  SerializedStructuredHistoryEntry,
} from './config/schema.js'
export {
  CONFIG_WRITE_DISPLAY_THRESHOLD,
  _getConfigForTesting,
  _setGlobalConfigCacheForTesting,
  _wouldLoseAuthStateForTesting,
  enableConfigs,
  flushDeferredGlobalConfigSaves,
  getGlobalConfig,
  getGlobalConfigWriteCount,
  hasPendingDeferredGlobalConfigSaves,
  isConfigReadingAllowed,
  saveGlobalConfig,
  saveGlobalConfigDeferred,
} from './config/globalConfig.js'
export {
  getCurrentProjectConfig,
  getProjectConfigForWorkspace,
  getProjectPathForConfig,
  projectConfigKeyForWorkspace,
  saveCurrentProjectConfig,
  saveProjectConfigForWorkspace,
} from './config/projectConfig.js'
export {
  checkHasTrustDialogAccepted,
  isPathTrusted,
  isProjectScopeTrustAccepted,
  resetTrustDialogAcceptedCacheForTesting,
  setPathTrusted,
  untrustedWorkspaceHeadless,
} from './config/trust.js'
export {
  binaryName,
  formatAutoUpdaterDisabledReason,
  getAutoUpdaterDisabledReason,
  getCustomApiKeyStatus,
  getManagedRulesDir,
  getMemoryPath,
  getOrCreateUserID,
  getRemoteControlAtStartup,
  getUserRulesDir,
  isAutoUpdaterDisabled,
  isCopyOnSelectEnabled,
  isMercurySubstrateProfileOn,
  recordFirstStartTime,
} from './config/derived.js'
export type {
  AutoUpdaterDisabledReason,
} from './config/derived.js'
