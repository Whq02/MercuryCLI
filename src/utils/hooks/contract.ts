import { z } from 'zod/v4'
import { lazySchema } from '../lazySchema.js'
import type { TurnCutKind } from '../messages/turnCut.js'
import { permissionUpdateSchema } from '../permissions/PermissionUpdateSchema.js'

export const EXIT_REASONS = [
  'clear',
  'resume',
  'logout',
  'prompt_input_exit',
  'other',
  'bypass_permissions_disabled',
] as const
export type ExitReason = (typeof EXIT_REASONS)[number]

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
      .array(permissionUpdateSchema())
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
export const CrewmateIdleHookInputSchema = lazySchema(() =>
  z.object({
    ...baseHookFields,
    hook_event_name: z.literal('CrewmateIdle'),
    crewmate_name: z.string().optional().describe('The crewmate about to go idle'),
    crew_name: z.string().optional().describe('The crew it belongs to'),
  }),
)
export const TaskCreatedHookInputSchema = lazySchema(() =>
  z.object({
    ...baseHookFields,
    hook_event_name: z.literal('TaskCreated'),
    task_id: z.string().describe('The new task\'s id'),
    task_subject: z.string().optional().describe('Its one-line subject'),
    task_description: z.string().optional().describe('Its longer body, when given'),
    crewmate_name: z.string().optional().describe('The crewmate the task concerns'),
    crew_name: z.string().optional().describe('The owning crew'),
  }),
)
export const TaskCompletedHookInputSchema = lazySchema(() =>
  z.object({
    ...baseHookFields,
    hook_event_name: z.literal('TaskCompleted'),
    task_id: z.string().describe('The finished task\'s id'),
    task_subject: z.string().optional().describe('Its one-line subject'),
    task_description: z.string().optional().describe('Its longer body, when given'),
    crewmate_name: z.string().optional().describe('The crewmate that worked it'),
    crew_name: z.string().optional().describe('The owning crew'),
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
    instruction_scope: z.enum(['User', 'Project', 'Local', 'Managed']),
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
    name: z.string().describe('The worktree Mercury asks the hook to provision'),
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
    reason: z.enum(EXIT_REASONS).describe('Why the session is ending'),
  }),
)
export const INTERRUPT_REASONS = ['operator', 'idle-timeout', 'parent-stop', 'cut'] as const satisfies readonly TurnCutKind[]
export const InterruptHookInputSchema = lazySchema(() =>
  z.object({
    ...baseHookFields,
    hook_event_name: z.literal('Interrupt'),
    turn_id: z.string().describe('The id of the run the interrupt cut'),
    reason: z.enum(INTERRUPT_REASONS).describe("Why the turn was cut: the operator's stop, a no-progress timeout, the parent's stop, or a typed cut"),
    detail: z.string().optional().describe("The cut's own words when it has any (a typed cut, a timeout with a message)"),
    tools: z.array(z.string()).describe('The names of the tool calls the interrupt ended, one per call'),
  }),
)

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
          updatedPermissions: z.array(permissionUpdateSchema()).optional().describe('Permission changes to apply alongside the allow'),
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

import { hookSpecificReducers, type HookSpecificReducer } from './resultEffects.js'

export type HookMatchField =
  | 'tool_name'
  | 'source'
  | 'command_name'
  | 'trigger'
  | 'notification_type'
  | 'reason'
  | 'error'
  | 'agent_type'
  | 'mcp_server_name'
  | 'load_reason'
  | 'file_path'
  | 'basename_file_path'

export type HookEventRow = {
  input: () => z.ZodTypeAny
  output?: () => z.ZodTypeAny
  matchField?: HookMatchField
  timeoutMs?: number
  noHttp?: boolean
  promptOutsideChat?: string
  agentOutsideChat?: string
  feedback?: (text: string, hookName?: string) => string
  reduceSpecific?: HookSpecificReducer
}

const hookEventTableRows = {
  PreToolUse: {
    input: PreToolUseHookInputSchema,
    output: PreToolUseHookSpecificOutputSchema,
    matchField: 'tool_name' as const,
    feedback: (text: string, hookName?: string) => `${hookName} hook error: ${text}`,
  },
  PostToolUse: {
    input: PostToolUseHookInputSchema,
    output: PostToolUseHookSpecificOutputSchema,
    matchField: 'tool_name' as const,
  },
  PostToolUseFailure: {
    input: PostToolUseFailureHookInputSchema,
    output: PostToolUseFailureHookSpecificOutputSchema,
    matchField: 'tool_name' as const,
  },
  PermissionRequest: {
    input: PermissionRequestHookInputSchema,
    output: PermissionRequestHookSpecificOutputSchema,
    matchField: 'tool_name' as const,
  },
  PermissionDenied: {
    input: PermissionDeniedHookInputSchema,
    output: PermissionDeniedHookSpecificOutputSchema,
    matchField: 'tool_name' as const,
  },
  Notification: {
    input: NotificationHookInputSchema,
    output: NotificationHookSpecificOutputSchema,
    matchField: 'notification_type' as const,
  },
  UserPromptSubmit: {
    input: UserPromptSubmitHookInputSchema,
    output: UserPromptSubmitHookSpecificOutputSchema,
    feedback: (text: string) => `UserPromptSubmit operation blocked by hook:\n${text}`,
  },
  UserPromptExpansion: {
    input: UserPromptExpansionHookInputSchema,
    matchField: 'command_name' as const,
  },
  SessionStart: {
    input: SessionStartHookInputSchema,
    output: SessionStartHookSpecificOutputSchema,
    matchField: 'source' as const,
    noHttp: true,
  },
  SessionEnd: {
    input: SessionEndHookInputSchema,
    matchField: 'reason' as const,
    timeoutMs: 1500,
  },
  Stop: {
    input: StopHookInputSchema,
    feedback: (text: string) => `Stop hook feedback:\n${text}`,
  },
  StopFailure: {
    input: StopFailureHookInputSchema,
    matchField: 'error' as const,
  },
  SubagentStart: {
    input: SubagentStartHookInputSchema,
    output: SubagentStartHookSpecificOutputSchema,
    matchField: 'agent_type' as const,
  },
  SubagentStop: {
    input: SubagentStopHookInputSchema,
    matchField: 'agent_type' as const,
  },
  PreCompact: {
    input: PreCompactHookInputSchema,
    matchField: 'trigger' as const,
  },
  PostCompact: {
    input: PostCompactHookInputSchema,
    matchField: 'trigger' as const,
  },
  Setup: {
    input: SetupHookInputSchema,
    output: SetupHookSpecificOutputSchema,
    matchField: 'trigger' as const,
    noHttp: true,
  },
  CrewmateIdle: {
    input: CrewmateIdleHookInputSchema,
    feedback: (text: string) => `CrewmateIdle hook feedback:\n${text}`,
  },
  TaskCreated: {
    input: TaskCreatedHookInputSchema,
    feedback: (text: string) => `TaskCreated hook feedback:\n${text}`,
  },
  TaskCompleted: {
    input: TaskCompletedHookInputSchema,
    feedback: (text: string) => `TaskCompleted hook feedback:\n${text}`,
  },
  Elicitation: {
    input: ElicitationHookInputSchema,
    output: ElicitationHookSpecificOutputSchema,
    matchField: 'mcp_server_name' as const,
  },
  ElicitationResult: {
    input: ElicitationResultHookInputSchema,
    output: ElicitationResultHookSpecificOutputSchema,
    matchField: 'mcp_server_name' as const,
  },
  ConfigChange: {
    input: ConfigChangeHookInputSchema,
    matchField: 'source' as const,
  },
  WorktreeCreate: {
    input: WorktreeCreateHookInputSchema,
    output: WorktreeCreateHookSpecificOutputSchema,
  },
  WorktreeRemove: {
    input: WorktreeRemoveHookInputSchema,
  },
  InstructionsLoaded: {
    input: InstructionsLoadedHookInputSchema,
    matchField: 'load_reason' as const,
  },
  CwdChanged: {
    input: CwdChangedHookInputSchema,
    output: CwdChangedHookSpecificOutputSchema,
  },
  FileChanged: {
    input: FileChangedHookInputSchema,
    output: FileChangedHookSpecificOutputSchema,
    matchField: 'basename_file_path' as const,
  },
  Interrupt: {
    input: InterruptHookInputSchema,
    matchField: 'reason' as const,
  },
} as const satisfies Record<string, HookEventRow>

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
  'CrewmateIdle',
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
  'Interrupt',
] as const satisfies readonly (keyof typeof hookEventTableRows)[]
export type HookEvent = (typeof HOOK_EVENTS)[number]

export const hookEventTable = Object.fromEntries(
  HOOK_EVENTS.map(event => [event, { ...hookEventTableRows[event], reduceSpecific: hookSpecificReducers[event] }]),
) as unknown as Readonly<Record<HookEvent, HookEventRow>>

export function hookEventMatchQuery(event: HookEvent, input: HookInput): string | undefined {
  const field = hookEventTable[event]?.matchField
  if (field === undefined) return undefined
  const value = (input as Record<string, string | undefined>)[field === 'basename_file_path' ? 'file_path' : field]
  if (field === 'basename_file_path') {
    return value === undefined ? undefined : value.split('/').pop() || value
  }
  return value
}

export function hookEventInputSchema(event: HookEvent): () => z.ZodType<HookInput> {
  return hookEventTable[event].input as () => z.ZodType<HookInput>
}

const INPUT_UNION_ORDER = [
  'PreToolUse',
  'PermissionRequest',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionDenied',
  'Notification',
  'UserPromptSubmit',
  'UserPromptExpansion',
  'SessionStart',
  'Setup',
  'Stop',
  'StopFailure',
  'SubagentStart',
  'SubagentStop',
  'PreCompact',
  'PostCompact',
  'CrewmateIdle',
  'TaskCreated',
  'TaskCompleted',
  'Elicitation',
  'ElicitationResult',
  'ConfigChange',
  'InstructionsLoaded',
  'WorktreeCreate',
  'WorktreeRemove',
  'CwdChanged',
  'FileChanged',
  'SessionEnd',
  'Interrupt',
] as const satisfies readonly HookEvent[]

export const HookInputSchema = lazySchema(() =>
  z.union(
    INPUT_UNION_ORDER.map(
      event => hookEventTable[event].input(),
    ) as [
      ReturnType<typeof PreToolUseHookInputSchema>,
      ReturnType<typeof PermissionRequestHookInputSchema>,
      ReturnType<typeof PostToolUseHookInputSchema>,
      ReturnType<typeof PostToolUseFailureHookInputSchema>,
      ReturnType<typeof PermissionDeniedHookInputSchema>,
      ReturnType<typeof NotificationHookInputSchema>,
      ReturnType<typeof UserPromptSubmitHookInputSchema>,
      ReturnType<typeof UserPromptExpansionHookInputSchema>,
      ReturnType<typeof SessionStartHookInputSchema>,
      ReturnType<typeof SetupHookInputSchema>,
      ReturnType<typeof StopHookInputSchema>,
      ReturnType<typeof StopFailureHookInputSchema>,
      ReturnType<typeof SubagentStartHookInputSchema>,
      ReturnType<typeof SubagentStopHookInputSchema>,
      ReturnType<typeof PreCompactHookInputSchema>,
      ReturnType<typeof PostCompactHookInputSchema>,
      ReturnType<typeof CrewmateIdleHookInputSchema>,
      ReturnType<typeof TaskCreatedHookInputSchema>,
      ReturnType<typeof TaskCompletedHookInputSchema>,
      ReturnType<typeof ElicitationHookInputSchema>,
      ReturnType<typeof ElicitationResultHookInputSchema>,
      ReturnType<typeof ConfigChangeHookInputSchema>,
      ReturnType<typeof InstructionsLoadedHookInputSchema>,
      ReturnType<typeof WorktreeCreateHookInputSchema>,
      ReturnType<typeof WorktreeRemoveHookInputSchema>,
      ReturnType<typeof CwdChangedHookInputSchema>,
      ReturnType<typeof FileChangedHookInputSchema>,
      ReturnType<typeof SessionEndHookInputSchema>,
      ReturnType<typeof InterruptHookInputSchema>,
    ],
  ),
)

const OUTPUT_UNION_ORDER = [
  'PreToolUse',
  'UserPromptSubmit',
  'SessionStart',
  'Setup',
  'SubagentStart',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionDenied',
  'Notification',
  'PermissionRequest',
  'Elicitation',
  'ElicitationResult',
  'WorktreeCreate',
  'CwdChanged',
  'FileChanged',
] as const satisfies readonly HookEvent[]

export const SyncHookJSONOutputSchema = lazySchema(() =>
  z.object({
    continue: z.boolean().optional().describe('False stops the whole turn after this hook'),
    suppressOutput: z.boolean().optional().describe('Keep the hook\'s stdout out of the transcript'),
    stopReason: z.string().optional().describe('Shown to the user when continue is false'),
    decision: z.literal('block').optional().describe('The hook\'s verdict on the event'),
    reason: z.string().optional().describe('Why it decided that'),
    systemMessage: z.string().optional().describe('A message surfaced to the user'),
    hookSpecificOutput: z
      .union(
        OUTPUT_UNION_ORDER.map(
          event => hookEventTable[event].output!(),
        ) as [
          ReturnType<typeof PreToolUseHookSpecificOutputSchema>,
          ReturnType<typeof UserPromptSubmitHookSpecificOutputSchema>,
          ReturnType<typeof SessionStartHookSpecificOutputSchema>,
          ReturnType<typeof SetupHookSpecificOutputSchema>,
          ReturnType<typeof SubagentStartHookSpecificOutputSchema>,
          ReturnType<typeof PostToolUseHookSpecificOutputSchema>,
          ReturnType<typeof PostToolUseFailureHookSpecificOutputSchema>,
          ReturnType<typeof PermissionDeniedHookSpecificOutputSchema>,
          ReturnType<typeof NotificationHookSpecificOutputSchema>,
          ReturnType<typeof PermissionRequestHookSpecificOutputSchema>,
          ReturnType<typeof ElicitationHookSpecificOutputSchema>,
          ReturnType<typeof ElicitationResultHookSpecificOutputSchema>,
          ReturnType<typeof WorktreeCreateHookSpecificOutputSchema>,
          ReturnType<typeof CwdChangedHookSpecificOutputSchema>,
          ReturnType<typeof FileChangedHookSpecificOutputSchema>,
        ],
      )
      .optional(),
  }),
)
export type SyncHookJSONOutput = z.output<ReturnType<typeof SyncHookJSONOutputSchema>>
export type HookJSONOutput = AsyncHookJSONOutput | SyncHookJSONOutput
export const HookJSONOutputSchema: () => z.ZodType<HookJSONOutput> = lazySchema(() =>
  z.union([AsyncHookJSONOutputSchema(), SyncHookJSONOutputSchema()]) as z.ZodType<HookJSONOutput>,
)

export type BaseHookInput = z.infer<ReturnType<typeof BaseHookInputSchema>>
export type PreToolUseHookInput = z.infer<ReturnType<typeof PreToolUseHookInputSchema>>
export type PermissionRequestHookInput = z.infer<ReturnType<typeof PermissionRequestHookInputSchema>>
export type PostToolUseHookInput = z.infer<ReturnType<typeof PostToolUseHookInputSchema>>
export type PostToolUseFailureHookInput = z.infer<ReturnType<typeof PostToolUseFailureHookInputSchema>>
export type PermissionDeniedHookInput = z.infer<ReturnType<typeof PermissionDeniedHookInputSchema>>
export type NotificationHookInput = z.infer<ReturnType<typeof NotificationHookInputSchema>>
export type UserPromptSubmitHookInput = z.infer<ReturnType<typeof UserPromptSubmitHookInputSchema>>
export type UserPromptExpansionHookInput = z.infer<ReturnType<typeof UserPromptExpansionHookInputSchema>>
export type SessionStartHookInput = z.infer<ReturnType<typeof SessionStartHookInputSchema>>
export type SetupHookInput = z.infer<ReturnType<typeof SetupHookInputSchema>>
export type StopHookInput = z.infer<ReturnType<typeof StopHookInputSchema>>
export type StopFailureHookInput = z.infer<ReturnType<typeof StopFailureHookInputSchema>>
export type SubagentStartHookInput = z.infer<ReturnType<typeof SubagentStartHookInputSchema>>
export type SubagentStopHookInput = z.infer<ReturnType<typeof SubagentStopHookInputSchema>>
export type PreCompactHookInput = z.infer<ReturnType<typeof PreCompactHookInputSchema>>
export type PostCompactHookInput = z.infer<ReturnType<typeof PostCompactHookInputSchema>>
export type CrewmateIdleHookInput = z.infer<ReturnType<typeof CrewmateIdleHookInputSchema>>
export type TaskCreatedHookInput = z.infer<ReturnType<typeof TaskCreatedHookInputSchema>>
export type TaskCompletedHookInput = z.infer<ReturnType<typeof TaskCompletedHookInputSchema>>
export type ElicitationHookInput = z.infer<ReturnType<typeof ElicitationHookInputSchema>>
export type ElicitationResultHookInput = z.infer<ReturnType<typeof ElicitationResultHookInputSchema>>
export type ConfigChangeHookInput = z.infer<ReturnType<typeof ConfigChangeHookInputSchema>>
export type InstructionsLoadedHookInput = z.infer<ReturnType<typeof InstructionsLoadedHookInputSchema>>
export type WorktreeCreateHookInput = z.infer<ReturnType<typeof WorktreeCreateHookInputSchema>>
export type WorktreeRemoveHookInput = z.infer<ReturnType<typeof WorktreeRemoveHookInputSchema>>
export type CwdChangedHookInput = z.infer<ReturnType<typeof CwdChangedHookInputSchema>>
export type FileChangedHookInput = z.infer<ReturnType<typeof FileChangedHookInputSchema>>
export type SessionEndHookInput = z.infer<ReturnType<typeof SessionEndHookInputSchema>>
export type InterruptHookInput = z.infer<ReturnType<typeof InterruptHookInputSchema>>
export type HookInput = unionOfInputs
type unionOfInputs =
  | PreToolUseHookInput
  | PermissionRequestHookInput
  | PostToolUseHookInput
  | PostToolUseFailureHookInput
  | PermissionDeniedHookInput
  | NotificationHookInput
  | UserPromptSubmitHookInput
  | UserPromptExpansionHookInput
  | SessionStartHookInput
  | SetupHookInput
  | StopHookInput
  | StopFailureHookInput
  | SubagentStartHookInput
  | SubagentStopHookInput
  | PreCompactHookInput
  | PostCompactHookInput
  | CrewmateIdleHookInput
  | TaskCreatedHookInput
  | TaskCompletedHookInput
  | ElicitationHookInput
  | ElicitationResultHookInput
  | ConfigChangeHookInput
  | InstructionsLoadedHookInput
  | WorktreeCreateHookInput
  | WorktreeRemoveHookInput
  | CwdChangedHookInput
  | FileChangedHookInput
  | SessionEndHookInput
  | InterruptHookInput
export type AsyncHookJSONOutput = z.infer<ReturnType<typeof AsyncHookJSONOutputSchema>>
export type PreToolUseHookSpecificOutput = z.infer<ReturnType<typeof PreToolUseHookSpecificOutputSchema>>
export type UserPromptSubmitHookSpecificOutput = z.infer<ReturnType<typeof UserPromptSubmitHookSpecificOutputSchema>>
export type SessionStartHookSpecificOutput = z.infer<ReturnType<typeof SessionStartHookSpecificOutputSchema>>
export type SetupHookSpecificOutput = z.infer<ReturnType<typeof SetupHookSpecificOutputSchema>>
export type SubagentStartHookSpecificOutput = z.infer<ReturnType<typeof SubagentStartHookSpecificOutputSchema>>
export type PostToolUseHookSpecificOutput = z.infer<ReturnType<typeof PostToolUseHookSpecificOutputSchema>>
export type PostToolUseFailureHookSpecificOutput = z.infer<ReturnType<typeof PostToolUseFailureHookSpecificOutputSchema>>
export type PermissionDeniedHookSpecificOutput = z.infer<ReturnType<typeof PermissionDeniedHookSpecificOutputSchema>>
export type NotificationHookSpecificOutput = z.infer<ReturnType<typeof NotificationHookSpecificOutputSchema>>
export type PermissionRequestHookSpecificOutput = z.infer<ReturnType<typeof PermissionRequestHookSpecificOutputSchema>>
export type CwdChangedHookSpecificOutput = z.infer<ReturnType<typeof CwdChangedHookSpecificOutputSchema>>
export type FileChangedHookSpecificOutput = z.infer<ReturnType<typeof FileChangedHookSpecificOutputSchema>>
export type ElicitationHookSpecificOutput = z.infer<ReturnType<typeof ElicitationHookSpecificOutputSchema>>
export type ElicitationResultHookSpecificOutput = z.infer<ReturnType<typeof ElicitationResultHookSpecificOutputSchema>>
export type WorktreeCreateHookSpecificOutput = z.infer<ReturnType<typeof WorktreeCreateHookSpecificOutputSchema>>

