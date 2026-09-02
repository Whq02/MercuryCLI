// src/utils/hooks.ts — the hooks-engine BARREL.
//
// This barrel is the frozen public surface over ./hooks/, re-exporting every name. Do NOT add
// implementation here — new machinery goes in a submodule, and any NEW public
// export must be covered (or skip-listed) in the parity oracle,
// scripts/hooks/prove-hooks-parity.ts, or the gate fails.
//
// Submodule map (hooks are user-defined commands run at lifecycle points):
//   types            HookResult/AggregatedHookResult + event result types
//   matching         matchesPattern, three-source config merge, getMatchingHooks
//   messages         blocking-error formatter family
//   execution        timeouts, trust gate, base input, execCommandHook, bg dispatch
//   outputProcessing zod validation, stdout/HTTP parsers, JSON→HookResult
//   engine           executeHooks generator core + function/callback executors
//   outsideRepl      parallel lifecycle runner (no REPL generator loop)
//   events           per-event wrappers: tool-loop generators + lifecycle
//                    executors + elicitation + file-suggestion +
//                    worktree pair
//   (pre-existing: sessionHooks, hookEvents, hooksConfigSnapshot,
//    AsyncHookRegistry, exec*Hook transports — already owned modules)

export * from './hooks/types.js'

export { getMatchingHooks } from './hooks/matching.js'

export {
  getPreToolHookBlockingMessage,
  getStopHookMessage,
  getTaskCompletedHookMessage,
  getTaskCreatedHookMessage,
  getTeammateIdleHookMessage,
  getUserPromptSubmitHookBlockingMessage,
} from './hooks/messages.js'

export {
  createBaseHookInput,
  getSessionEndHookTimeoutMs,
  shouldSkipHookDueToTrust,
} from './hooks/execution.js'

export {
  executeConfigChangeHooks,
  executeCwdChangedHooks,
  executeElicitationHooks,
  executeElicitationResultHooks,
  executeFileChangedHooks,
  executeFileSuggestionCommand,
  executeInstructionsLoadedHooks,
  executeNotificationHooks,
  executePermissionDeniedHooks,
  executePermissionRequestHooks,
  executePostCompactHooks,
  executePostToolHooks,
  executePostToolUseFailureHooks,
  executePreCompactHooks,
  executePreToolHooks,
  executeSessionEndHooks,
  executeSessionStartHooks,
  executeSetupHooks,
  executeStopFailureHooks,
  executeStopHooks,
  executeSubagentStartHooks,
  executeTaskCompletedHooks,
  executeTaskCreatedHooks,
  executeTeammateIdleHooks,
  executeUserPromptExpansionHooks,
  executeUserPromptSubmitHooks,
  executeWorktreeCreateHook,
  executeWorktreeRemoveHook,
  hasBlockingResult,
  hasInstructionsLoadedHook,
  hasWorktreeCreateHook,
} from './hooks/events.js'
