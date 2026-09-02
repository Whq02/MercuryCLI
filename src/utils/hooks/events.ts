// The event-family layer — per-event wrappers over the engine: the tool-loop
// generators (PreToolUse family), the lifecycle executors (session/compact/
// config/notification/stop/task/teammate/prompt), instructions-loaded,
// elicitation pair, status-line + file-suggestion commands, and the worktree
// pair. Owned Mercury module.

import { randomUUID } from 'crypto'
import type {
  ConfigChangeHookInput,
  CwdChangedHookInput,
  ElicitationHookInput,
  ElicitationResultHookInput,
  ExitReason,
  FileChangedHookInput,
  HookInput,
  InstructionsLoadedHookInput,
  NotificationHookInput,
  PermissionDeniedHookInput,
  PermissionRequestHookInput,
  PostCompactHookInput,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PreCompactHookInput,
  PreToolUseHookInput,
  SessionEndHookInput,
  SessionStartHookInput,
  SetupHookInput,
  StopFailureHookInput,
  StopHookInput,
  SubagentStartHookInput,
  SubagentStopHookInput,
  TaskCompletedHookInput,
  TaskCreatedHookInput,
  TeammateIdleHookInput,
  UserPromptExpansionHookInput,
  UserPromptSubmitHookInput,
  PermissionUpdate,
} from 'src/entrypoints/agentSdkTypes.js'
import type { FileSuggestionCommandInput } from '../../types/fileSuggestion.js'
import type { AppState } from '../../state/AppState.js'
import type { AgentId } from '../../types/ids.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import type { ToolUseContext } from '../../Tool.js'
import {
  getRegisteredHooks,
  getSessionId,
} from '../../bootstrap/state.js'
import { getAgentTranscriptPath } from '../sessionStorage.js'
import { invalidateSessionEnvCache } from '../sessionEnvironment.js'
import { logForDebugging } from '../debug.js'
import {
  extractTextContent,
  getLastAssistantMessage,
} from '../messages.js'
import { getSettings_DEPRECATED, getSettingsForSource } from '../settings/settings.js'
import { clearSessionHooks } from './sessionHooks.js'
import {
  createBaseHookInput,
  getSessionEndHookTimeoutMs,
  shouldSkipHookDueToTrust,
  TOOL_HOOK_EXECUTION_TIMEOUT_MS,
} from './execution.js'
import type {
  PromptRequest,
  PromptResponse,
} from '../../types/hooks.js'
import type { AggregatedHookResult, HookBlockingError } from './types.js'
import { checkLeaseGuard } from '../swarm/leaseGuard.js'
import { executeHooks } from './engine.js'
import { executeHooksOutsideREPL } from './outsideRepl.js'
import { hasHookForEvent } from './matching.js'
import { parseElicitationHookOutput } from './outputProcessing.js'
import type {
  ConfigChangeSource,
  ElicitationHookResult,
  ElicitationResponse,
  ElicitationResultHookResult,
  HookOutsideReplResult,
  InstructionsLoadReason,
  InstructionsMemoryType,
} from './types.js'
import {
  getHooksConfigFromSnapshot,
  shouldAllowManagedHooksOnly,
  shouldDisableAllHooksIncludingManaged,
} from './hooksConfigSnapshot.js'
import { execCommandHook } from './execution.js'
import { jsonStringify } from '../slowOperations.js'

export function hasBlockingResult(results: HookOutsideReplResult[]): boolean {
  return results.some(r => r.blocked)
}


/**
 * PreToolUse: runs before a tool call executes, matched on the tool name.
 * A blocking hook (or a permissionDecision) feeds the permission path;
 * everything else surfaces as attachments. The swarm lease guard rides in
 * front of the hook machinery here — see below.
 */
export async function* executePreToolHooks<ToolInput>(
  toolName: string,
  toolUseID: string,
  toolInput: ToolInput,
  toolUseContext: ToolUseContext,
  permissionMode?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  requestPrompt?: (
    sourceName: string,
    toolInputSummary?: string | null,
  ) => (request: PromptRequest) => Promise<PromptResponse>,
  toolInputSummary?: string | null,
): AsyncGenerator<AggregatedHookResult> {
  const appState = toolUseContext.getAppState()
  const sessionId = toolUseContext.agentId ?? getSessionId()

  // File-lease guard (swarm coordination). Runs BEFORE the user-hook
  // early-return so it enforces even with no PreToolUse hooks configured.
  // Default-safe: a complete no-op unless this session is in a team AND another
  // agent holds a lease covering the target file (see leaseGuard.ts). On a real
  // cross-agent overlap it yields a deny, which runPreToolUseHooks converts to a
  // PreToolUse deny decision (same path as a user hook's permissionDecision).
  const leaseDenial = await checkLeaseGuard(
    toolName,
    toolInput as Record<string, unknown>,
    appState.teamContext,
  )
  if (leaseDenial) {
    yield {
      permissionBehavior: 'deny',
      hookPermissionDecisionReason: leaseDenial,
      hookSource: 'lease-guard',
    }
    return
  }

  if (!hasHookForEvent('PreToolUse', appState, sessionId)) {
    return
  }

  logForDebugging(`executePreToolHooks called for tool: ${toolName}`, {
    level: 'verbose',
  })

  const hookInput: PreToolUseHookInput = {
    ...createBaseHookInput(permissionMode, undefined, toolUseContext),
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseID,
  }

  yield* executeHooks({
    hookInput,
    toolUseID,
    matchQuery: toolName,
    signal,
    timeoutMs,
    toolUseContext,
    // Pass the transcript so session FUNCTION hooks (which only receive
    // `messages`) run on PreToolUse instead of erroring out as "no messages".
    // The exact pending call is carried separately via hookInput → callback ctx.
    messages: toolUseContext.messages,
    requestPrompt,
    toolInputSummary,
  })
}

/**
 * PostToolUse: runs after a tool call succeeds, matched on the tool name,
 * with both the input and the tool's response in the hook input. Blocking
 * feedback reaches the model as automated review of the completed call.
 */
export async function* executePostToolHooks<ToolInput, ToolResponse>(
  toolName: string,
  toolUseID: string,
  toolInput: ToolInput,
  toolResponse: ToolResponse,
  toolUseContext: ToolUseContext,
  permissionMode?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): AsyncGenerator<AggregatedHookResult> {
  const hookInput: PostToolUseHookInput = {
    ...createBaseHookInput(permissionMode, undefined, toolUseContext),
    hook_event_name: 'PostToolUse',
    tool_name: toolName,
    tool_input: toolInput,
    tool_response: toolResponse,
    tool_use_id: toolUseID,
  }

  yield* executeHooks({
    hookInput,
    toolUseID,
    matchQuery: toolName,
    signal,
    timeoutMs,
    toolUseContext,
  })
}

/**
 * PostToolUseFailure: runs when a tool call fails or is interrupted,
 * matched on the tool name, carrying the failure text and whether the
 * operator interrupted it.
 */
export async function* executePostToolUseFailureHooks<ToolInput>(
  toolName: string,
  toolUseID: string,
  toolInput: ToolInput,
  error: string,
  toolUseContext: ToolUseContext,
  isInterrupt?: boolean,
  permissionMode?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): AsyncGenerator<AggregatedHookResult> {
  const appState = toolUseContext.getAppState()
  const sessionId = toolUseContext.agentId ?? getSessionId()
  if (!hasHookForEvent('PostToolUseFailure', appState, sessionId)) {
    return
  }

  const hookInput: PostToolUseFailureHookInput = {
    ...createBaseHookInput(permissionMode, undefined, toolUseContext),
    hook_event_name: 'PostToolUseFailure',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseID,
    error,
    is_interrupt: isInterrupt,
  }

  yield* executeHooks({
    hookInput,
    toolUseID,
    matchQuery: toolName,
    signal,
    timeoutMs,
    toolUseContext,
  })
}

export async function* executePermissionDeniedHooks<ToolInput>(
  toolName: string,
  toolUseID: string,
  toolInput: ToolInput,
  reason: string,
  toolUseContext: ToolUseContext,
  permissionMode?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): AsyncGenerator<AggregatedHookResult> {
  const appState = toolUseContext.getAppState()
  const sessionId = toolUseContext.agentId ?? getSessionId()
  if (!hasHookForEvent('PermissionDenied', appState, sessionId)) {
    return
  }

  const hookInput: PermissionDeniedHookInput = {
    ...createBaseHookInput(permissionMode, undefined, toolUseContext),
    hook_event_name: 'PermissionDenied',
    tool_name: toolName,
    tool_input: toolInput,
    tool_use_id: toolUseID,
    reason,
  }

  yield* executeHooks({
    hookInput,
    toolUseID,
    matchQuery: toolName,
    signal,
    timeoutMs,
    toolUseContext,
  })
}

/**
 * Notification: fires as Mercury posts an operator notification, matched on
 * the notification type. Outside-REPL — observers only, nothing to block.
 */
export async function executeNotificationHooks(
  notificationData: {
    message: string
    title?: string
    notificationType: string
  },
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): Promise<void> {
  const { message, title, notificationType } = notificationData
  const hookInput: NotificationHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'Notification',
    message,
    title,
    notification_type: notificationType,
  }

  await executeHooksOutsideREPL({
    hookInput,
    timeoutMs,
    matchQuery: notificationType,
  })
}

export async function executeStopFailureHooks(
  lastMessage: AssistantMessage,
  toolUseContext?: ToolUseContext,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): Promise<void> {
  const appState = toolUseContext?.getAppState()
  // The gate must ask the question execution will answer: the outside-REPL
  // runner always resolves the MAIN session id, while agent frontmatter
  // hooks register under agentId — so gating on agentId would say "hook
  // exists" for a hook the runner then cannot find. Main id on both sides.
  const sessionId = getSessionId()
  if (!hasHookForEvent('StopFailure', appState, sessionId)) return

  const lastAssistantText =
    extractTextContent(lastMessage.message.content, '\n').trim() || undefined

  // Not every API-error message carries `error` (the image-size builder
  // omits it, among others); 'unknown' fills in so matcher filtering in
  // getMatchingHooks always has a query to work with.
  const error = lastMessage.error ?? 'unknown'
  const hookInput: StopFailureHookInput = {
    ...createBaseHookInput(undefined, undefined, toolUseContext),
    hook_event_name: 'StopFailure',
    error,
    error_details: lastMessage.errorDetails,
    last_assistant_message: lastAssistantText,
  }

  await executeHooksOutsideREPL({
    getAppState: toolUseContext?.getAppState,
    hookInput,
    timeoutMs,
    matchQuery: error,
  })
}

/**
 * Stop / SubagentStop: runs as a turn tries to end — the presence of
 * subagentId selects the subagent variant (matched on agent type, with the
 * agent's transcript path in the input). A blocking hook turns the stop
 * into a re-prompt; stop_hook_active tells a re-entered hook it caused the
 * current turn, so it can avoid an infinite keep-working loop.
 */
export async function* executeStopHooks(
  permissionMode?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  stopHookActive: boolean = false,
  subagentId?: AgentId,
  toolUseContext?: ToolUseContext,
  messages?: Message[],
  agentType?: string,
  requestPrompt?: (
    sourceName: string,
    toolInputSummary?: string | null,
  ) => (request: PromptRequest) => Promise<PromptResponse>,
): AsyncGenerator<AggregatedHookResult> {
  const hookEvent = subagentId ? 'SubagentStop' : 'Stop'
  const appState = toolUseContext?.getAppState()
  const sessionId = toolUseContext?.agentId ?? getSessionId()
  if (!hasHookForEvent(hookEvent, appState, sessionId)) {
    return
  }

  // The final assistant text rides in the hook input directly — a stop hook
  // judging "is this turn really done?" should not have to re-read the
  // transcript file to see the answer it is judging.
  const lastAssistantMessage = messages
    ? getLastAssistantMessage(messages)
    : undefined
  const lastAssistantText = lastAssistantMessage
    ? extractTextContent(lastAssistantMessage.message.content, '\n').trim() ||
      undefined
    : undefined

  const hookInput: StopHookInput | SubagentStopHookInput = subagentId
    ? {
        ...createBaseHookInput(permissionMode),
        hook_event_name: 'SubagentStop',
        stop_hook_active: stopHookActive,
        agent_id: subagentId,
        agent_transcript_path: getAgentTranscriptPath(subagentId),
        agent_type: agentType ?? '',
        last_assistant_message: lastAssistantText,
      }
    : {
        ...createBaseHookInput(permissionMode),
        hook_event_name: 'Stop',
        stop_hook_active: stopHookActive,
        last_assistant_message: lastAssistantText,
      }

  // The engine owns the trust gate; no pre-check here.
  yield* executeHooks({
    hookInput,
    toolUseID: randomUUID(),
    signal,
    timeoutMs,
    toolUseContext,
    messages,
    requestPrompt,
  })
}

/**
 * TeammateIdle: runs as a teammate is about to go idle. A blocking hook is
 * the "not yet" — the teammate keeps working with the hook's feedback.
 */
export async function* executeTeammateIdleHooks(
  teammateName: string,
  teamName: string,
  permissionMode?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): AsyncGenerator<AggregatedHookResult> {
  const hookInput: TeammateIdleHookInput = {
    ...createBaseHookInput(permissionMode),
    hook_event_name: 'TeammateIdle',
    teammate_name: teammateName,
    team_name: teamName,
  }

  yield* executeHooks({
    hookInput,
    toolUseID: randomUUID(),
    signal,
    timeoutMs,
  })
}

/**
 * TaskCreated: runs as a task enters the tracker; a blocking hook vetoes
 * the creation and its feedback explains the veto.
 */
export async function* executeTaskCreatedHooks(
  taskId: string,
  taskSubject: string,
  taskDescription?: string,
  teammateName?: string,
  teamName?: string,
  permissionMode?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  toolUseContext?: ToolUseContext,
): AsyncGenerator<AggregatedHookResult> {
  const hookInput: TaskCreatedHookInput = {
    ...createBaseHookInput(permissionMode),
    hook_event_name: 'TaskCreated',
    task_id: taskId,
    task_subject: taskSubject,
    task_description: taskDescription,
    teammate_name: teammateName,
    team_name: teamName,
  }

  yield* executeHooks({
    hookInput,
    toolUseID: randomUUID(),
    signal,
    timeoutMs,
    toolUseContext,
  })
}

/**
 * TaskCompleted: runs as a task is marked done; a blocking hook keeps it
 * open — the completion gate for definition-of-done checks.
 */
export async function* executeTaskCompletedHooks(
  taskId: string,
  taskSubject: string,
  taskDescription?: string,
  teammateName?: string,
  teamName?: string,
  permissionMode?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  toolUseContext?: ToolUseContext,
): AsyncGenerator<AggregatedHookResult> {
  const hookInput: TaskCompletedHookInput = {
    ...createBaseHookInput(permissionMode),
    hook_event_name: 'TaskCompleted',
    task_id: taskId,
    task_subject: taskSubject,
    task_description: taskDescription,
    teammate_name: teammateName,
    team_name: teamName,
  }

  yield* executeHooks({
    hookInput,
    toolUseID: randomUUID(),
    signal,
    timeoutMs,
    toolUseContext,
  })
}

/**
 * UserPromptSubmit: runs on the operator's submitted prompt before the
 * model sees it. Hooks can add context, rewrite nothing, or block the
 * submission outright (the block message renders in the prompt's place).
 */
export async function* executeUserPromptSubmitHooks(
  prompt: string,
  permissionMode: string,
  toolUseContext: ToolUseContext,
  requestPrompt?: (
    sourceName: string,
    toolInputSummary?: string | null,
  ) => (request: PromptRequest) => Promise<PromptResponse>,
): AsyncGenerator<AggregatedHookResult> {
  const appState = toolUseContext.getAppState()
  const sessionId = toolUseContext.agentId ?? getSessionId()
  if (!hasHookForEvent('UserPromptSubmit', appState, sessionId)) {
    return
  }

  const hookInput: UserPromptSubmitHookInput = {
    ...createBaseHookInput(permissionMode),
    hook_event_name: 'UserPromptSubmit',
    prompt,
  }

  yield* executeHooks({
    hookInput,
    toolUseID: randomUUID(),
    signal: toolUseContext.abortController.signal,
    timeoutMs: TOOL_HOOK_EXECUTION_TIMEOUT_MS,
    toolUseContext,
    // Pass the transcript so session FUNCTION hooks run on UserPromptSubmit (the
    // backlog seeder parks a mid-task side-ask from the live messages).
    messages: toolUseContext.messages,
    requestPrompt,
  })
}

/**
 * Execute UserPromptExpansion hooks if configured. Fires when a user-typed
 * slash command or MCP prompt expands into a prompt — BEFORE the expansion is
 * sent to the model. Matched on command_name. Hooks can inject additional
 * context, block (exit 2), or stop the expansion. A no-op when no
 * UserPromptExpansion hook is configured (the common case).
 */
export async function* executeUserPromptExpansionHooks(
  command: { name: string; source: string },
  args: string,
  expansionType: 'slash_command' | 'mcp_prompt',
  fullCommandString: string,
  permissionMode: string,
  toolUseContext: ToolUseContext,
): AsyncGenerator<AggregatedHookResult> {
  const appState = toolUseContext.getAppState()
  const sessionId = toolUseContext.agentId ?? getSessionId()
  if (!hasHookForEvent('UserPromptExpansion', appState, sessionId)) {
    return
  }

  const hookInput: UserPromptExpansionHookInput = {
    ...createBaseHookInput(permissionMode),
    hook_event_name: 'UserPromptExpansion',
    expansion_type: expansionType,
    command_name: command.name,
    command_args: args,
    command_source: command.source,
    prompt: fullCommandString,
  }

  yield* executeHooks({
    hookInput,
    toolUseID: randomUUID(),
    matchQuery: command.name,
    signal: toolUseContext.abortController.signal,
    timeoutMs: TOOL_HOOK_EXECUTION_TIMEOUT_MS,
    toolUseContext,
    requestPrompt: toolUseContext.requestPrompt,
  })
}

/**
 * SessionStart: runs as a session comes up, matched on how it came up
 * (startup / resume / clear / compact). Hooks may seed additionalContext,
 * an initialUserMessage, and watchPaths into the newborn session.
 */
export async function* executeSessionStartHooks(
  source: 'startup' | 'resume' | 'clear' | 'compact',
  sessionId?: string,
  agentType?: string,
  model?: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  forceSyncExecution?: boolean,
): AsyncGenerator<AggregatedHookResult> {
  const hookInput: SessionStartHookInput = {
    ...createBaseHookInput(undefined, sessionId),
    hook_event_name: 'SessionStart',
    source,
    agent_type: agentType,
    model,
  }

  yield* executeHooks({
    hookInput,
    toolUseID: randomUUID(),
    matchQuery: source,
    signal,
    timeoutMs,
    forceSyncExecution,
  })
}

/**
 * Setup: the workspace-preparation event, matched on its trigger ('init'
 * or 'maintenance'). forceSyncExecution pins async hooks in the foreground
 * for callers that must observe completion.
 */
export async function* executeSetupHooks(
  trigger: 'init' | 'maintenance',
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  forceSyncExecution?: boolean,
): AsyncGenerator<AggregatedHookResult> {
  const hookInput: SetupHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'Setup',
    trigger,
  }

  yield* executeHooks({
    hookInput,
    toolUseID: randomUUID(),
    matchQuery: trigger,
    signal,
    timeoutMs,
    forceSyncExecution,
  })
}

/**
 * SubagentStart: runs as a subagent spins up, matched on the agent type.
 */
export async function* executeSubagentStartHooks(
  agentId: string,
  agentType: string,
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): AsyncGenerator<AggregatedHookResult> {
  const hookInput: SubagentStartHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'SubagentStart',
    agent_id: agentId,
    agent_type: agentType,
  }

  yield* executeHooks({
    hookInput,
    toolUseID: randomUUID(),
    matchQuery: agentType,
    signal,
    timeoutMs,
  })
}

/**
 * PreCompact: runs before compaction, matched on the trigger. Successful
 * hook output becomes extra custom instructions for the summarizer, and
 * every run contributes a per-command line to the operator display.
 */
export async function executePreCompactHooks(
  compactData: {
    trigger: 'manual' | 'auto'
    customInstructions: string | null
  },
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): Promise<{
  newCustomInstructions?: string
  userDisplayMessage?: string
}> {
  const hookInput: PreCompactHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'PreCompact',
    trigger: compactData.trigger,
    custom_instructions: compactData.customInstructions,
  }

  const results = await executeHooksOutsideREPL({
    hookInput,
    matchQuery: compactData.trigger,
    signal,
    timeoutMs,
  })

  if (results.length === 0) {
    return {}
  }

  // Instructions come only from hooks that succeeded AND said something.
  const successfulOutputs = results
    .filter(result => result.succeeded && result.output.trim().length > 0)
    .map(result => result.output.trim())

  // The operator display names each command with its outcome.
  const displayMessages: string[] = []
  for (const result of results) {
    if (result.succeeded) {
      if (result.output.trim()) {
        displayMessages.push(
          `PreCompact [${result.command}] completed successfully: ${result.output.trim()}`,
        )
      } else {
        displayMessages.push(
          `PreCompact [${result.command}] completed successfully`,
        )
      }
    } else {
      if (result.output.trim()) {
        displayMessages.push(
          `PreCompact [${result.command}] failed: ${result.output.trim()}`,
        )
      } else {
        displayMessages.push(`PreCompact [${result.command}] failed`)
      }
    }
  }

  return {
    newCustomInstructions:
      successfulOutputs.length > 0 ? successfulOutputs.join('\n\n') : undefined,
    userDisplayMessage:
      displayMessages.length > 0 ? displayMessages.join('\n') : undefined,
  }
}

/**
 * PostCompact: runs after compaction with the summary in hand, matched on
 * the trigger. Observational — its only product is the operator display.
 */
export async function executePostCompactHooks(
  compactData: {
    trigger: 'manual' | 'auto'
    compactSummary: string
  },
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): Promise<{
  userDisplayMessage?: string
}> {
  const hookInput: PostCompactHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'PostCompact',
    trigger: compactData.trigger,
    compact_summary: compactData.compactSummary,
  }

  const results = await executeHooksOutsideREPL({
    hookInput,
    matchQuery: compactData.trigger,
    signal,
    timeoutMs,
  })

  if (results.length === 0) {
    return {}
  }

  const displayMessages: string[] = []
  for (const result of results) {
    if (result.succeeded) {
      if (result.output.trim()) {
        displayMessages.push(
          `PostCompact [${result.command}] completed successfully: ${result.output.trim()}`,
        )
      } else {
        displayMessages.push(
          `PostCompact [${result.command}] completed successfully`,
        )
      }
    } else {
      if (result.output.trim()) {
        displayMessages.push(
          `PostCompact [${result.command}] failed: ${result.output.trim()}`,
        )
      } else {
        displayMessages.push(`PostCompact [${result.command}] failed`)
      }
    }
  }

  return {
    userDisplayMessage:
      displayMessages.length > 0 ? displayMessages.join('\n') : undefined,
  }
}

/**
 * SessionEnd: the shutdown event, matched on the exit reason, and the one
 * place session-scoped hooks are cleared. Runs under the tight shutdown
 * timeout its callers pass (getSessionEndHookTimeoutMs).
 */
export async function executeSessionEndHooks(
  reason: ExitReason,
  options?: {
    getAppState?: () => AppState
    setAppState?: (updater: (prev: AppState) => AppState) => void
    signal?: AbortSignal
    timeoutMs?: number
  },
): Promise<void> {
  const {
    getAppState,
    setAppState,
    signal,
    timeoutMs = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  } = options || {}

  const hookInput: SessionEndHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'SessionEnd',
    reason,
  }

  const results = await executeHooksOutsideREPL({
    getAppState,
    hookInput,
    matchQuery: reason,
    signal,
    timeoutMs,
  })

  // Ink is already unmounted at shutdown — bare stderr is the only surface
  // left for failure visibility.
  for (const result of results) {
    if (!result.succeeded && result.output) {
      process.stderr.write(
        `SessionEnd hook [${result.command}] failed: ${result.output}\n`,
      )
    }
  }

  // Session-scoped hooks die with the session — after their last event ran.
  if (setAppState) {
    const sessionId = getSessionId()
    clearSessionHooks(setAppState, sessionId)
  }
}

/**
 * PermissionRequest: runs where a consent prompt would appear, matched on
 * the tool name, with the would-be "always allow" suggestions in the
 * input. A hook's decision object answers in the prompt's place — the
 * wrapper band re-checks any rewritten input against the rules before an
 * allow stands (guardHookUpdatedInput).
 */
export async function* executePermissionRequestHooks<ToolInput>(
  toolName: string,
  toolUseID: string,
  toolInput: ToolInput,
  toolUseContext: ToolUseContext,
  permissionMode?: string,
  permissionSuggestions?: PermissionUpdate[],
  signal?: AbortSignal,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  requestPrompt?: (
    sourceName: string,
    toolInputSummary?: string | null,
  ) => (request: PromptRequest) => Promise<PromptResponse>,
  toolInputSummary?: string | null,
): AsyncGenerator<AggregatedHookResult> {
  logForDebugging(`executePermissionRequestHooks called for tool: ${toolName}`)

  const hookInput: PermissionRequestHookInput = {
    ...createBaseHookInput(permissionMode, undefined, toolUseContext),
    hook_event_name: 'PermissionRequest',
    tool_name: toolName,
    tool_input: toolInput,
    permission_suggestions: permissionSuggestions,
  }

  yield* executeHooks({
    hookInput,
    toolUseID,
    matchQuery: toolName,
    signal,
    timeoutMs,
    toolUseContext,
    requestPrompt,
    toolInputSummary,
  })
}

/**
 * ConfigChange: the file watchers report a settings/skills/commands change
 * on disk, matched on which config source moved — the audit trail for a
 * live-edited workspace.
 *
 * One carve-out: policy settings are management-owned, so hooks observe
 * their changes but can never block them — a policy-source result comes
 * back with `blocked` forced false.
 */
export async function executeConfigChangeHooks(
  source: ConfigChangeSource,
  filePath?: string,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): Promise<HookOutsideReplResult[]> {
  const hookInput: ConfigChangeHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'ConfigChange',
    source,
    file_path: filePath,
  }

  const results = await executeHooksOutsideREPL({
    hookInput,
    timeoutMs,
    matchQuery: source,
  })

  // The policy carve-out from the JSDoc: observed, never blockable.
  if (source === 'policy_settings') {
    return results.map(r => ({ ...r, blocked: false }))
  }

  return results
}

async function executeEnvHooks(
  hookInput: HookInput,
  timeoutMs: number,
): Promise<{
  results: HookOutsideReplResult[]
  watchPaths: string[]
  systemMessages: string[]
}> {
  const results = await executeHooksOutsideREPL({ hookInput, timeoutMs })
  if (results.length > 0) {
    invalidateSessionEnvCache()
  }
  const watchPaths = results.flatMap(r => r.watchPaths ?? [])
  const systemMessages = results
    .map(r => r.systemMessage)
    .filter((m): m is string => !!m)
  return { results, watchPaths, systemMessages }
}

export function executeCwdChangedHooks(
  oldCwd: string,
  newCwd: string,
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): Promise<{
  results: HookOutsideReplResult[]
  watchPaths: string[]
  systemMessages: string[]
}> {
  const hookInput: CwdChangedHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'CwdChanged',
    old_cwd: oldCwd,
    new_cwd: newCwd,
  }
  return executeEnvHooks(hookInput, timeoutMs)
}

export function executeFileChangedHooks(
  filePath: string,
  event: 'change' | 'add' | 'unlink',
  timeoutMs: number = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
): Promise<{
  results: HookOutsideReplResult[]
  watchPaths: string[]
  systemMessages: string[]
}> {
  const hookInput: FileChangedHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'FileChanged',
    file_path: filePath,
    event,
  }
  return executeEnvHooks(hookInput, timeoutMs)
}

/**
 * Cheap existence probe for InstructionsLoaded hooks — instruction files
 * load often enough that building a hook input per file would be pure
 * waste in the (common) unconfigured case. Consults the settings snapshot
 * and the registered hooks; session-derived hooks are internal machinery
 * and deliberately not counted.
 */
export function hasInstructionsLoadedHook(): boolean {
  const snapshotHooks = getHooksConfigFromSnapshot()?.['InstructionsLoaded']
  if (snapshotHooks && snapshotHooks.length > 0) return true
  const registeredHooks = getRegisteredHooks()?.['InstructionsLoaded']
  if (registeredHooks && registeredHooks.length > 0) return true
  return false
}

/**
 * InstructionsLoaded: an instruction file (a project guide or a rules file
 * from any config home) just entered context, matched on the load reason.
 * Observability only — fire-and-forget, no blocking lane.
 *
 * Three places dispatch it:
 * - session start, when the engine loads the instruction set eagerly;
 * - after compaction, when runPostCompactCleanup clears the instruction
 *   cache and the reload reports load_reason 'compact';
 * - lazily, when a touched file pulls in a nested guide or a paths:-scoped
 *   rule (the attachment layer's memoryFilesToAttachments).
 */
export async function executeInstructionsLoadedHooks(
  filePath: string,
  memoryType: InstructionsMemoryType,
  loadReason: InstructionsLoadReason,
  options?: {
    globs?: string[]
    triggerFilePath?: string
    parentFilePath?: string
    timeoutMs?: number
  },
): Promise<void> {
  const {
    globs,
    triggerFilePath,
    parentFilePath,
    timeoutMs = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  } = options ?? {}

  const hookInput: InstructionsLoadedHookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'InstructionsLoaded',
    file_path: filePath,
    memory_type: memoryType,
    load_reason: loadReason,
    globs,
    trigger_file_path: triggerFilePath,
    parent_file_path: parentFilePath,
  }

  await executeHooksOutsideREPL({
    hookInput,
    timeoutMs,
    matchQuery: loadReason,
  })
}


export async function executeElicitationHooks({
  serverName,
  message,
  requestedSchema,
  permissionMode,
  signal,
  timeoutMs = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  mode,
  url,
  elicitationId,
}: {
  serverName: string
  message: string
  requestedSchema?: Record<string, unknown>
  permissionMode?: string
  signal?: AbortSignal
  timeoutMs?: number
  mode?: 'form' | 'url'
  url?: string
  elicitationId?: string
}): Promise<ElicitationHookResult> {
  const hookInput: ElicitationHookInput = {
    ...createBaseHookInput(permissionMode),
    hook_event_name: 'Elicitation',
    mcp_server_name: serverName,
    message,
    mode,
    url,
    elicitation_id: elicitationId,
    requested_schema: requestedSchema,
  }

  const results = await executeHooksOutsideREPL({
    hookInput,
    matchQuery: serverName,
    signal,
    timeoutMs,
  })

  let elicitationResponse: ElicitationResponse | undefined
  let blockingError: HookBlockingError | undefined

  for (const result of results) {
    const parsed = parseElicitationHookOutput(result, 'Elicitation')
    if (parsed.blockingError) {
      blockingError = parsed.blockingError
    }
    if (parsed.response) {
      elicitationResponse = parsed.response
    }
  }

  return { elicitationResponse, blockingError }
}

export async function executeElicitationResultHooks({
  serverName,
  action,
  content,
  permissionMode,
  signal,
  timeoutMs = TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  mode,
  elicitationId,
}: {
  serverName: string
  action: 'accept' | 'decline' | 'cancel'
  content?: Record<string, unknown>
  permissionMode?: string
  signal?: AbortSignal
  timeoutMs?: number
  mode?: 'form' | 'url'
  elicitationId?: string
}): Promise<ElicitationResultHookResult> {
  const hookInput: ElicitationResultHookInput = {
    ...createBaseHookInput(permissionMode),
    hook_event_name: 'ElicitationResult',
    mcp_server_name: serverName,
    elicitation_id: elicitationId,
    mode,
    action,
    content,
  }

  const results = await executeHooksOutsideREPL({
    hookInput,
    matchQuery: serverName,
    signal,
    timeoutMs,
  })

  let elicitationResultResponse: ElicitationResponse | undefined
  let blockingError: HookBlockingError | undefined

  for (const result of results) {
    const parsed = parseElicitationHookOutput(result, 'ElicitationResult')
    if (parsed.blockingError) {
      blockingError = parsed.blockingError
    }
    if (parsed.response) {
      elicitationResultResponse = parsed.response
    }
  }

  return { elicitationResultResponse, blockingError }
}

/**
 * The file-suggestion command: one configured command whose stdout lines
 * become the suggestion list. Trust-gated, short leash, empty list on any
 * failure.
 */
export async function executeFileSuggestionCommand(
  fileSuggestionInput: FileSuggestionCommandInput,
  signal?: AbortSignal,
  timeoutMs: number = 5000, // typeahead — suggestions late are suggestions lost
): Promise<string[]> {
  if (shouldDisableAllHooksIncludingManaged()) {
    return []
  }

  // SECURITY: the workspace-trust gate — a suggestion command is still a
  // command from workspace config.
  if (shouldSkipHookDueToTrust()) {
    logForDebugging(
      `Skipping FileSuggestion command execution - workspace trust not accepted`,
    )
    return []
  }

  // Managed-only policy: only the policy settings' fileSuggestion runs.
  let fileSuggestion
  if (shouldAllowManagedHooksOnly()) {
    fileSuggestion = getSettingsForSource('policySettings')?.fileSuggestion
  } else {
    fileSuggestion = getSettings_DEPRECATED()?.fileSuggestion
  }

  if (!fileSuggestion || fileSuggestion.type !== 'command') {
    return []
  }

  const abortSignal = signal || AbortSignal.timeout(timeoutMs)

  try {
    const jsonInput = jsonStringify(fileSuggestionInput)

    const hook = { type: 'command' as const, command: fileSuggestion.command }

    const result = await execCommandHook(
      hook,
      'FileSuggestion',
      'FileSuggestion',
      jsonInput,
      abortSignal,
      randomUUID(),
    )

    if (result.aborted || result.status !== 0) {
      return []
    }

    return result.stdout
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
  } catch (error) {
    logForDebugging(`File suggestion helper failed: ${error}`, {
      level: 'error',
    })
    return []
  }
}


/**
 * Existence probe for WorktreeCreate hooks, consulted before the worktree
 * machinery commits to the hook path over its git fallback.
 *
 * The probe MUST mirror getHooksConfig()'s managed-only filtering: an extension
 * matcher that execution would skip must not count here, or the probe says
 * "hook exists", execution finds nothing, executeWorktreeCreateHook throws,
 * and the git-worktree fallback is wrongly blocked.
 */
export function hasWorktreeCreateHook(): boolean {
  const snapshotHooks = getHooksConfigFromSnapshot()?.['WorktreeCreate']
  if (snapshotHooks && snapshotHooks.length > 0) return true
  const registeredHooks = getRegisteredHooks()?.['WorktreeCreate']
  if (!registeredHooks || registeredHooks.length === 0) return false
  // The mirror of getHooksConfig()'s managed-only extension filter.
  const managedOnly = shouldAllowManagedHooksOnly()
  return registeredHooks.some(
    matcher => !(managedOnly && 'extensionRoot' in matcher),
  )
}

/**
 * WorktreeCreate: a configured hook provisions the worktree and prints its
 * path — the return value here. No successful path means a throw; callers
 * gate on hasWorktreeCreateHook() first.
 */
export async function executeWorktreeCreateHook(
  name: string,
): Promise<{ worktreePath: string }> {
  const hookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'WorktreeCreate' as const,
    name,
  }

  const results = await executeHooksOutsideREPL({
    hookInput,
    timeoutMs: TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  })

  // The worktree path is the first success that actually printed one.
  const successfulResult = results.find(
    r => r.succeeded && r.output.trim().length > 0,
  )

  if (!successfulResult) {
    const failedOutputs = results
      .filter(r => !r.succeeded)
      .map(r => `${r.command}: ${r.output.trim() || 'no output'}`)
    throw new Error(
      `WorktreeCreate hook failed: ${failedOutputs.join('; ') || 'no successful output'}`,
    )
  }

  const worktreePath = successfulResult.output.trim()
  return { worktreePath }
}

/**
 * WorktreeRemove: the teardown twin. True means hooks were configured and
 * ran (failures logged, not thrown); false means nothing was configured
 * and the caller should remove the worktree itself.
 */
export async function executeWorktreeRemoveHook(
  worktreePath: string,
): Promise<boolean> {
  const snapshotHooks = getHooksConfigFromSnapshot()?.['WorktreeRemove']
  const registeredHooks = getRegisteredHooks()?.['WorktreeRemove']
  const hasSnapshotHooks = snapshotHooks && snapshotHooks.length > 0
  const hasRegisteredHooks = registeredHooks && registeredHooks.length > 0
  if (!hasSnapshotHooks && !hasRegisteredHooks) {
    return false
  }

  const hookInput = {
    ...createBaseHookInput(undefined),
    hook_event_name: 'WorktreeRemove' as const,
    worktree_path: worktreePath,
  }

  const results = await executeHooksOutsideREPL({
    hookInput,
    timeoutMs: TOOL_HOOK_EXECUTION_TIMEOUT_MS,
  })

  if (results.length === 0) {
    return false
  }

  for (const result of results) {
    if (!result.succeeded) {
      logForDebugging(
        `WorktreeRemove hook failed [${result.command}]: ${result.output.trim()}`,
        { level: 'error' },
      )
    }
  }

  return true
}
