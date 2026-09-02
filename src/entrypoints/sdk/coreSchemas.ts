// ============================================================================
//  src/entrypoints/sdk/coreSchemas.ts — the serializable SDK data-type
//  schemas (messages, hooks, permissions, MCP status, agents). Every field
//  name, literal discriminator and enum member is WIRE CONTRACT for the
//  stream-json headless transport; snake_case on the wire is the wire shape
//  and is never normalized (the deliberate camelCase islands —
//  `permissionMode`, `modelUsage` — are preserved).
//
//  External-type placeholders: user/assistant message content, the raw
//  stream event, UUIDs and the MCP JSON-RPC message are unknown/string
//  placeholders — their true types come from the provider SDK and a
//  generation script substitutes the real references in the generated
//  type surface.
// ============================================================================
import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'
import { decodePermissionModeSpelling } from '../../types/permissions.js'
import { MEMORY_TYPES } from '../../memdir/memoryTypes.js'

// ── vocabulary tuples shared with coreTypes.ts (must not drift) ────────────
export const HOOK_EVENTS_SCHEMA_TUPLE = [
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

// ── usage / model usage ────────────────────────────────────────────────────
export const ModelUsageSchema = lazySchema(() =>
  z.object({
    inputTokens: z.number().describe('Prompt tokens the model read this turn'),
    outputTokens: z.number().describe('Tokens the model generated'),
    cacheReadInputTokens: z.number().describe('Prompt tokens served from the cache'),
    cacheCreationInputTokens: z.number().describe('Prompt tokens written into the cache'),
    webSearchRequests: z.number().describe('How many web searches the turn issued'),
    costUSD: z.number().describe('Estimated cost of this usage in US dollars'),
    contextWindow: z.number().optional().describe('The context-window size the model ran with'),
    maxOutputTokens: z.number().optional().describe('The output-token ceiling in force'),
  }),
)

// ── output formats ─────────────────────────────────────────────────────────
export const OutputFormatTypeSchema = lazySchema(() => z.enum(['text', 'json', 'stream-json']))
export const BaseOutputFormatSchema = lazySchema(() =>
  z.object({ type: OutputFormatTypeSchema() }),
)
export const JsonSchemaOutputFormatSchema = lazySchema(() =>
  z.object({
    type: z.literal('json'),
    schema: z
      .record(z.string(), z.unknown())
      .describe('A JSON Schema the final result must conform to'),
  }),
)
export const OutputFormatSchema = lazySchema(() =>
  z.union([JsonSchemaOutputFormatSchema(), BaseOutputFormatSchema()]),
)

// ── small vocabularies ─────────────────────────────────────────────────────
export const ApiKeySourceSchema = lazySchema(() =>
  z.enum(['user', 'project', 'org', 'temporary', 'oauth']),
)
export const ConfigScopeSchema = lazySchema(() => z.enum(['local', 'user', 'project']))
export const SdkBetaSchema = lazySchema(() => z.enum(['context-1m-2025-08-07']))

// ── thinking config ────────────────────────────────────────────────────────
export const ThinkingAdaptiveSchema = lazySchema(() =>
  z.object({
    type: z.literal('adaptive'),
    budgetTokens: z.number().optional().describe('Optional ceiling on thinking tokens; the model paces itself'),
  }),
)
export const ThinkingEnabledSchema = lazySchema(() =>
  z.object({
    type: z.literal('enabled'),
    budgetTokens: z.number().describe('The thinking-token budget for each turn'),
  }),
)
export const ThinkingDisabledSchema = lazySchema(() => z.object({ type: z.literal('disabled') }))
export const ThinkingConfigSchema = lazySchema(() =>
  z.discriminatedUnion('type', [
    ThinkingAdaptiveSchema(),
    ThinkingEnabledSchema(),
    ThinkingDisabledSchema(),
  ]),
)

// ── MCP server configs ─────────────────────────────────────────────────────
export const McpStdioServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('stdio').optional().describe('Transport marker; stdio is assumed when absent'),
    command: z.string().describe('The executable that starts the server'),
    args: z.array(z.string()).optional().describe('Arguments handed to the command'),
    env: z.record(z.string(), z.string()).optional().describe('Environment variables set for the server process'),
    cwd: z.string().optional().describe('Working directory the server starts in'),
  }),
)
export const McpSSEServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('sse'),
    url: z.string().describe('The SSE endpoint to connect to'),
    headers: z.record(z.string(), z.string()).optional().describe('Extra request headers, e.g. for auth'),
  }),
)
export const McpHttpServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('http'),
    url: z.string().describe('The HTTP endpoint to connect to'),
    headers: z.record(z.string(), z.string()).optional().describe('Extra request headers, e.g. for auth'),
  }),
)
export const McpSdkServerConfigSchema = lazySchema(() =>
  z.object({
    type: z.literal('sdk'),
    name: z.string().describe('The in-process SDK server registration to bind'),
  }),
)
export const McpServerConfigForProcessTransportSchema = lazySchema(() =>
  z.union([
    McpStdioServerConfigSchema(),
    McpSSEServerConfigSchema(),
    McpHttpServerConfigSchema(),
    McpSdkServerConfigSchema(),
  ]),
)
/** Output-only: the claude.ai connector proxy. */
export const McpClaudeAIProxyServerConfigSchema = lazySchema(() =>
  z.object({ type: z.literal('claudeai-proxy'), url: z.string().optional() }),
)
export const McpServerStatusConfigSchema = lazySchema(() =>
  z.union([
    McpStdioServerConfigSchema(),
    McpSSEServerConfigSchema(),
    McpHttpServerConfigSchema(),
    McpSdkServerConfigSchema(),
    McpClaudeAIProxyServerConfigSchema(),
  ]),
)
export const McpServerStatusSchema = lazySchema(() =>
  z.object({
    name: z.string().describe('The configured server name'),
    status: z
      .enum(['connected', 'failed', 'needs-auth', 'pending', 'disabled'])
      .describe('Where the connection currently stands'),
    serverInfo: z
      .object({
        name: z.string().describe('The name the server reports for itself'),
        version: z.string().describe('The server-reported version'),
      })
      .optional()
      .describe('Identity the server announced at handshake'),
  }),
)
export const McpSetServersResultSchema = lazySchema(() =>
  z.object({
    added: z.array(z.string()).describe('Server names newly connected by this update'),
    removed: z.array(z.string()).describe('Server names disconnected by this update'),
    errors: z.record(z.string(), z.string()).describe('Per-server failure text for entries that did not apply'),
  }),
)

// ── permissions ────────────────────────────────────────────────────────────
export const PermissionUpdateDestinationSchema = lazySchema(() =>
  z.enum(['userSettings', 'projectSettings', 'localSettings', 'session', 'cliArg']),
)
export const PermissionBehaviorSchema = lazySchema(() => z.enum(['allow', 'deny', 'ask']))
export const PermissionRuleValueSchema = lazySchema(() =>
  z.object({
    toolName: z.string().describe('The tool the rule speaks for'),
    ruleContent: z.string().optional().describe('An argument pattern narrowing the rule, e.g. a command prefix'),
  }),
)
export const PermissionUpdateSchema = lazySchema(() =>
  z.discriminatedUnion('type', [
    z.object({
      type: z.literal('addRules'),
      rules: z.array(PermissionRuleValueSchema()).describe('The rules this update names'),
      behavior: PermissionBehaviorSchema().describe('The behavior the rules carry'),
      destination: PermissionUpdateDestinationSchema().describe('Which settings layer takes the change'),
    }),
    z.object({
      type: z.literal('replaceRules'),
      rules: z.array(PermissionRuleValueSchema()).describe('The rules this update names'),
      behavior: PermissionBehaviorSchema().describe('The behavior the rules carry'),
      destination: PermissionUpdateDestinationSchema().describe('Which settings layer takes the change'),
    }),
    z.object({
      type: z.literal('removeRules'),
      rules: z.array(PermissionRuleValueSchema()).describe('The rules this update names'),
      behavior: PermissionBehaviorSchema().describe('The behavior the rules carry'),
      destination: PermissionUpdateDestinationSchema().describe('Which settings layer takes the change'),
    }),
    z.object({
      type: z.literal('setMode'),
      mode: externalPermissionModeWireEnum().describe('The permission mode to switch to'),
      destination: PermissionUpdateDestinationSchema().describe('Which settings layer takes the change'),
    }),
    z.object({
      type: z.literal('addDirectories'),
      directories: z.array(z.string()).describe('The directories to grant access to'),
      destination: PermissionUpdateDestinationSchema().describe('Which settings layer takes the change'),
    }),
    z.object({
      type: z.literal('removeDirectories'),
      directories: z.array(z.string()).describe('The directories to withdraw access from'),
      destination: PermissionUpdateDestinationSchema().describe('Which settings layer takes the change'),
    }),
  ]),
)
export const PermissionDecisionClassificationSchema = lazySchema(() =>
  z.enum(['user_temporary', 'user_permanent', 'user_reject']),
)
/** The SDK-side canUseTool result carried over the control channel. */
export const PermissionResultSchema = lazySchema(() =>
  z.union([
    z.object({
      behavior: z.literal('allow'),
      updatedInput: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('A replacement tool input to run instead of the original'),
      updatedPermissions: z
        .array(PermissionUpdateSchema())
        .optional()
        .describe('Permission updates to apply alongside the approval'),
      toolUseID: z.string().optional().describe('The tool call this answer belongs to'),
    }),
    z.object({
      behavior: z.literal('deny'),
      message: z.string().optional().describe('Why the call was refused, shown to the model'),
      interrupt: z.boolean().optional().describe('Also abort the turn rather than only refusing the call'),
      toolUseID: z.string().optional().describe('The tool call this answer belongs to'),
    }),
  ]),
)
/**
 * The external permission-mode wire enum. Retired external spellings
 * (RETIRED_PERMISSION_MODE_SPELLINGS, types/permissions.ts) decode through
 * the bounded alias BEFORE validation, so an SDK caller pinned to the old
 * ids keeps working — and observes the new ids in every payload the CLI
 * emits.
 */
const externalPermissionModeWireEnum = () =>
  z.preprocess(
    v => (typeof v === 'string' ? decodePermissionModeSpelling(v) : v),
    z.enum(['default', 'dontAsk', 'implement', 'sovereign', 'strategy']),
  )
export const PermissionModeSchema = lazySchema(() => externalPermissionModeWireEnum())

// ── hook inputs ────────────────────────────────────────────────────────────
const baseHookFields = {
  session_id: z.string().describe('The session the hook fired in'),
  transcript_path: z.string().describe('Absolute path of the session transcript JSONL'),
  cwd: z.string().describe('The working directory at fire time'),
  permission_mode: z.string().optional().describe('The permission mode in force'),
  agent_id: z.string().optional().describe('Set when a subagent fired the hook'),
  agent_type: z.string().optional().describe('The firing agent\'s type, when known'),
}
export const BaseHookInputSchema = lazySchema(() => z.object(baseHookFields))

export const PreToolUseHookInputSchema = lazySchema(() =>
  z.object({
    ...baseHookFields,
    hook_event_name: z.literal('PreToolUse'),
    tool_name: z.string().describe('The tool about to run'),
    tool_input: z.unknown().describe('The exact input the tool will receive'),
    tool_use_id: z.string().optional().describe('The provider id of this tool call'),
  }),
)
export const PermissionRequestHookInputSchema = lazySchema(() =>
  z.object({
    ...baseHookFields,
    hook_event_name: z.literal('PermissionRequest'),
    tool_name: z.string().describe('The tool awaiting a permission answer'),
    tool_input: z.unknown().describe('The input the pending call carries'),
    tool_use_id: z.string().optional().describe('The provider id of the pending call'),
    permission_suggestions: z
      .array(PermissionUpdateSchema())
      .optional()
      .describe('Rule updates the harness would offer for this ask'),
  }),
)
export const PostToolUseHookInputSchema = lazySchema(() =>
  z.object({
    ...baseHookFields,
    hook_event_name: z.literal('PostToolUse'),
    tool_name: z.string().describe('The tool that just finished'),
    tool_input: z.unknown().describe('The input it ran with'),
    tool_response: z.unknown().describe('What the tool returned'),
    tool_use_id: z.string().optional().describe('The provider id of the finished call'),
  }),
)
export const PostToolUseFailureHookInputSchema = lazySchema(() =>
  z.object({
    ...baseHookFields,
    hook_event_name: z.literal('PostToolUseFailure'),
    tool_name: z.string().describe('The tool that failed'),
    tool_input: z.unknown().describe('The input it ran with'),
    tool_use_id: z.string().optional().describe('The provider id of the failed call'),
    error: z.string().describe('The failure text'),
    is_interrupt: z.boolean().optional().describe('True when the failure was a user interrupt'),
  }),
)
export const PermissionDeniedHookInputSchema = lazySchema(() =>
  z.object({
    ...baseHookFields,
    hook_event_name: z.literal('PermissionDenied'),
    tool_name: z.string().describe('The tool whose call was refused'),
    tool_input: z.unknown().describe('The refused input'),
    tool_use_id: z.string().optional().describe('The provider id of the refused call'),
    reason: z.string().optional().describe('Why it was refused'),
  }),
)
export const NotificationHookInputSchema = lazySchema(() =>
  z.object({
    ...baseHookFields,
    hook_event_name: z.literal('Notification'),
    message: z.string().describe('The notification body'),
    title: z.string().optional().describe('A short heading for the notification'),
    notification_type: z.string().optional().describe('The notification category'),
  }),
)
export const UserPromptSubmitHookInputSchema = lazySchema(() =>
  z.object({
    ...baseHookFields,
    hook_event_name: z.literal('UserPromptSubmit'),
    prompt: z.string().describe('The prompt the user just submitted'),
  }),
)
export const UserPromptExpansionHookInputSchema = lazySchema(() =>
  z.object({
    ...baseHookFields,
    hook_event_name: z.literal('UserPromptExpansion'),
    prompt: z.string().describe('The expanded prompt text'),
    command_name: z.string().optional().describe('The command that expanded'),
    command_args: z.string().optional().describe('The arguments it was invoked with'),
    command_source: z.string().optional().describe('Where the command was loaded from'),
    expansion_type: z
      .enum(['slash_command', 'mcp_prompt'])
      .describe('Whether a local slash command or an MCP prompt expanded'),
  }),
)
export const SessionStartHookInputSchema = lazySchema(() =>
  z.object({
    ...baseHookFields,
    hook_event_name: z.literal('SessionStart'),
    source: z
      .enum(['startup', 'resume', 'clear', 'compact'])
      .describe('What brought the session up'),
    model: z.string().optional().describe('The model the session starts on'),
  }),
)
export const SetupHookInputSchema = lazySchema(() =>
  z.object({
    ...baseHookFields,
    hook_event_name: z.literal('Setup'),
    trigger: z.enum(['init', 'maintenance']).describe('Which setup pass is running'),
  }),
)
export const StopHookInputSchema = lazySchema(() =>
  z.object({
    ...baseHookFields,
    hook_event_name: z.literal('Stop'),
    stop_hook_active: z.boolean().describe('True when this fire is itself a stop-hook continuation'),
    last_assistant_message: z.string().optional().describe('Text of the final assistant message this turn'),
  }),
)
export const StopFailureHookInputSchema = lazySchema(() =>
  z.object({
    ...baseHookFields,
    hook_event_name: z.literal('StopFailure'),
    error: z.string().describe('What ended the turn abnormally'),
    error_details: z.string().optional().describe('A longer failure explanation, when one exists'),
    last_assistant_message: z.string().optional().describe('Text of the final assistant message this turn'),
  }),
)
export const SubagentStartHookInputSchema = lazySchema(() =>
  z.object({
    ...baseHookFields,
    hook_event_name: z.literal('SubagentStart'),
    agent_type: z.string().optional().describe('The subagent type being launched'),
    prompt: z.string().optional().describe('The task prompt the subagent starts with'),
  }),
)
export const SubagentStopHookInputSchema = lazySchema(() =>
  z.object({
    ...baseHookFields,
    hook_event_name: z.literal('SubagentStop'),
    stop_hook_active: z.boolean().describe('True when this fire is itself a stop-hook continuation'),
    agent_transcript_path: z.string().optional().describe('Path of the subagent\'s own transcript'),
    last_assistant_message: z.string().optional().describe('Text of the subagent\'s final assistant message'),
  }),
)
export const PreCompactHookInputSchema = lazySchema(() =>
  z.object({
    ...baseHookFields,
    hook_event_name: z.literal('PreCompact'),
    trigger: z.enum(['manual', 'auto']).describe('Whether the user asked or the window forced it'),
    custom_instructions: z.string().nullable().describe('User guidance for the compaction, when given'),
  }),
)
export const PostCompactHookInputSchema = lazySchema(() =>
  z.object({
    ...baseHookFields,
    hook_event_name: z.literal('PostCompact'),
    trigger: z.enum(['manual', 'auto']).describe('Whether the user asked or the window forced it'),
    compact_summary: z.string().optional().describe('The summary the compaction produced'),
  }),
)
export const TeammateIdleHookInputSchema = lazySchema(() =>
  z.object({
    ...baseHookFields,
    hook_event_name: z.literal('TeammateIdle'),
    teammate_name: z.string().optional().describe('The teammate about to go idle'),
    team_name: z.string().optional().describe('The team it belongs to'),
  }),
)
export const TaskCreatedHookInputSchema = lazySchema(() =>
  z.object({
    ...baseHookFields,
    hook_event_name: z.literal('TaskCreated'),
    task_id: z.string().describe('The new task\'s id'),
    task_subject: z.string().optional().describe('Its one-line subject'),
    task_description: z.string().optional().describe('Its longer body, when given'),
    teammate_name: z.string().optional().describe('The teammate the task concerns'),
    team_name: z.string().optional().describe('The owning team'),
  }),
)
export const TaskCompletedHookInputSchema = lazySchema(() =>
  z.object({
    ...baseHookFields,
    hook_event_name: z.literal('TaskCompleted'),
    task_id: z.string().describe('The finished task\'s id'),
    task_subject: z.string().optional().describe('Its one-line subject'),
    task_description: z.string().optional().describe('Its longer body, when given'),
    teammate_name: z.string().optional().describe('The teammate that worked it'),
    team_name: z.string().optional().describe('The owning team'),
    status: z.enum(['completed', 'failed', 'stopped']).optional().describe('How the task ended'),
  }),
)
export const ElicitationHookInputSchema = lazySchema(() =>
  z.object({
    ...baseHookFields,
    hook_event_name: z.literal('Elicitation'),
    mcp_server_name: z.string().describe('The MCP server asking for input'),
    message: z.string().describe('What the server wants from the user'),
    requested_schema: z.record(z.string(), z.unknown()).optional().describe('A JSON Schema the answer should satisfy'),
    mode: z.enum(['form', 'url']).optional().describe('An inline form, or a browser hand-off'),
    url: z.string().optional().describe('The hand-off URL in url mode'),
    elicitation_id: z.string().optional().describe('Correlates this ask with its result'),
  }),
)
export const ElicitationResultHookInputSchema = lazySchema(() =>
  z.object({
    ...baseHookFields,
    hook_event_name: z.literal('ElicitationResult'),
    mcp_server_name: z.string().describe('The MCP server that asked'),
    action: z.enum(['accept', 'decline', 'cancel']).describe('How the user answered'),
    content: z.record(z.string(), z.unknown()).optional().describe('The submitted values on accept'),
    mode: z.enum(['form', 'url']).optional().describe('Which elicitation mode ran'),
    elicitation_id: z.string().optional().describe('Correlates back to the original ask'),
  }),
)
export const ConfigChangeHookInputSchema = lazySchema(() =>
  z.object({
    ...baseHookFields,
    hook_event_name: z.literal('ConfigChange'),
    source: z.enum([
      'user_settings',
      'project_settings',
      'local_settings',
      'policy_settings',
      'skills',
    ]),
    changed_keys: z.array(z.string()).optional().describe('The settings keys that changed'),
    file_path: z.string().optional().describe('The settings file that changed'),
  }),
)
export const InstructionsLoadedHookInputSchema = lazySchema(() =>
  z.object({
    ...baseHookFields,
    hook_event_name: z.literal('InstructionsLoaded'),
    file_path: z.string().describe('The instruction file that loaded'),
    memory_type: z.enum(['User', 'Project', 'Local', 'Managed']),
    load_reason: z.enum([
      'session_start',
      'nested_traversal',
      'path_glob_match',
      'include',
      'compact',
    ]),
    globs: z.array(z.string()).optional().describe('The path globs that scoped the load'),
    trigger_file_path: z.string().optional().describe('The touched file that triggered a glob match'),
    parent_file_path: z.string().optional().describe('The including file for a nested load'),
  }),
)
export const WorktreeCreateHookInputSchema = lazySchema(() =>
  z.object({
    ...baseHookFields,
    hook_event_name: z.literal('WorktreeCreate'),
    worktree_path: z.string().optional().describe('Where the worktree was created'),
    branch: z.string().optional().describe('The branch checked out into it'),
  }),
)
export const WorktreeRemoveHookInputSchema = lazySchema(() =>
  z.object({
    ...baseHookFields,
    hook_event_name: z.literal('WorktreeRemove'),
    worktree_path: z.string().describe('The worktree being removed'),
  }),
)
export const CwdChangedHookInputSchema = lazySchema(() =>
  z.object({
    ...baseHookFields,
    hook_event_name: z.literal('CwdChanged'),
    new_cwd: z.string().describe('The directory now current'),
    old_cwd: z.string().optional().describe('The directory before the change'),
  }),
)
export const FileChangedHookInputSchema = lazySchema(() =>
  z.object({
    ...baseHookFields,
    hook_event_name: z.literal('FileChanged'),
    file_path: z.string().describe('The watched file that changed'),
    event: z.enum(['change', 'add', 'unlink']).describe('What happened to it'),
  }),
)
export const SessionEndHookInputSchema = lazySchema(() =>
  z.object({
    ...baseHookFields,
    hook_event_name: z.literal('SessionEnd'),
    reason: z
      .enum([
        'clear',
        'resume',
        'logout',
        'prompt_input_exit',
        'other',
        'bypass_permissions_disabled',
      ])
      .describe('Why the session is ending'),
  }),
)
export const HookInputSchema = lazySchema(() =>
  z.union([
    PreToolUseHookInputSchema(),
    PermissionRequestHookInputSchema(),
    PostToolUseHookInputSchema(),
    PostToolUseFailureHookInputSchema(),
    PermissionDeniedHookInputSchema(),
    NotificationHookInputSchema(),
    UserPromptSubmitHookInputSchema(),
    UserPromptExpansionHookInputSchema(),
    SessionStartHookInputSchema(),
    SetupHookInputSchema(),
    StopHookInputSchema(),
    StopFailureHookInputSchema(),
    SubagentStartHookInputSchema(),
    SubagentStopHookInputSchema(),
    PreCompactHookInputSchema(),
    PostCompactHookInputSchema(),
    TeammateIdleHookInputSchema(),
    TaskCreatedHookInputSchema(),
    TaskCompletedHookInputSchema(),
    ElicitationHookInputSchema(),
    ElicitationResultHookInputSchema(),
    ConfigChangeHookInputSchema(),
    InstructionsLoadedHookInputSchema(),
    WorktreeCreateHookInputSchema(),
    WorktreeRemoveHookInputSchema(),
    CwdChangedHookInputSchema(),
    FileChangedHookInputSchema(),
    SessionEndHookInputSchema(),
  ]),
)

// ── hook outputs ───────────────────────────────────────────────────────────
export const AsyncHookJSONOutputSchema = lazySchema(() =>
  z.object({
    async: z.literal(true).describe('Marks the hook as still running; its result arrives later'),
    asyncTimeout: z.number().optional().describe('Milliseconds to wait before giving up on it'),
  }),
)
export const PreToolUseHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('PreToolUse'),
    permissionDecision: z.enum(['allow', 'deny', 'ask']).optional().describe('The hook\'s verdict on the tool call'),
    permissionDecisionReason: z.string().optional().describe('Why it decided that'),
    updatedInput: z.record(z.string(), z.unknown()).optional().describe('A replacement tool input to run instead'),
    additionalContext: z.string().optional().describe('Extra context injected for the model'),
  }),
)
export const UserPromptSubmitHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('UserPromptSubmit'),
    additionalContext: z.string().optional().describe('Extra context injected alongside the prompt'),
  }),
)
export const SessionStartHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('SessionStart'),
    additionalContext: z.string().optional().describe('Extra context injected at session start'),
    initialUserMessage: z.string().optional().describe('A first user message to seed the session with'),
    watchPaths: z.array(z.string()).optional().describe('Paths to watch for FileChanged fires'),
  }),
)
export const SetupHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('Setup'),
    additionalContext: z.string().optional().describe('Extra context injected after setup'),
  }),
)
export const SubagentStartHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('SubagentStart'),
    additionalContext: z.string().optional().describe('Extra context injected into the subagent'),
  }),
)
export const PostToolUseHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('PostToolUse'),
    additionalContext: z.string().optional().describe('Extra context injected after the tool ran'),
    updatedMCPToolOutput: z.unknown().optional().describe('A replacement result for an MCP tool call'),
  }),
)
export const PostToolUseFailureHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('PostToolUseFailure'),
    additionalContext: z.string().optional().describe('Extra context injected after the failure'),
  }),
)
export const PermissionDeniedHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('PermissionDenied'),
    retry: z.boolean().optional().describe('Ask the model to try the call again'),
  }),
)
export const NotificationHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('Notification'),
    additionalContext: z.string().optional().describe('Extra context injected with the notification'),
  }),
)
export const PermissionRequestHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('PermissionRequest'),
    decision: z
      .union([
        z.object({
          behavior: z.literal('allow'),
          updatedInput: z.record(z.string(), z.unknown()).optional().describe('A replacement tool input to run instead'),
          updatedPermissions: z.array(PermissionUpdateSchema()).optional().describe('Permission changes to apply alongside the allow'),
        }),
        z.object({
          behavior: z.literal('deny'),
          message: z.string().optional().describe('Shown to the model as the denial reason'),
          interrupt: z.boolean().optional().describe('Stop the whole turn, not just this call'),
        }),
      ])
      .describe('How the hook settles the permission request'),
  }),
)
export const CwdChangedHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('CwdChanged'),
    watchPaths: z.array(z.string()).optional().describe('Paths to watch for FileChanged fires'),
  }),
)
export const FileChangedHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('FileChanged'),
    watchPaths: z.array(z.string()).optional().describe('Paths to watch for FileChanged fires'),
  }),
)
export const ElicitationHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('Elicitation'),
    action: z.enum(['accept', 'decline', 'cancel']).optional().describe('Answer the ask programmatically'),
    content: z.record(z.string(), z.unknown()).optional().describe('The values to submit on accept'),
  }),
)
export const ElicitationResultHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('ElicitationResult'),
    action: z.enum(['accept', 'decline', 'cancel']).optional().describe('Override how the result reads'),
    content: z.record(z.string(), z.unknown()).optional().describe('Replacement values for the result'),
  }),
)
export const WorktreeCreateHookSpecificOutputSchema = lazySchema(() =>
  z.object({
    hookEventName: z.literal('WorktreeCreate'),
    worktreePath: z.string().describe('The worktree path the hook provisioned'),
  }),
)
export const SyncHookJSONOutputSchema = lazySchema(() =>
  z.object({
    continue: z.boolean().optional().describe('False stops the whole turn after this hook'),
    suppressOutput: z.boolean().optional().describe('Keep the hook\'s stdout out of the transcript'),
    stopReason: z.string().optional().describe('Shown to the user when continue is false'),
    decision: z.enum(['approve', 'block']).optional().describe('The hook\'s verdict on the event'),
    reason: z.string().optional().describe('Why it decided that'),
    systemMessage: z.string().optional().describe('A message surfaced to the user'),
    hookSpecificOutput: z
      .union([
        PreToolUseHookSpecificOutputSchema(),
        UserPromptSubmitHookSpecificOutputSchema(),
        SessionStartHookSpecificOutputSchema(),
        SetupHookSpecificOutputSchema(),
        SubagentStartHookSpecificOutputSchema(),
        PostToolUseHookSpecificOutputSchema(),
        PostToolUseFailureHookSpecificOutputSchema(),
        PermissionDeniedHookSpecificOutputSchema(),
        NotificationHookSpecificOutputSchema(),
        PermissionRequestHookSpecificOutputSchema(),
        ElicitationHookSpecificOutputSchema(),
        ElicitationResultHookSpecificOutputSchema(),
        WorktreeCreateHookSpecificOutputSchema(),
        CwdChangedHookSpecificOutputSchema(),
        FileChangedHookSpecificOutputSchema(),
      ])
      .optional(),
  }),
)
export const HookJSONOutputSchema = lazySchema(() =>
  z.union([AsyncHookJSONOutputSchema(), SyncHookJSONOutputSchema()]),
)

// ── prompt requests (ask-user-question surface) ────────────────────────────
export const PromptRequestOptionSchema = lazySchema(() =>
  z.object({
    label: z.string().describe('The option text shown to the user'),
    value: z.string().optional().describe('The value returned when picked; the label stands in when absent'),
    description: z.string().optional().describe('A secondary line explaining the option'),
  }),
)
export const PromptRequestSchema = lazySchema(() =>
  z.object({
    question: z.string().describe('The question put to the user'),
    options: z.array(PromptRequestOptionSchema()).optional().describe('Choices to offer; freeform when absent'),
    multiSelect: z.boolean().optional().describe('Allow picking more than one option'),
  }),
)
export const PromptResponseSchema = lazySchema(() =>
  z.object({
    answer: z.string().optional().describe('The freeform answer, when one was typed'),
    selected: z.array(z.string()).optional().describe('The chosen option values'),
    cancelled: z.boolean().optional().describe('True when the user dismissed the ask'),
  }),
)

// ── roster rows ────────────────────────────────────────────────────────────
export const SlashCommandSchema = lazySchema(() =>
  z.object({
    name: z.string().describe('The command name, without the slash'),
    description: z.string().describe('What the command does'),
    argumentHint: z.string().describe('The argument shape shown after the name'),
  }),
)
export const AgentInfoSchema = lazySchema(() =>
  z.object({
    name: z.string().describe('The agent type name'),
    description: z.string().optional().describe('When this agent is worth dispatching'),
    model: z.string().optional().describe('The model it runs on, when pinned'),
  }),
)
export const ModelInfoSchema = lazySchema(() =>
  z.object({
    value: z.string().describe('The selectable model value'),
    displayName: z.string().optional().describe('The marketing name shown in pickers'),
    description: z.string().optional().describe('A one-line positioning blurb'),
    supportsEffort: z.boolean().optional().describe('Whether effort levels apply to this model'),
    supportedEffortLevels: z
      .array(z.enum(['low', 'medium', 'high', 'max']))
      .optional()
      .describe('The effort levels it accepts'),
    supportsAdaptiveThinking: z.boolean().optional().describe('Whether adaptive thinking is available'),
    supportsAutoMode: z.boolean().optional().describe('Whether auto permission mode may run on it'),
  }),
)
export const AccountInfoSchema = lazySchema(() =>
  z.object({
    email: z.string().optional().describe('The signed-in account email'),
    organization: z.string().optional().describe('The active organization'),
    subscriptionType: z.string().optional().describe('The subscription tier in force'),
  }),
)

// ── agent definitions ──────────────────────────────────────────────────────
export const AgentMcpServerSpecSchema = lazySchema(() =>
  z.union([
    z.string(),
    McpServerConfigForProcessTransportSchema(),
  ]),
)
export const AgentDefinitionSchema = lazySchema(() =>
  z.object({
    description: z
      .string()
      .describe('Plain-language guidance on the situations this agent should be picked for'),
    tools: z
      .array(z.string())
      .optional()
      .describe(
        'Tool names this agent may call; leaving it out hands the agent every tool its parent holds',
      ),
    disallowedTools: z
      .array(z.string())
      .optional()
      .describe('Tool names withheld from this agent even when the allowed set would include them'),
    prompt: z.string().describe('The system prompt the agent runs under'),
    model: z
      .string()
      .optional()
      .describe(
        "An alias such as 'sonnet', 'opus' or 'haiku', or a full model ID such as 'claude-opus-5'; leaving it out — or writing 'inherit' — keeps the main conversation's model",
      ),
    criticalSystemReminder_EXPERIMENTAL: z
      .string()
      .optional()
      .describe('Experimental: a reminder line re-injected into the prompt at every user turn'),
    skills: z
      .array(z.string())
      .optional()
      .describe('Skill names loaded into the agent context up front, before its first turn'),
    initialPrompt: z
      .string()
      .optional()
      .describe(
        'When this agent runs as the main thread, this text submits itself as the opening user turn — slash commands are processed — and goes ahead of whatever prompt the user supplied.',
      ),
    maxTurns: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        'Hard ceiling on agentic turns — one API round-trip each — after which the agent stops',
      ),
    background: z
      .boolean()
      .optional()
      .describe(
        'Invocations run this agent as a background task: the caller is not blocked and does not wait on the result',
      ),
    memory: z
      .enum(['user', 'project', 'local'])
      .optional()
      .describe(
        "Where agent memory files auto-load from: 'user' - <mercury home>/agent-memory/<agentType>/, " +
          "'project' - <project>/.mercury/agent-memory/<agentType>/, 'local' - <project>/.mercury/agent-memory-local/<agentType>/",
      ),
    effort: z
      .union([z.enum(['low', 'medium', 'high', 'max']), z.number().int()])
      .optional()
      .describe('How much reasoning effort the agent spends per turn'),
    permissionMode: z
      .string()
      .optional()
      .describe('The permission mode this agent starts its turns under'),
    mcpServers: z
      .array(AgentMcpServerSpecSchema())
      .optional()
      .describe('The MCP servers this agent may connect to, as a list of server specs'),
  }),
)

// ── settings sources / extensions ──────────────────────────────────────────
export const SettingSourceSchema = lazySchema(() => z.enum(['user', 'project', 'local']))
export const SdkExtensionConfigSchema = lazySchema(() =>
  z.object({ type: z.literal('local'), path: z.string().describe('Filesystem path to the extension folder (approved for this session only)') }),
)
export const RewindFilesResultSchema = lazySchema(() =>
  z.object({
    canRewind: z.boolean().optional().describe('Whether a rewind is possible from here'),
    filesChanged: z.array(z.string()).optional().describe('Paths a rewind would touch'),
    insertions: z.number().optional().describe('Lines a rewind would add back'),
    deletions: z.number().optional().describe('Lines a rewind would remove'),
    restored_files: z.number().optional().describe('Files actually restored'),
    deleted_files: z.number().optional().describe('Files actually deleted'),
    dry_run: z.boolean().optional().describe('True when nothing was written'),
    error: z.string().optional().describe('Why the rewind failed, when it did'),
  }),
)

// ── SDK message envelopes ──────────────────────────────────────────────────
export const SDKAssistantMessageErrorSchema = lazySchema(() =>
  z.enum([
    'authentication_failed',
    'billing_error',
    'rate_limit',
    'invalid_request',
    'server_error',
    'unknown',
    'max_output_tokens',
  ]),
)
export const SDKStatusSchema = lazySchema(() => z.enum(['idle', 'running', 'requires_action']))

export const SDKUserMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('user'),
    // Placeholder: the true message type comes from the provider SDK.
    message: z.unknown().describe('The provider-format user message'),
    parent_tool_use_id: z.string().nullable().optional().describe('The Agent tool call this message runs under, when inside a subagent'),
    uuid: z.string().optional().describe('Unique id for this message'),
    session_id: z.string().optional().describe('The session this message belongs to'),
    isMeta: z.boolean().optional().describe('True for harness-injected meta turns'),
  }),
)
/** The replay variant rides the MESSAGE union, not the stdin union. */
export const SDKUserMessageReplaySchema = lazySchema(() =>
  z.object({
    type: z.literal('user'),
    message: z.unknown().describe('The provider-format user message being replayed'),
    parent_tool_use_id: z.string().nullable().optional().describe('The Agent tool call this message ran under, when inside a subagent'),
    uuid: z.string().describe('Unique id for this message'),
    session_id: z.string().describe('The session this message belongs to'),
    isReplay: z.literal(true).describe('Marks a message re-emitted from history rather than freshly produced'),
  }),
)
export const SDKRateLimitInfoSchema = lazySchema(() =>
  z.object({
    status: z.enum(['allowed', 'allowed_warning', 'rejected']).describe('Overall verdict for the request'),
    unifiedRateLimit: z
      .object({
        status: z.enum(['allowed', 'allowed_warning', 'rejected']).describe('Verdict under the unified limit'),
        type: z
          .enum([
            'five_hour',
            'seven_day',
            'seven_day_opus',
            'seven_day_sonnet',
            'seven_day_fable',
            'overage',
          ])
          .optional()
          .describe('Which limit window is binding'),
        resetsAt: z.number().optional().describe('Epoch seconds when the window resets'),
        utilization: z.number().optional().describe('Fraction of the window already spent'),
        overageStatus: z
          .enum(['allowed', 'allowed_warning', 'rejected'])
          .optional()
          .describe('Verdict for overage spending past the included quota'),
        overageDisabledReason: z
          .enum([
            'overage_not_provisioned',
            'org_level_disabled',
            'org_level_disabled_until',
            'out_of_credits',
            'seat_tier_level_disabled',
            'member_level_disabled',
            'seat_tier_zero_credit_limit',
            'group_zero_credit_limit',
            'member_zero_credit_limit',
            'org_service_level_disabled',
            'org_service_zero_credit_limit',
            'no_limits_configured',
            'unknown',
          ])
          .optional()
          .describe('Why overage spending is unavailable, when it is'),
      })
      .optional()
      .describe('Detail for the unified rate limit, when the account is on it'),
  }),
)
export const SDKAssistantMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('assistant'),
    message: z.unknown().describe('The provider-format assistant message'),
    parent_tool_use_id: z.string().nullable().describe('The Agent tool call this message runs under, when inside a subagent'),
    error: SDKAssistantMessageErrorSchema().optional().describe('Why the API call failed, when it did'),
    uuid: z.string().describe('Unique id for this message'),
    session_id: z.string().describe('The session this message belongs to'),
  }),
)
export const SDKRateLimitEventSchema = lazySchema(() =>
  z.object({
    type: z.literal('rate_limit_event'),
    rate_limit_info: SDKRateLimitInfoSchema().describe('The rate-limit state that just came back'),
    uuid: z.string(),
    session_id: z.string(),
  }),
)
export const SDKStreamlinedTextMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('streamlined_text'),
    text: z.string().describe('The condensed assistant text'),
    session_id: z.string(),
    uuid: z.string(),
  }),
)
export const SDKStreamlinedToolUseSummaryMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('streamlined_tool_use_summary'),
    tool_summary: z.string().describe('A one-line account of the tool activity'),
    session_id: z.string(),
    uuid: z.string(),
  }),
)
export const SDKPermissionDenialSchema = lazySchema(() =>
  z.object({
    tool_name: z.string().describe('The tool whose use was denied'),
    tool_use_id: z.string().describe('The denied tool call'),
    tool_input: z.record(z.string(), z.unknown()).describe('The input the denied call carried'),
  }),
)
const resultEnvelopeFields = {
  duration_ms: z.number().describe('Wall-clock milliseconds for the whole run'),
  duration_api_ms: z.number().describe('Milliseconds spent inside API calls'),
  is_error: z.boolean().describe('True when the run ended in an error subtype'),
  num_turns: z.number().describe('How many assistant turns ran'),
  session_id: z.string().describe('The session this result closes'),
  total_cost_usd: z.number().describe('Estimated dollar cost of the run'),
  // Placeholder: the usage mapped type is substituted by the generator.
  usage: z.unknown().describe('Aggregate token usage for the run'),
  modelUsage: z.record(z.string(), ModelUsageSchema()).optional().describe('Per-model usage breakdown, keyed by model id'),
  permission_denials: z.array(SDKPermissionDenialSchema()).optional().describe('Tool calls the permission system refused'),
  stop_reason: z.string().nullable().optional().describe('Why generation stopped, when the API said'),
  uuid: z.string().describe('Unique id for this message'),
}
export const SDKResultSuccessSchema = lazySchema(() =>
  z.object({
    type: z.literal('result'),
    subtype: z.literal('success'),
    result: z.string().describe('The final assistant text'),
    structured_output: z.unknown().optional().describe('The parsed structured output, when a format was requested'),
    ...resultEnvelopeFields,
  }),
)
export const SDKResultErrorSchema = lazySchema(() =>
  z.object({
    type: z.literal('result'),
    subtype: z.enum([
      'error_during_execution',
      'error_max_turns',
      'error_repetition_breaker',
      'error_max_budget_usd',
      'error_max_structured_output_retries',
    ]),
    errors: z.array(z.string()).optional().describe('The error messages behind the failure'),
    ...resultEnvelopeFields,
  }),
)
export const SDKResultMessageSchema = lazySchema(() =>
  z.union([SDKResultSuccessSchema(), SDKResultErrorSchema()]),
)
export const SDKSystemMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('system'),
    subtype: z.literal('init'),
    session_id: z.string().describe('The session that just started'),
    uuid: z.string().describe('Unique id for this message'),
    apiKeySource: ApiKeySourceSchema().optional().describe('Where the API credential came from'),
    cwd: z.string().describe('The working directory the session runs in'),
    tools: z.array(z.string()).describe('Names of the tools available this session'),
    mcp_servers: z
      .array(z.object({ name: z.string(), status: z.string() }))
      .describe('The configured MCP servers and their connection standing'),
    model: z.string().describe('The model the session starts on'),
    permissionMode: externalPermissionModeWireEnum().describe(
      'The permission mode in force at start',
    ),
    slash_commands: z.array(z.string()).describe('Names of the slash commands available'),
    mercury_version: z.string().optional().describe('The harness version string'),
    agents: z.array(z.string()).optional().describe('Names of the agent types available'),
    betas: z.array(SdkBetaSchema()).optional().describe('The beta features switched on'),
  }),
)
export const SDKPartialAssistantMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('stream_event'),
    // Placeholder: the raw stream event's true type comes from the provider SDK.
    event: z.unknown().describe('The raw provider stream event'),
    parent_tool_use_id: z.string().nullable().describe('The Agent tool call this event runs under, when inside a subagent'),
    uuid: z.string(),
    session_id: z.string(),
  }),
)
export const SDKCompactBoundaryMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('system'),
    subtype: z.literal('compact_boundary'),
    compact_metadata: z
      .object({
        trigger: z
          .enum(['manual', 'auto', 'overflow'])
          .describe('Whether the user asked, the window forced it, or an overflowed request was folded and retried'),
        pre_tokens: z.number().optional().describe('Context size before the compaction'),
      })
      .optional()
      .describe('Detail about the compaction that just happened'),
    session_id: z.string(),
    uuid: z.string(),
  }),
)
export const SDKModelTransitionMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('system'),
    subtype: z.literal('model_transition'),
    from_model: z.string().nullable().optional().describe('The model being left'),
    to_model: z.string().nullable().optional().describe('The model being adopted'),
    resolution: z
      .enum(['applied', 'cancelled-pending'])
      .optional()
      .describe('Whether the switch took effect or a pending one was withdrawn'),
    boundary: z
      .enum(['idle', 'turn-boundary', 'autopilot-tool'])
      .optional()
      .describe('The seam the switch landed on'),
    session_id: z.string(),
    uuid: z.string(),
  }),
)
export const SDKStatusMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('system'),
    subtype: z.literal('status'),
    status: SDKStatusSchema().nullable().describe('The session activity state, or null to clear it'),
    // The broadcast set matches print.ts SDK_MODES: the external ids plus
    // `flow` (a schema omitting the flow station the CLI
    // actually broadcasts would under-type the wire).
    permissionMode: z
      .preprocess(
        v => (typeof v === 'string' ? decodePermissionModeSpelling(v) : v),
        z.enum(['default', 'dontAsk', 'flow', 'implement', 'sovereign', 'strategy']),
      )
      .optional()
      .describe('The permission mode now in force'),
    session_id: z.string(),
    uuid: z.string(),
  }),
)
export const SDKPostTurnSummaryMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('system'),
    subtype: z.literal('post_turn_summary'),
    summary: z.string().optional().describe('A short account of what the turn accomplished'),
    status_category: z
      .enum(['blocked', 'waiting', 'completed', 'review_ready', 'failed'])
      .optional()
      .describe('Where the work stands after the turn'),
    session_id: z.string(),
    uuid: z.string(),
  }),
)
export const SDKAPIRetryMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('system'),
    subtype: z.literal('api_retry'),
    attempt: z.number().optional().describe('Which retry this is'),
    max_retries: z.number().optional().describe('How many retries will be attempted in all'),
    retry_delay_ms: z.number().optional().describe('The backoff before this attempt'),
    error_status: z.number().nullable().optional().describe('The HTTP status that forced the retry'),
    error: SDKAssistantMessageErrorSchema().optional().describe('The error class that forced the retry'),
    session_id: z.string(),
    uuid: z.string(),
  }),
)
export const SDKLocalCommandOutputMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('system'),
    subtype: z.literal('local_command_output'),
    stdout: z.string().optional().describe('What the command printed to stdout'),
    stderr: z.string().optional().describe('What the command printed to stderr'),
    session_id: z.string(),
    uuid: z.string(),
  }),
)
export const SDKHookStartedMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('system'),
    subtype: z.literal('hook_started'),
    hook_id: z.string().optional().describe('Correlates the lifecycle messages of one hook run'),
    hook_name: z.string().optional().describe('The hook that started'),
    hook_event: z.string().optional().describe('The event that fired it'),
    session_id: z.string(),
    uuid: z.string(),
  }),
)
export const SDKHookProgressMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('system'),
    subtype: z.literal('hook_progress'),
    hook_id: z.string().optional().describe('Correlates the lifecycle messages of one hook run'),
    hook_name: z.string().optional().describe('The hook still running'),
    hook_event: z.string().optional().describe('The event that fired it'),
    stdout: z.string().optional().describe('Stdout produced so far'),
    stderr: z.string().optional().describe('Stderr produced so far'),
    session_id: z.string(),
    uuid: z.string(),
  }),
)
export const SDKHookResponseMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('system'),
    subtype: z.literal('hook_response'),
    hook_id: z.string().optional().describe('Correlates the lifecycle messages of one hook run'),
    hook_name: z.string().optional().describe('The hook that finished'),
    hook_event: z.string().optional().describe('The event that fired it'),
    outcome: z.enum(['success', 'error', 'cancelled']).optional().describe('How the run ended'),
    stdout: z.string().optional().describe('Everything it printed to stdout'),
    stderr: z.string().optional().describe('Everything it printed to stderr'),
    output: z.unknown().optional().describe('The structured hook output, when it returned one'),
    session_id: z.string(),
    uuid: z.string(),
  }),
)
export const SDKToolProgressMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('tool_progress'),
    tool_use_id: z.string().optional().describe('The tool call reporting progress'),
    tool_name: z.string().optional().describe('The tool being run'),
    elapsed_ms: z.number().optional().describe('Milliseconds the call has been running'),
    progress: z.unknown().optional().describe('Tool-specific progress payload'),
    parent_tool_use_id: z.string().nullable().optional().describe('The Agent tool call this runs under, when inside a subagent'),
    session_id: z.string(),
    uuid: z.string(),
  }),
)
export const SDKAuthStatusMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('auth_status'),
    isAuthenticating: z.boolean().describe('True while an auth flow is in progress'),
    output: z.array(z.string()).optional().describe('Lines the auth flow has printed'),
    error: z.string().optional().describe('Why authentication failed, when it did'),
    uuid: z.string(),
    session_id: z.string(),
  }),
)
export const SDKFilesPersistedEventSchema = lazySchema(() =>
  z.object({
    type: z.literal('system'),
    subtype: z.literal('files_persisted'),
    files: z
      .array(
        z.object({
          path: z.string().describe('The persisted file'),
          tool_use_id: z.string().optional().describe('The tool call that wrote it'),
        }),
      )
      .optional()
      .describe('The files just written to durable storage'),
    session_id: z.string(),
    uuid: z.string(),
  }),
)
export const SDKTaskNotificationMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('system'),
    subtype: z.literal('task_notification'),
    task_id: z.string().describe('The background task this notifies about'),
    tool_use_id: z.string().optional().describe('The tool call that launched it'),
    task_type: z.string().optional().describe('What kind of task it is'),
    status: z.enum(['completed', 'failed', 'stopped']).optional().describe('How the task ended'),
    output_file: z.string().optional().describe('Where the full output was written'),
    summary: z.string().optional().describe('A short account of the outcome'),
    session_id: z.string(),
    uuid: z.string(),
  }),
)
export const SDKTaskStartedMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('system'),
    subtype: z.literal('task_started'),
    task_id: z.string().describe('The background task that just launched'),
    task_type: z.string().optional().describe('What kind of task it is'),
    description: z.string().optional().describe('What the task is doing'),
    session_id: z.string(),
    uuid: z.string(),
  }),
)
export const SDKSessionStateChangedMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('system'),
    subtype: z.literal('session_state_changed'),
    state: SDKStatusSchema().describe('The activity state the session moved to'),
    session_id: z.string(),
    uuid: z.string(),
  }),
)
export const SDKTaskProgressMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('system'),
    subtype: z.literal('task_progress'),
    task_id: z.string().describe('The background task reporting progress'),
    summary: z.string().optional().describe('A short account of where it stands'),
    elapsed_ms: z.number().optional().describe('Milliseconds the task has been running'),
    session_id: z.string(),
    uuid: z.string(),
  }),
)
export const SDKToolUseSummaryMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('tool_use_summary'),
    summary: z.string().optional().describe('A one-line account of the tool activity'),
    preceding_tool_use_ids: z.array(z.string()).describe('The tool calls this summary condenses'),
    session_id: z.string(),
    uuid: z.string(),
  }),
)
export const SDKElicitationCompleteMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('system'),
    subtype: z.literal('elicitation_complete'),
    mcp_server_name: z.string().optional().describe('The MCP server whose ask finished'),
    elicitation_id: z.string().optional().describe('Correlates back to the original ask'),
    session_id: z.string(),
    uuid: z.string(),
  }),
)
export const SDKPromptSuggestionMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('prompt_suggestion'),
    suggestion: z.string().describe('A prompt the user might send next'),
    uuid: z.string(),
    session_id: z.string(),
  }),
)
export const SDKSessionInfoSchema = lazySchema(() =>
  z.object({
    session_id: z.string().describe('The session this row names'),
    title: z.string().optional().describe('The session title, when one was set'),
    created_at: z.string().optional().describe('When the session was created'),
    updated_at: z.string().optional().describe('When the session last changed'),
  }),
)
export const SDKMessageSchema = lazySchema(() =>
  z.union([
    SDKAssistantMessageSchema(),
    SDKUserMessageSchema(),
    SDKUserMessageReplaySchema(),
    SDKResultSuccessSchema(),
    SDKResultErrorSchema(),
    SDKSystemMessageSchema(),
    SDKCompactBoundaryMessageSchema(),
    SDKModelTransitionMessageSchema(),
    SDKStatusMessageSchema(),
    SDKPostTurnSummaryMessageSchema(),
    SDKAPIRetryMessageSchema(),
    SDKLocalCommandOutputMessageSchema(),
    SDKHookStartedMessageSchema(),
    SDKHookProgressMessageSchema(),
    SDKHookResponseMessageSchema(),
    SDKTaskNotificationMessageSchema(),
    SDKTaskStartedMessageSchema(),
    SDKSessionStateChangedMessageSchema(),
    SDKTaskProgressMessageSchema(),
    SDKFilesPersistedEventSchema(),
    SDKElicitationCompleteMessageSchema(),
    SDKPartialAssistantMessageSchema(),
    SDKToolProgressMessageSchema(),
    SDKToolUseSummaryMessageSchema(),
    SDKAuthStatusMessageSchema(),
    SDKRateLimitEventSchema(),
    SDKPromptSuggestionMessageSchema(),
  ]),
)

// Re-export the memory-type tuple for schema consumers (the frontmatter
// parser validates against it).
export const MemoryTypeSchema = lazySchema(() => z.enum(MEMORY_TYPES))
