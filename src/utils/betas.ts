// =============================================================================
// COMPAT BARREL — the beta/capability surface moved to the provider edge:
// src/utils/model/capabilities.ts. This barrel keeps
// every earlier import path working (cli/print.ts, streamCore, requestParams,
// analytics, …) while the ONE edge module owns the decisions. New code should
// import from utils/model/capabilities.js directly.
// =============================================================================
export {
  filterAllowedSdkBetas,
  modelSupportsISP,
  modelSupportsContextManagement,
  modelSupportsStructuredOutputs,
  modelSupportsTemperature,
  modelSupportsAutoMode,
  getToolSearchBetaHeader,
  shouldIncludeFirstPartyOnlyBetas,
  shouldUseGlobalCacheScope,
  getAllModelBetas,
  getModelBetas,
  getMergedBetas,
  clearBetasCaches,
} from './model/capabilities.js'
