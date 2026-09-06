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
  NotificationChannel,
  PastedContent,
  ProjectConfig,
  ProjectConfigKey,
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
  getCustomApiKeyStatus,
  getManagedRulesDir,
  getMemoryPath,
  getRemoteControlAtStartup,
  getUserRulesDir,
  isCopyOnSelectEnabled,
  isMercurySubstrateProfileOn,
  recordFirstStartTime,
} from './config/derived.js'
