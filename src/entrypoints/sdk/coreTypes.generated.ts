// HERMES reconstruction — in the real build this file is emitted by
// `bun scripts/generate-sdk-types.ts` from the Zod schemas in coreSchemas.ts.
// The dump dropped the generated output; we recover the full public SDK type
// surface by inferring each type DIRECTLY from its schema via `z.infer`, so the
// types stay faithful to the runtime validators by construction.
//
// Every schema is wrapped in `lazySchema(() => …)` — a memoized thunk
// (`lazySchema<T>(f: () => T): () => T`) — so the live ZodType is
// `ReturnType<S[…]>`. Everything here is type-only: `import type` + a type-level
// `import(...)`, both erased at build (the bundler still sees an empty module;
// runtime validation keeps using the live schemas). HookEvent / ExitReason are
// hand-exported in coreTypes.ts (from the HOOK_EVENTS / EXIT_REASONS consts) and
// excluded here to avoid a duplicate `export *` member (TS2308).
import type { z } from "zod/v4";

type S = typeof import("./coreSchemas.js");

export type ModelUsage = z.infer<ReturnType<S["ModelUsageSchema"]>>;
export type OutputFormatType = z.infer<ReturnType<S["OutputFormatTypeSchema"]>>;
export type BaseOutputFormat = z.infer<ReturnType<S["BaseOutputFormatSchema"]>>;
export type JsonSchemaOutputFormat = z.infer<ReturnType<S["JsonSchemaOutputFormatSchema"]>>;
export type OutputFormat = z.infer<ReturnType<S["OutputFormatSchema"]>>;
export type ApiKeySource = z.infer<ReturnType<S["ApiKeySourceSchema"]>>;
export type ConfigScope = z.infer<ReturnType<S["ConfigScopeSchema"]>>;
export type SdkBeta = z.infer<ReturnType<S["SdkBetaSchema"]>>;
export type ThinkingAdaptive = z.infer<ReturnType<S["ThinkingAdaptiveSchema"]>>;
export type ThinkingEnabled = z.infer<ReturnType<S["ThinkingEnabledSchema"]>>;
export type ThinkingDisabled = z.infer<ReturnType<S["ThinkingDisabledSchema"]>>;
export type ThinkingConfig = z.infer<ReturnType<S["ThinkingConfigSchema"]>>;
export type McpStdioServerConfig = z.infer<ReturnType<S["McpStdioServerConfigSchema"]>>;
export type McpSSEServerConfig = z.infer<ReturnType<S["McpSSEServerConfigSchema"]>>;
export type McpHttpServerConfig = z.infer<ReturnType<S["McpHttpServerConfigSchema"]>>;
export type McpSdkServerConfig = z.infer<ReturnType<S["McpSdkServerConfigSchema"]>>;
export type McpServerConfigForProcessTransport = z.infer<ReturnType<S["McpServerConfigForProcessTransportSchema"]>>;
export type McpClaudeAIProxyServerConfig = z.infer<ReturnType<S["McpClaudeAIProxyServerConfigSchema"]>>;
export type McpServerStatusConfig = z.infer<ReturnType<S["McpServerStatusConfigSchema"]>>;
export type McpServerStatus = z.infer<ReturnType<S["McpServerStatusSchema"]>>;
export type McpSetServersResult = z.infer<ReturnType<S["McpSetServersResultSchema"]>>;
export type PermissionUpdateDestination = z.infer<ReturnType<S["PermissionUpdateDestinationSchema"]>>;
export type PermissionBehavior = z.infer<ReturnType<S["PermissionBehaviorSchema"]>>;
export type PermissionRuleValue = z.infer<ReturnType<S["PermissionRuleValueSchema"]>>;
export type PermissionUpdate = z.infer<ReturnType<S["PermissionUpdateSchema"]>>;
export type PermissionDecisionClassification = z.infer<ReturnType<S["PermissionDecisionClassificationSchema"]>>;
export type PermissionResult = z.infer<ReturnType<S["PermissionResultSchema"]>>;
export type PermissionMode = z.infer<ReturnType<S["PermissionModeSchema"]>>;
export type BaseHookInput = z.infer<ReturnType<S["BaseHookInputSchema"]>>;
export type PreToolUseHookInput = z.infer<ReturnType<S["PreToolUseHookInputSchema"]>>;
export type PermissionRequestHookInput = z.infer<ReturnType<S["PermissionRequestHookInputSchema"]>>;
export type PostToolUseHookInput = z.infer<ReturnType<S["PostToolUseHookInputSchema"]>>;
export type PostToolUseFailureHookInput = z.infer<ReturnType<S["PostToolUseFailureHookInputSchema"]>>;
export type PermissionDeniedHookInput = z.infer<ReturnType<S["PermissionDeniedHookInputSchema"]>>;
export type NotificationHookInput = z.infer<ReturnType<S["NotificationHookInputSchema"]>>;
export type UserPromptSubmitHookInput = z.infer<ReturnType<S["UserPromptSubmitHookInputSchema"]>>;
export type UserPromptExpansionHookInput = z.infer<ReturnType<S["UserPromptExpansionHookInputSchema"]>>;
export type SessionStartHookInput = z.infer<ReturnType<S["SessionStartHookInputSchema"]>>;
export type SetupHookInput = z.infer<ReturnType<S["SetupHookInputSchema"]>>;
export type StopHookInput = z.infer<ReturnType<S["StopHookInputSchema"]>>;
export type StopFailureHookInput = z.infer<ReturnType<S["StopFailureHookInputSchema"]>>;
export type SubagentStartHookInput = z.infer<ReturnType<S["SubagentStartHookInputSchema"]>>;
export type SubagentStopHookInput = z.infer<ReturnType<S["SubagentStopHookInputSchema"]>>;
export type PreCompactHookInput = z.infer<ReturnType<S["PreCompactHookInputSchema"]>>;
export type PostCompactHookInput = z.infer<ReturnType<S["PostCompactHookInputSchema"]>>;
export type TeammateIdleHookInput = z.infer<ReturnType<S["TeammateIdleHookInputSchema"]>>;
export type TaskCreatedHookInput = z.infer<ReturnType<S["TaskCreatedHookInputSchema"]>>;
export type TaskCompletedHookInput = z.infer<ReturnType<S["TaskCompletedHookInputSchema"]>>;
export type ElicitationHookInput = z.infer<ReturnType<S["ElicitationHookInputSchema"]>>;
export type ElicitationResultHookInput = z.infer<ReturnType<S["ElicitationResultHookInputSchema"]>>;
export type ConfigChangeHookInput = z.infer<ReturnType<S["ConfigChangeHookInputSchema"]>>;
export type InstructionsLoadedHookInput = z.infer<ReturnType<S["InstructionsLoadedHookInputSchema"]>>;
export type WorktreeCreateHookInput = z.infer<ReturnType<S["WorktreeCreateHookInputSchema"]>>;
export type WorktreeRemoveHookInput = z.infer<ReturnType<S["WorktreeRemoveHookInputSchema"]>>;
export type CwdChangedHookInput = z.infer<ReturnType<S["CwdChangedHookInputSchema"]>>;
export type FileChangedHookInput = z.infer<ReturnType<S["FileChangedHookInputSchema"]>>;
export type SessionEndHookInput = z.infer<ReturnType<S["SessionEndHookInputSchema"]>>;
export type HookInput = z.infer<ReturnType<S["HookInputSchema"]>>;
export type AsyncHookJSONOutput = z.infer<ReturnType<S["AsyncHookJSONOutputSchema"]>>;
export type PreToolUseHookSpecificOutput = z.infer<ReturnType<S["PreToolUseHookSpecificOutputSchema"]>>;
export type UserPromptSubmitHookSpecificOutput = z.infer<ReturnType<S["UserPromptSubmitHookSpecificOutputSchema"]>>;
export type SessionStartHookSpecificOutput = z.infer<ReturnType<S["SessionStartHookSpecificOutputSchema"]>>;
export type SetupHookSpecificOutput = z.infer<ReturnType<S["SetupHookSpecificOutputSchema"]>>;
export type SubagentStartHookSpecificOutput = z.infer<ReturnType<S["SubagentStartHookSpecificOutputSchema"]>>;
export type PostToolUseHookSpecificOutput = z.infer<ReturnType<S["PostToolUseHookSpecificOutputSchema"]>>;
export type PostToolUseFailureHookSpecificOutput = z.infer<ReturnType<S["PostToolUseFailureHookSpecificOutputSchema"]>>;
export type PermissionDeniedHookSpecificOutput = z.infer<ReturnType<S["PermissionDeniedHookSpecificOutputSchema"]>>;
export type NotificationHookSpecificOutput = z.infer<ReturnType<S["NotificationHookSpecificOutputSchema"]>>;
export type PermissionRequestHookSpecificOutput = z.infer<ReturnType<S["PermissionRequestHookSpecificOutputSchema"]>>;
export type CwdChangedHookSpecificOutput = z.infer<ReturnType<S["CwdChangedHookSpecificOutputSchema"]>>;
export type FileChangedHookSpecificOutput = z.infer<ReturnType<S["FileChangedHookSpecificOutputSchema"]>>;
export type SyncHookJSONOutput = z.infer<ReturnType<S["SyncHookJSONOutputSchema"]>>;
export type ElicitationHookSpecificOutput = z.infer<ReturnType<S["ElicitationHookSpecificOutputSchema"]>>;
export type ElicitationResultHookSpecificOutput = z.infer<ReturnType<S["ElicitationResultHookSpecificOutputSchema"]>>;
export type WorktreeCreateHookSpecificOutput = z.infer<ReturnType<S["WorktreeCreateHookSpecificOutputSchema"]>>;
export type HookJSONOutput = z.infer<ReturnType<S["HookJSONOutputSchema"]>>;
export type PromptRequestOption = z.infer<ReturnType<S["PromptRequestOptionSchema"]>>;
export type PromptRequest = z.infer<ReturnType<S["PromptRequestSchema"]>>;
export type PromptResponse = z.infer<ReturnType<S["PromptResponseSchema"]>>;
export type SlashCommand = z.infer<ReturnType<S["SlashCommandSchema"]>>;
export type AgentInfo = z.infer<ReturnType<S["AgentInfoSchema"]>>;
export type ModelInfo = z.infer<ReturnType<S["ModelInfoSchema"]>>;
export type AccountInfo = z.infer<ReturnType<S["AccountInfoSchema"]>>;
export type AgentMcpServerSpec = z.infer<ReturnType<S["AgentMcpServerSpecSchema"]>>;
export type AgentDefinition = z.infer<ReturnType<S["AgentDefinitionSchema"]>>;
export type SettingSource = z.infer<ReturnType<S["SettingSourceSchema"]>>;
export type SdkExtensionConfig = z.infer<ReturnType<S["SdkExtensionConfigSchema"]>>;
export type RewindFilesResult = z.infer<ReturnType<S["RewindFilesResultSchema"]>>;
export type SDKAssistantMessageError = z.infer<ReturnType<S["SDKAssistantMessageErrorSchema"]>>;
export type SDKStatus = z.infer<ReturnType<S["SDKStatusSchema"]>>;
export type SDKUserMessage = z.infer<ReturnType<S["SDKUserMessageSchema"]>>;
export type SDKUserMessageReplay = z.infer<ReturnType<S["SDKUserMessageReplaySchema"]>>;
export type SDKRateLimitInfo = z.infer<ReturnType<S["SDKRateLimitInfoSchema"]>>;
export type SDKAssistantMessage = z.infer<ReturnType<S["SDKAssistantMessageSchema"]>>;
export type SDKRateLimitEvent = z.infer<ReturnType<S["SDKRateLimitEventSchema"]>>;
export type SDKStreamlinedTextMessage = z.infer<ReturnType<S["SDKStreamlinedTextMessageSchema"]>>;
export type SDKStreamlinedToolUseSummaryMessage = z.infer<ReturnType<S["SDKStreamlinedToolUseSummaryMessageSchema"]>>;
export type SDKPermissionDenial = z.infer<ReturnType<S["SDKPermissionDenialSchema"]>>;
export type SDKResultSuccess = z.infer<ReturnType<S["SDKResultSuccessSchema"]>>;
export type SDKResultError = z.infer<ReturnType<S["SDKResultErrorSchema"]>>;
export type SDKResultMessage = z.infer<ReturnType<S["SDKResultMessageSchema"]>>;
export type SDKSystemMessage = z.infer<ReturnType<S["SDKSystemMessageSchema"]>>;
export type SDKPartialAssistantMessage = z.infer<ReturnType<S["SDKPartialAssistantMessageSchema"]>>;
export type SDKCompactBoundaryMessage = z.infer<ReturnType<S["SDKCompactBoundaryMessageSchema"]>>;
export type SDKModelTransitionMessage = z.infer<ReturnType<S["SDKModelTransitionMessageSchema"]>>;
export type SDKStatusMessage = z.infer<ReturnType<S["SDKStatusMessageSchema"]>>;
export type SDKPostTurnSummaryMessage = z.infer<ReturnType<S["SDKPostTurnSummaryMessageSchema"]>>;
export type SDKAPIRetryMessage = z.infer<ReturnType<S["SDKAPIRetryMessageSchema"]>>;
export type SDKLocalCommandOutputMessage = z.infer<ReturnType<S["SDKLocalCommandOutputMessageSchema"]>>;
export type SDKHookStartedMessage = z.infer<ReturnType<S["SDKHookStartedMessageSchema"]>>;
export type SDKHookProgressMessage = z.infer<ReturnType<S["SDKHookProgressMessageSchema"]>>;
export type SDKHookResponseMessage = z.infer<ReturnType<S["SDKHookResponseMessageSchema"]>>;
export type SDKToolProgressMessage = z.infer<ReturnType<S["SDKToolProgressMessageSchema"]>>;
export type SDKAuthStatusMessage = z.infer<ReturnType<S["SDKAuthStatusMessageSchema"]>>;
export type SDKFilesPersistedEvent = z.infer<ReturnType<S["SDKFilesPersistedEventSchema"]>>;
export type SDKTaskNotificationMessage = z.infer<ReturnType<S["SDKTaskNotificationMessageSchema"]>>;
export type SDKTaskStartedMessage = z.infer<ReturnType<S["SDKTaskStartedMessageSchema"]>>;
export type SDKSessionStateChangedMessage = z.infer<ReturnType<S["SDKSessionStateChangedMessageSchema"]>>;
export type SDKTaskProgressMessage = z.infer<ReturnType<S["SDKTaskProgressMessageSchema"]>>;
export type SDKToolUseSummaryMessage = z.infer<ReturnType<S["SDKToolUseSummaryMessageSchema"]>>;
export type SDKElicitationCompleteMessage = z.infer<ReturnType<S["SDKElicitationCompleteMessageSchema"]>>;
export type SDKPromptSuggestionMessage = z.infer<ReturnType<S["SDKPromptSuggestionMessageSchema"]>>;
export type SDKSessionInfo = z.infer<ReturnType<S["SDKSessionInfoSchema"]>>;
export type SDKMessage = z.infer<ReturnType<S["SDKMessageSchema"]>>;
