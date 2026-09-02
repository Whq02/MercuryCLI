// src/services/providers/anthropic/index.ts — the Anthropic transport BARREL.
//
// This barrel is the frozen public surface over this directory, re-exporting every name. Do NOT add
// implementation here — new machinery goes in a submodule, and any NEW public
// export must be covered (or skip-listed) in the parity oracle,
// scripts/api/prove-api-parity.ts, or the gate fails.
//
// Submodule map:
//   requestParams  extra-body, caching/TTL latch (Cache Clock seam), effort
//                  (deepthink floor), budgets, metadata, verifyApiKey
//   messageParams  envelope→MessageParam converters (single-marker hook)
//   media          request-id threading + excess-media strip
//   cacheAndUsage  EXACTLY-ONE-MARKER breakpoints, system blocks, usage
//   streamCore     Options, the streaming/non-streaming generators, retry,
//                  queryWithModel/querySmallFast + output-token ceilings

export {
  configureTaskBudgetParams,
  getAPIMetadata,
  getCacheControl,
  getExtraBodyParams,
  getPromptCachingEnabled,
  verifyApiKey,
} from './requestParams.js'

export {
  assistantMessageToMessageParam,
  userMessageToMessageParam,
} from './messageParams.js'

export { stripExcessMediaItems } from './media.js'

export {
  accumulateUsage,
  addCacheBreakpoints,
  buildSystemPromptBlocks,
  cleanupStream,
  updateUsage,
} from './cacheAndUsage.js'

export {
  adjustParamsForNonStreaming,
  executeNonStreamingRequest,
  getMaxOutputTokensForModel,
  MAX_NON_STREAMING_TOKENS,
  querySmallFast,
  queryModelWithoutStreaming,
  queryModelWithStreaming,
  queryWithModel,
  type Options,
} from './streamCore.js'
