// ============================================================================
//  src/entrypoints/sdk/coreTypes.ts — type barrel + the runtime vocabulary
//  arrays + the Mercury SDK contract-version constant.
//
//  MERCURY_SDK_CONTRACT_VERSION names the versioned Mercury-native SDK
//  vocabulary as a whole and is bumped on any breaking change to it;
//  consumers pin against it. The Mercury stream projection (the one
//  stream-json dialect — the compat-compatible dialect retired with the
//  compat wave) is an explicit named projection OVER this contract,
//  never the contract itself.
// ============================================================================
export type {
  SandboxSettings,
  SandboxNetworkConfig,
  SandboxFilesystemConfig,
  SandboxIgnoreViolations,
} from '../sandboxTypes.js'
export * from './coreTypes.generated.js'

// v2: the compat dialect retirement — `mercury_version` replaces
// `claude_code_version` on system/init, and the Agent tool is emitted under
// its real name (the compat Agent→Task wire rename is retired).
export const MERCURY_SDK_CONTRACT_VERSION = 2

/**
 * The hook-event vocabulary. The identical tuple is also declared in
 * coreSchemas.ts and the two must not drift (an oracle compares them
 * element-wise).
 */
export const HOOK_EVENTS = [
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'Notification',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'PermissionRequest',
  'PermissionDenied',
  'Setup',
  'TeammateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'WorktreeCreate',
  'WorktreeRemove',
  'InstructionsLoaded',
  'CwdChanged',
  'FileChanged',
] as const

export type HookEvent = (typeof HOOK_EVENTS)[number]

export const EXIT_REASONS = [
  'clear',
  'resume',
  'logout',
  'prompt_input_exit',
  'other',
  'bypass_permissions_disabled',
] as const

export type ExitReason = (typeof EXIT_REASONS)[number]

/**
 * The usage record with its nullable holes filled — a STRUCTURAL
 * declaration (no provider-package import) carrying the named token fields.
 */
export type NonNullableUsage = {
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  output_tokens: number
  server_tool_use: {
    web_fetch_requests: number
    web_search_requests: number
  }
  service_tier: 'standard' | 'priority' | 'batch' | null
  cache_creation: {
    ephemeral_1h_input_tokens: number
    ephemeral_5m_input_tokens: number
  }
  inference_geo: string | null
  iterations: unknown[] | null
  speed: 'standard' | 'fast' | null
  output_tokens_details: { thinking_tokens: number } | null
}
