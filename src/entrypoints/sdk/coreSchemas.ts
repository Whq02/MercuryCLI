import { z } from 'zod/v4'
import { lazySchema } from '../../utils/lazySchema.js'
import { ASSISTANT_MESSAGE_ERRORS } from '../../types/message.js'
import { externalPermissionModeSchema } from '../../utils/permissions/PermissionMode.js'
import { permissionUpdateSchema } from '../../utils/permissions/PermissionUpdateSchema.js'
import { EFFORT_LEVELS } from './runtimeTypes.js'

export const ModelUsageSchema = lazySchema(() =>
  z.object({
    input_tokens: z.number().describe('Prompt tokens the model read this turn'),
    output_tokens: z.number().describe('Tokens the model generated'),
    cache_read_input_tokens: z.number().describe('Prompt tokens served from the cache'),
    cache_creation_input_tokens: z.number().describe('Prompt tokens written into the cache'),
    web_search_requests: z.number().describe('How many web searches the turn issued'),
    cost_usd: z.number().describe('Estimated cost of this usage in US dollars'),
    context_window: z.number().optional().describe('The context-window size the model ran with'),
    max_output_tokens: z.number().optional().describe('The output-token ceiling in force'),
  }),
)

export const SdkBetaSchema = lazySchema(() => z.enum(['context-1m-2025-08-07']))

export const McpServerStatusSchema = lazySchema(() =>
  z.object({
    name: z.string().describe('The configured server name'),
    status: z
      .enum(['connected', 'failed', 'needs-auth', 'pending', 'disabled'])
      .describe('Where the connection currently stands'),
    scope: z.string().optional().describe('The configuration scope the server came from'),
    config: z.unknown().optional().describe('The server configuration as configured, without secrets'),
    server_info: z
      .object({
        name: z.string().describe('The name the server reports for itself'),
        version: z.string().describe('The server-reported version'),
      })
      .optional()
      .describe('Identity the server announced at handshake'),
    tools: z
      .array(
        z.object({
          name: z.string().describe('The tool name without the server prefix'),
          read_only: z.boolean().optional().describe('Set when the tool declares itself read-only'),
          destructive: z.boolean().optional().describe('Set when the tool declares itself destructive'),
          open_world: z.boolean().optional().describe('Set when the tool declares itself open-world'),
        }),
      )
      .optional()
      .describe('The tools a connected server offers'),
    error: z.string().optional().describe('Why the connection failed, when it did'),
  }),
)
export const McpSetServersResultSchema = lazySchema(() =>
  z.object({
    added: z.array(z.string()).describe('Server names newly connected by this update'),
    removed: z.array(z.string()).describe('Server names disconnected by this update'),
    errors: z.record(z.string(), z.string()).describe('Per-server failure text for entries that did not apply'),
  }),
)

export const PermissionResultSchema = lazySchema(() =>
  z.union([
    z.object({
      behavior: z.literal('allow'),
      updated_input: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('A replacement tool input to run instead of the original'),
      updated_permissions: z
        .array(permissionUpdateSchema())
        .optional()
        .describe('Permission updates to apply alongside the approval'),
      tool_use_id: z.string().optional().describe('The tool call this answer belongs to'),
    }),
    z.object({
      behavior: z.literal('deny'),
      message: z.string().optional().describe('Why the call was refused, shown to the model'),
      interrupt: z.boolean().optional().describe('Also abort the turn rather than only refusing the call'),
      tool_use_id: z.string().optional().describe('The tool call this answer belongs to'),
    }),
  ]),
)

export const SlashCommandSchema = lazySchema(() =>
  z.object({
    name: z.string().describe('The command name, without the slash'),
    description: z.string().describe('What the command does'),
    argument_hint: z.string().describe('The argument shape shown after the name'),
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
    display_name: z.string().optional().describe('The marketing name shown in pickers'),
    description: z.string().optional().describe('A one-line positioning blurb'),
    supports_effort: z.boolean().optional().describe('Whether effort levels apply to this model'),
    supported_effort_levels: z
      .array(z.enum(EFFORT_LEVELS))
      .optional()
      .describe('The effort levels it accepts, from the one ladder'),
    supports_adaptive_thinking: z.boolean().optional().describe('Whether adaptive thinking is available'),
    supports_auto_mode: z.boolean().optional().describe('Whether auto permission mode may run on it'),
  }),
)
export const AccountInfoSchema = lazySchema(() =>
  z.object({
    email: z.string().optional().describe('The signed-in account email'),
    organization: z.string().optional().describe('The active organization'),
    subscription_type: z.string().optional().describe('The subscription tier in force'),
    token_source: z.string().optional().describe('Where the session token came from, when one is in use'),
    api_key_source: z.string().optional().describe('Where the API key came from, when one is in use'),
  }),
)

export const RewindFilesResultSchema = lazySchema(() =>
  z.object({
    can_rewind: z.boolean().optional().describe('Whether a rewind is possible from here'),
    files_changed: z.array(z.string()).optional().describe('Paths a rewind would touch'),
    insertions: z.number().optional().describe('Lines a rewind would add back'),
    deletions: z.number().optional().describe('Lines a rewind would remove'),
    restored_files: z.number().optional().describe('Files actually restored'),
    deleted_files: z.number().optional().describe('Files actually deleted'),
    dry_run: z.boolean().optional().describe('True when nothing was written'),
    error: z.string().optional().describe('Why the rewind failed, when it did'),
  }),
)

export const SDKAssistantMessageErrorSchema = lazySchema(() => z.enum(ASSISTANT_MESSAGE_ERRORS))
export const SDKStatusSchema = lazySchema(() => z.enum(['idle', 'running', 'requires_action']))

export const SDKUserMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('user'),
    message: z.unknown().describe('The provider-format user message'),
    parent_tool_use_id: z.string().nullable().optional().describe('The Agent tool call this message runs under, when inside a subagent'),
    uuid: z.string().optional().describe('Unique id for this message'),
    session_id: z.string().optional().describe('The session this message belongs to'),
    timestamp: z.string().optional().describe('When the message was recorded'),
    is_synthetic: z.boolean().optional().describe('True for a turn the harness injected rather than the user typed'),
    tool_use_result: z.unknown().optional().describe("The tool's full structured result, when the message carries a tool result"),
    priority: z.enum(['now', 'next', 'later']).optional().describe('The queue band a sent line files under while the session is busy'),
    mode: z.enum(['prompt', 'bash', 'task-notification']).optional().describe('How the words run: a prompt, a shell line, or a note addressed to one agent'),
    agent_id: z.string().optional().describe("mode task-notification: the addressed agent's id"),
    origin: z
      .looseObject({ kind: z.string() })
      .optional()
      .describe("Who sent the words when it was not the operator: a schedule's fire carries kind saturn with the schedule's own facts, and the row plates it [Saturn]"),
  }),
)
export const SDKUserMessageReplaySchema = lazySchema(() =>
  z.object({
    type: z.literal('user'),
    message: z.unknown().describe('The provider-format user message being replayed'),
    parent_tool_use_id: z.string().nullable().optional().describe('The Agent tool call this message ran under, when inside a subagent'),
    uuid: z.string().describe('Unique id for this message'),
    session_id: z.string().describe('The session this message belongs to'),
    timestamp: z.string().optional().describe('When the message was recorded'),
    is_replay: z.literal(true).describe('Marks a message re-emitted from history rather than freshly produced'),
  }),
)
export const SDKRateLimitInfoSchema = lazySchema(() =>
  z.object({
    status: z.enum(['allowed', 'allowed_warning', 'rejected']).describe('Overall verdict for the request'),
    resets_at: z.number().optional().describe('Epoch seconds when the window resets'),
    rate_limit_type: z.string().optional().describe('Which limit window is binding (five_hour, seven_day, seven_day_opus, seven_day_sonnet, seven_day_fable, overage)'),
    utilization: z.number().optional().describe('Fraction of the window already spent'),
    overage_status: z
      .enum(['allowed', 'allowed_warning', 'rejected'])
      .optional()
      .describe('Verdict for overage spending past the included quota'),
    overage_resets_at: z.number().optional().describe('Epoch seconds when the overage window resets'),
    overage_disabled_reason: z.string().optional().describe('Why overage spending is unavailable, when it is'),
    is_using_overage: z.boolean().optional().describe('True while the request spends overage'),
    surpassed_threshold: z.boolean().optional().describe('True once the warning threshold was crossed'),
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
  usage: z.unknown().describe('Aggregate token usage for the run'),
  model_usage: z.record(z.string(), ModelUsageSchema()).optional().describe('Per-model usage breakdown, keyed by model id'),
  workload_usage: z.record(z.string(), ModelUsageSchema()).optional().describe("Per-workload usage breakdown, keyed by workload tag ('cron' is scheduled work); a turn outside any workload is in no bucket"),
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
      'error_max_budget_usd',
      'error_max_structured_output_retries',
      'error_loop_stopped',
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
    cwd: z.string().describe('The working directory the session runs in'),
    tools: z.array(z.string()).describe('Names of the tools available this session'),
    mcp_servers: z
      .array(z.object({ name: z.string(), status: z.string() }))
      .describe('The configured MCP servers and their connection standing'),
    model: z.string().describe('The model the session starts on'),
    permission_mode: externalPermissionModeSchema().describe(
      'The permission mode in force at start',
    ),
    slash_commands: z.array(z.string()).describe('Names of the slash commands available'),
    mercury_version: z.string().describe('The harness version string'),
    agents: z.array(z.string()).describe('Names of the agent types available'),
    skills: z.array(z.string()).describe('Names of the skills the user can invoke'),
    extensions: z
      .array(
        z.object({
          name: z.string().describe('The extension name'),
          path: z.string().describe('The extension folder'),
          source: z.string().describe('The extension id'),
        }),
      )
      .describe('The active extensions'),
    betas: z.array(SdkBetaSchema()).describe('The beta features switched on'),
  }),
)
export const SDKPartialAssistantMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('stream_event'),
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
    transition: z
      .object({
        previous: z.string().nullable().describe('The model being left'),
        requested: z.string().nullable().describe('The model that was asked for'),
        applied: z.string().nullable().describe('The model now in force'),
        resolution: z
          .enum(['applied', 'cancelled-pending'])
          .describe('Whether the switch took effect or a pending one was withdrawn'),
        boundary: z
          .enum(['idle', 'turn-boundary'])
          .describe('The seam the switch landed on'),
        cross_provider: z.boolean().describe('True when the switch crossed provider families'),
        cache_disposition: z.string().describe('What became of the prompt cache across the switch'),
      })
      .describe('The settlement receipt of the switch'),
    session_id: z.string(),
    uuid: z.string(),
  }),
)
export const SDKTurnStartedMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('system'),
    subtype: z.literal('turn_started'),
    uuids: z.array(z.string()).describe('The queued commands the turn joined'),
    uuid: z.string(),
    session_id: z.string(),
  }),
)
export const SDKMissionUpdatedMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('system'),
    subtype: z.literal('mission_updated'),
    uuid: z.string(),
    session_id: z.string(),
  }),
)
export const SDKSamplesUpdatedMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('system'),
    subtype: z.literal('samples_updated'),
    uuid: z.string(),
    session_id: z.string(),
  }),
)
export const SDKRequestWaitSchema = lazySchema(() =>
  z.union([
    z.object({
      kind: z.literal('first-byte'),
      cold: z.boolean().describe('True when the prompt is ingesting uncached'),
      prompt_tokens: z.number().describe('The prompt size being ingested'),
      model: z.string().describe("The model's display name"),
      budget_ms: z.number().describe('The first-byte budget that fires, or on a local server the promise the row speaks'),
      since_ms: z.number().describe('Epoch milliseconds the wait began'),
      attempt: z.number().describe('Which attempt this is'),
      promise: z.boolean().optional().describe('True on a local server: the budget is a promise the row speaks, never a deadline that cuts'),
      phase: z.literal('loading').optional().describe('The local server is still loading the model; the ingestion clock starts once it is listed'),
      size_gb: z.number().optional().describe('The size of the model being loaded, in GB, when the server states it'),
      checked_ms: z.number().optional().describe('The wait at which the local server last answered its liveness probe and the promise was extended'),
    }),
    z.object({
      kind: z.literal('retry'),
      attempt: z.number().describe('Which attempt this is'),
      of: z.number().describe('How many attempts the ladder allows'),
      reason: z.string().describe('The cause of the retry, in the row\'s words'),
      delay_ms: z.number().describe('The delay before the retry'),
      since_ms: z.number().describe('Epoch milliseconds the wait began'),
    }),
    z.object({
      kind: z.literal('silence'),
      model: z.string().describe("The model's display name"),
      silent_ms: z.number().describe('How long the stream has shown no bytes'),
      since_ms: z.number().describe('Epoch milliseconds the silence began'),
      answered: z.boolean().describe('True once the local server answered its liveness probe; the turn holds while it answers and esc cuts it'),
      ask_at_ms: z.number().optional().describe('The silence at which the server is asked, while it has not been asked yet'),
    }),
  ]),
)
export const SDKFoldStatusSchema = lazySchema(() =>
  z.object({
    schema: z.literal(1),
    trigger: z.enum(['manual', 'auto']).describe('Whether the user asked or the window forced it'),
    started_at_ms: z.number().describe('Epoch milliseconds the fold began'),
    stages: z.array(z.string()).describe('The stages this fold walks, in order'),
    stage: z.string().nullable().describe('The stage in flight; null before the first stage'),
    fill: z.number().nullable().describe('The fill of the stage in flight, 0..1; null when it has no measurable fraction'),
    summary_tokens: z.number().describe('The summary tokens streamed by the attempt in flight'),
    summary_cap_tokens: z.number().describe("The summariser's output ceiling"),
    attempt: z.number().describe('The narrowing attempt in flight'),
    exit: z.enum(['landed', 'cancelled', 'failed']).optional().describe('The exit, once the fold ended'),
    ended_at_ms: z.number().optional().describe('Epoch milliseconds the fold ended'),
  }),
)
export const SDKStatusMessageSchema = lazySchema(() =>
  z.object({
    type: z.literal('system'),
    subtype: z.literal('status'),
    status: z
      .union([
        z.null(),
        z.literal('compacting'),
        z.object({ waiting_on_agents: z.number().describe('Background agents still holding the turn open') }),
        z.object({ compacting: SDKFoldStatusSchema().nullable().describe("The fold's record, or null while it has none") }),
        z.object({ wait: SDKRequestWaitSchema().nullable().describe('The request wait, or null once the first byte landed') }),
        z.object({ stream_activity: z.number().describe('Epoch milliseconds the stream last showed life with no event to show (a keep-alive the parser drops)') }),
      ])
      .describe('The session activity state, or null to clear it'),
    permission_mode: z
      .enum(['default', 'dontAsk', 'flow', 'implement', 'sovereign'])
      .optional()
      .describe('The permission mode now in force'),
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
    exit_code: z.number().nullable().optional().describe('The exit code the hook process ended with'),
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
    SDKTurnStartedMessageSchema(),
    SDKMissionUpdatedMessageSchema(),
    SDKSamplesUpdatedMessageSchema(),
    SDKAPIRetryMessageSchema(),
    SDKHookStartedMessageSchema(),
    SDKHookProgressMessageSchema(),
    SDKHookResponseMessageSchema(),
    SDKTaskNotificationMessageSchema(),
    SDKTaskStartedMessageSchema(),
    SDKSessionStateChangedMessageSchema(),
    SDKTaskProgressMessageSchema(),
    SDKElicitationCompleteMessageSchema(),
    SDKPartialAssistantMessageSchema(),
    SDKToolProgressMessageSchema(),
    SDKToolUseSummaryMessageSchema(),
    SDKRateLimitEventSchema(),
    SDKPromptSuggestionMessageSchema(),
  ]),
)
