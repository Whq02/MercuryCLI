// ============================================================================
//  src/query/stopHooks.ts — the turn-end orchestration: cache-safe param
//  snapshot, background bookkeeping, the brief-mode enforcement sentinel,
//  stop hooks proper, and the teammate lifecycle hooks. Yields stream
//  items as they happen; returns {blockingErrors, preventContinuation}.
// ============================================================================
import type { Message, UserMessage } from '../types/message.js'
import type { AssistantMessage } from '../types/message.js'
import type { ToolUseContext } from '../Tool.js'
import type { QuerySource } from '../constants/querySource.js'
import type { SystemPrompt } from '../utils/systemPromptType.js'
import type { REPLHookContext } from '../utils/hooks/postSamplingHooks.js'
import {
  executeStopHooks,
  executeTaskCompletedHooks,
  executeTeammateIdleHooks,
} from '../utils/hooks/events.js'
import {
  createCacheSafeParams,
  saveCacheSafeParams,
} from '../utils/forkedAgent.js'
import { isBareMode, isEnvTruthy } from '../utils/envUtils.js'
import { createUserMessage } from '../utils/messages/factories.js'
import {
  createStopHookSummaryMessage,
  createSystemMessage,
} from '../utils/messages/systemMessages.js'
import { createAttachmentMessage } from '../utils/attachments.js'
import { createUserInterruptionMessage } from '../utils/messages/factories.js'
import { extractTextContent } from '../utils/messages/text.js'
import { getSessionId, getParentSessionId } from '../bootstrap/state.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { runTurnSettlementEffects } from './settlementEffects.js'

export type StopHookOutcome = {
  blockingErrors: UserMessage[]
  preventContinuation: boolean
}

const MAIN_THREAD_SOURCE = 'repl_main_thread'
const SDK_SOURCE = 'sdk'

type StopHookInfo = { command: string; promptText?: string; durationMs?: number }

/** True when any message in `messages` carries a tool_use block naming one
 *  of `toolNames`. */
function usesAnyTool(messages: Message[], toolNames: readonly string[]): boolean {
  for (const message of messages) {
    if (message.type !== 'assistant') continue
    const content = message.message.content
    if (!Array.isArray(content)) continue
    for (const block of content) {
      if (
        typeof block === 'object' &&
        block !== null &&
        (block as { type?: string }).type === 'tool_use' &&
        toolNames.includes((block as { name?: string }).name ?? '')
      ) {
        return true
      }
    }
  }
  return false
}

/** Everything after the last REAL user turn (not meta, not a tool result). */
function windowAfterLastRealUserTurn(history: Message[]): Message[] {
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i]!
    if (message.type !== 'user') continue
    if ((message as { isMeta?: boolean }).isMeta) continue
    const content = message.message.content
    const isToolResult =
      Array.isArray(content) &&
      content.some(
        block =>
          typeof block === 'object' &&
          block !== null &&
          (block as { type?: string }).type === 'tool_result',
      )
    if (isToolResult) continue
    return history.slice(i + 1)
  }
  return history
}

/** A meta user message whose string content contains `marker`. */
function hasMetaMessageContaining(messages: Message[], marker: string): boolean {
  return messages.some(
    message =>
      message.type === 'user' &&
      (message as { isMeta?: boolean }).isMeta === true &&
      typeof message.message.content === 'string' &&
      message.message.content.includes(marker),
  )
}

/**
 * Phase 4: the brief-mode enforcement sentinel. Runs entirely behind
 * runtime requires; any failure logs at error level and never disturbs
 * the turn.
 */
async function* briefModeSentinel(
  messagesForQuery: Message[],
  assistantMessages: AssistantMessage[],
  toolUseContext: ToolUseContext,
): AsyncGenerator<UserMessage> {
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const briefTool = require('../tools/BriefTool/BriefTool.js') as {
      isBriefEnabled: () => boolean
    }
    if (!briefTool.isBriefEnabled()) return
    const briefPrompt = require('../tools/BriefTool/prompt.js') as {
      BRIEF_TOOL_NAME: string
      LEGACY_BRIEF_TOOL_NAME: string
      BRIEF_ENFORCE_SENTINEL: string
      BRIEF_RECAP_SENTINEL: string
      getBriefEnforceText: () => string
      getBriefRecapText: () => string
    }
    const questionTool = require('../tools/AskUserQuestionTool/prompt.js') as {
      ASK_USER_QUESTION_TOOL_NAME: string
    }
    const briefFilters = require('../utils/messages/briefFilters.js') as {
      hasTrailingTextAfterBrief: (messages: Message[]) => boolean
    }
    /* eslint-enable @typescript-eslint/no-require-imports */

    // The brief tool must actually be in this turn's tool set.
    const toolNames = toolUseContext.options.tools.map(tool => tool.name)
    if (
      !toolNames.includes(briefPrompt.BRIEF_TOOL_NAME) &&
      !toolNames.includes(briefPrompt.LEGACY_BRIEF_TOOL_NAME)
    ) {
      return
    }

    const history = [...messagesForQuery, ...assistantMessages]
    const window = windowAfterLastRealUserTurn(history)
    const addressedTools = [
      briefPrompt.BRIEF_TOOL_NAME,
      briefPrompt.LEGACY_BRIEF_TOOL_NAME,
      // A blocking question renders to the user and was answered — a
      // question-only turn must not be nagged.
      questionTool.ASK_USER_QUESTION_TOOL_NAME,
    ]
    const addressed =
      usesAnyTool(window, addressedTools) || usesAnyTool(assistantMessages, addressedTools)

    if (!addressed) {
      if (!hasMetaMessageContaining(window, briefPrompt.BRIEF_ENFORCE_SENTINEL)) {
        yield createUserMessage({
          content: `${briefPrompt.BRIEF_ENFORCE_SENTINEL} ${briefPrompt.getBriefEnforceText()}`,
          isMeta: true,
        })
      }
      return
    }

    // Trailing-recap: taught once per session, keyed on the WHOLE history.
    if (
      !hasMetaMessageContaining(history, briefPrompt.BRIEF_RECAP_SENTINEL) &&
      briefFilters.hasTrailingTextAfterBrief(window)
    ) {
      yield createUserMessage({
        content: `${briefPrompt.BRIEF_RECAP_SENTINEL} ${briefPrompt.getBriefRecapText()}`,
        isMeta: true,
      })
    }
  } catch (error) {
    logForDebugging(`brief-mode stop hook failed: ${errorMessage(error)}`, { level: 'error' })
  }
}

type ExecutorStream = ReturnType<typeof executeStopHooks>

/**
 * Consume one hook-executor stream. `formatBlockingError` builds the meta
 * user message; `defaultStopReason`/`attachmentEvent` shape the
 * prevented-continuation attachment; `yieldInterruptionOnAbort`
 * distinguishes phase 5 (yields one) from phase 6 (does not).
 */
async function* consumeHookStream(
  stream: ExecutorStream,
  options: {
    formatBlockingError: (error: { blockingError: string; command: string }) => string
    defaultStopReason: string
    attachmentEvent: 'Stop' | 'TaskCompleted' | 'TeammateIdle'
    yieldInterruptionOnAbort: boolean
    signal: AbortSignal | undefined
    track: {
      hookCount: { value: number }
      hookInfos: StopHookInfo[]
      hookErrors: string[]
      hasOutput: { value: boolean }
      toolUseID: { value: string | undefined }
    }
  },
): AsyncGenerator<Message, { blockingErrors: UserMessage[]; preventContinuation: boolean; stopReason?: string } | null> {
  const { track } = options
  const blockingErrors: UserMessage[] = []
  for await (const result of stream) {
    if (result.message) {
      const message = result.message as Message
      if (message.type === 'progress') {
        const toolUseID = (message as { toolUseID?: string }).toolUseID
        if (toolUseID) {
          track.toolUseID.value = toolUseID
          track.hookCount.value++
        }
        const data = (message as { data?: { command?: string; promptText?: string } }).data
        if (data?.command) {
          track.hookInfos.push({ command: data.command, promptText: data.promptText })
        }
      } else if (message.type === 'attachment') {
        const attachment = message as {
          attachment?: {
            type?: string
            hookEvent?: string
            stderr?: string
            stdout?: string
            exitCode?: number
            content?: string
            durationMs?: number
            command?: string
          }
        }
        const payload = attachment.attachment
        if (
          payload &&
          (payload.hookEvent === 'Stop' || payload.hookEvent === 'SubagentStop')
        ) {
          if (payload.type === 'hook_non_blocking_error') {
            track.hookErrors.push(
              payload.stderr || `hook exited with code ${payload.exitCode ?? 'unknown'}`,
            )
            track.hasOutput.value = true
          } else if (payload.type === 'hook_error_during_execution') {
            track.hookErrors.push(payload.content ?? 'hook execution error')
            track.hasOutput.value = true
          } else if (
            (payload.stdout ?? '').trim() !== '' ||
            (payload.stderr ?? '').trim() !== ''
          ) {
            track.hasOutput.value = true
          }
        }
        // Duration correlation: first hook-info with the same command and
        // no duration yet (hooks run in parallel; positional match).
        if (payload?.durationMs !== undefined && payload.command !== undefined) {
          const info = track.hookInfos.find(
            entry => entry.command === payload.command && entry.durationMs === undefined,
          )
          if (info) info.durationMs = payload.durationMs
        }
      }
      yield message
    }
    if (result.blockingError) {
      const blockingError = result.blockingError
      const message = createUserMessage({
        content: options.formatBlockingError(blockingError),
        isMeta: true,
      })
      blockingErrors.push(message)
      yield message
      // A SILENT blocking error (stamp-only keep-working channel) still
      // re-prompts the model, but never surfaces: no error row, no
      // has-output, no notification. The field lives on the hook
      // runtime's own blocking-error type, not this slice's vocabulary.
      if (!(blockingError as { silent?: boolean }).silent) {
        track.hookErrors.push(blockingError.blockingError)
        track.hasOutput.value = true
      }
    }
    if (result.preventContinuation) {
      const stopReason = result.stopReason ?? options.defaultStopReason
      yield createAttachmentMessage({
        type: 'hook_stopped_continuation',
        message: stopReason,
        hookName: options.attachmentEvent,
        hookEvent: options.attachmentEvent,
        toolUseID: track.toolUseID.value ?? '',
      })
      return { blockingErrors, preventContinuation: true, stopReason }
    }
    if (options.signal?.aborted) {
      if (options.yieldInterruptionOnAbort) {
        yield createUserInterruptionMessage({ toolUse: false })
      }
      return { blockingErrors: [], preventContinuation: true }
    }
  }
  return blockingErrors.length > 0
    ? { blockingErrors, preventContinuation: false }
    : null
}

export async function* handleStopHooks(
  messagesForQuery: Message[],
  assistantMessages: AssistantMessage[],
  systemPrompt: SystemPrompt,
  userContext: { [k: string]: string },
  systemContext: { [k: string]: string },
  toolUseContext: ToolUseContext,
  querySource: QuerySource | undefined,
  stopHookActive?: boolean,
): AsyncGenerator<Message, StopHookOutcome> {
  // Phase 1 — snapshot the hook context.
  const hookContext: REPLHookContext = {
    messages: [...messagesForQuery, ...assistantMessages],
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext,
    querySource,
  }
  const turnStartTime = Date.now()

  // Phase 2 — cache-safe parameter snapshot. EXACT source equality (the
  // brief phase, by contrast, prefix-matches). Deliberately outside any
  // prompt-suggestion gate: the interactive side-question surface and the
  // SDK side-question control request both read it.
  if (querySource === MAIN_THREAD_SOURCE || querySource === SDK_SOURCE) {
    saveCacheSafeParams(createCacheSafeParams(hookContext))
  }

  const agentId = toolUseContext.agentId

  // Phase 3 — background bookkeeping (skipped in bare mode: scripted
  // non-interactive runs must not have auto-memory or forked agents
  // contending for resources during shutdown).
  if (!isBareMode()) {
    {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const suggestion = require('../services/PromptSuggestion/promptSuggestion.js') as {
        executePromptSuggestion: (context: REPLHookContext) => Promise<void>
      }
      void suggestion.executePromptSuggestion(hookContext).catch(error => {
        logForDebugging(`prompt suggestion failed: ${errorMessage(error)}`)
      })
    }
    if (!agentId) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const autoDream = require('../services/autoDream/autoDream.js') as {
        executeAutoDream: (
          context: REPLHookContext,
          appendSystemMessage?: ToolUseContext['appendSystemMessage'],
        ) => Promise<void>
      }
      void autoDream
        .executeAutoDream(hookContext, toolUseContext.appendSystemMessage)
        .catch(error => {
          logForDebugging(`auto-dream failed: ${errorMessage(error)}`)
        })
      // Cheap, deferred off the settle path; coalesces under the
      // consolidator lock. (Runtime require: the memdir graph must not
      // join this module's init chain — it is a turn-end-only dependency.)
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mneme = require('../memdir/mnemeMaintenance.js') as {
        scheduleMnemeMaintenance: (trigger: 'turn-end') => void
      }
      mneme.scheduleMnemeMaintenance('turn-end')
      // The C5 observation hook (opt-in): significant tool outcomes from
      // this turn flush as ONE buffered observation, through the same
      // validator-guarded path as every other write. Same runtime-require
      // discipline — a turn-end-only dependency.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const observe = require('../memdir/mnemeObserveTurn.js') as {
        flushMnemeTurnObservation: (owner: string) => boolean
      }
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const ownerResolve = require('../services/run/resolveOwner.js') as {
        ownerFromToolUseContext: (context: { owner?: unknown; agentId?: string }) => unknown
      }
      try {
        observe.flushMnemeTurnObservation(String(ownerResolve.ownerFromToolUseContext(toolUseContext)))
      } catch (error) {
        logForDebugging(`mneme turn observation failed: ${errorMessage(error)}`)
      }
    }
  }

  // Phase 4 — brief-mode enforcement sentinel.
  const mainThreadish =
    typeof querySource === 'string' &&
    (querySource.startsWith(MAIN_THREAD_SOURCE) || querySource === SDK_SOURCE)
  if (
    mainThreadish &&
    !agentId &&
    !isEnvTruthy(process.env.DISABLE_BRIEF_MODE_STOP_HOOK)
  ) {
    yield* briefModeSentinel(messagesForQuery, assistantMessages, toolUseContext)
  }

  // Phase 4b — ENGINE-owned turn-settlement effects (settlementEffects.ts):
  // the product's own settle-time semantics (the keep-working discipline),
  // typed and evaluated here — the
  // engine settles the turn; the user's hook registry below stays the
  // user's (law 3). A 'continue' decision re-prompts silently: a meta user
  // message the model sees, no error row, no notification — the delivery
  // the retired bundled Stop hooks used. Main thread only, like the Stop
  // event the hooks rode.
  const settlementBlocks: UserMessage[] = []
  if (!agentId) {
    const settlement = await runTurnSettlementEffects(String(getSessionId()), {
      messages: [...messagesForQuery, ...assistantMessages],
      signal: toolUseContext.abortController.signal,
    })
    for (const reprompt of settlement.reprompts) {
      const message = createUserMessage({ content: reprompt, isMeta: true })
      settlementBlocks.push(message)
      yield message
    }
  }

  // Phases 5 + 6 share ONE error wrapper: a teammate-hook failure must
  // land on the same warning message as a stop-hook failure.
  try {
    const permissionMode = toolUseContext.getAppState().toolPermissionContext.mode
    const signal = toolUseContext.abortController.signal
    const history = [...messagesForQuery, ...assistantMessages]

    // Phase 5 — stop hooks proper.
    const hookCount = { value: 0 }
    const hookInfos: StopHookInfo[] = []
    const hookErrors: string[] = []
    const hasOutput = { value: false }
    const stopToolUseID = { value: undefined as string | undefined }

    const stopOutcome = yield* consumeHookStream(
      executeStopHooks(
        permissionMode,
        signal,
        undefined,
        stopHookActive ?? false,
        agentId,
        toolUseContext,
        history,
        (toolUseContext.options as { mainThreadAgentType?: string }).mainThreadAgentType,
      ),
      {
        formatBlockingError: error => `Stop hook feedback:\n- ${error.blockingError}`,
        defaultStopReason: 'A stop hook prevented continuation',
        attachmentEvent: 'Stop',
        yieldInterruptionOnAbort: true,
        signal,
        track: {
          hookCount,
          hookInfos,
          hookErrors,
          hasOutput: hasOutput,
          toolUseID: stopToolUseID,
        },
      },
    )

    if (hookCount.value > 0) {
      yield createStopHookSummaryMessage(
        hookCount.value,
        hookInfos,
        hookErrors,
        stopOutcome?.preventContinuation ?? false,
        stopOutcome?.stopReason,
        hasOutput.value,
        'suggestion',
        stopToolUseID.value,
      )
    }
    if (hookErrors.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const shortcutFormat = require('../keybindings/shortcutFormat.js') as {
        getShortcutDisplay: (action: string, context: string, fallback: string) => string
      }
      const shortcut = shortcutFormat.getShortcutDisplay('app:toggleTranscript', 'Global', 'ctrl+o')
      toolUseContext.addNotification?.({
        key: 'stop-hook-error',
        text: `Stop hook error · ${shortcut} for transcript`,
        priority: 'immediate',
      })
    }
    if (stopOutcome?.preventContinuation) {
      return { blockingErrors: [], preventContinuation: true }
    }
    if (stopOutcome && stopOutcome.blockingErrors.length > 0) {
      return {
        blockingErrors: [...settlementBlocks, ...stopOutcome.blockingErrors],
        preventContinuation: false,
      }
    }

    // Phase 6 — teammate lifecycle hooks. (Runtime require: teammate and
    // task-list machinery are teammate-only dependencies.)
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const teammate = require('../utils/teammate.js') as {
      isTeammate: () => boolean
      getAgentName: () => string | undefined
      getTeamName: () => string | undefined
    }
    if (teammate.isTeammate()) {
      const teammateName = teammate.getAgentName() ?? ''
      const teamName = teammate.getTeamName() ?? ''
      const teammateToolUseID = { value: undefined as string | undefined }
      const teammateBlockingErrors: UserMessage[] = []

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const taskList = require('../utils/tasks.js') as {
        listTasks: (listId: string) => Promise<Array<{ id: string; subject: string; description?: string; status: string; owner?: string }>>
      }
      const taskListId = getParentSessionId() ?? String(getSessionId())
      const tasks = await taskList.listTasks(taskListId).catch(() => [])
      const mine = tasks.filter(
        task => task.status === 'in_progress' && task.owner === teammateName,
      )
      for (const task of mine) {
        const outcome = yield* consumeHookStream(
          executeTaskCompletedHooks(
            task.id,
            task.subject,
            task.description,
            teammateName,
            teamName,
            permissionMode,
            signal,
            undefined,
            toolUseContext,
          ),
          {
            formatBlockingError: error => `Task-completed hook feedback:\n- ${error.blockingError}`,
            defaultStopReason: 'A task-completed hook prevented continuation',
            attachmentEvent: 'TaskCompleted',
            yieldInterruptionOnAbort: false,
            signal,
            track: {
              hookCount: { value: 0 },
              hookInfos: [],
              hookErrors: [],
              hasOutput: { value: false },
              toolUseID: teammateToolUseID,
            },
          },
        )
        if (outcome?.preventContinuation) {
          return { blockingErrors: [], preventContinuation: true }
        }
        if (outcome) teammateBlockingErrors.push(...outcome.blockingErrors)
      }

      const idleOutcome = yield* consumeHookStream(
        executeTeammateIdleHooks(teammateName, teamName, permissionMode, signal),
        {
          formatBlockingError: error => `Teammate-idle hook feedback:\n- ${error.blockingError}`,
          defaultStopReason: 'A teammate-idle hook prevented continuation',
          attachmentEvent: 'TeammateIdle',
          yieldInterruptionOnAbort: false,
          signal,
          track: {
            hookCount: { value: 0 },
            hookInfos: [],
            hookErrors: [],
            hasOutput: { value: false },
            toolUseID: teammateToolUseID,
          },
        },
      )
      if (idleOutcome?.preventContinuation) {
        return { blockingErrors: [], preventContinuation: true }
      }
      if (idleOutcome) teammateBlockingErrors.push(...idleOutcome.blockingErrors)

      if (teammateBlockingErrors.length > 0) {
        return {
          blockingErrors: [...settlementBlocks, ...teammateBlockingErrors],
          preventContinuation: false,
        }
      }
    }
  } catch (error) {
    void turnStartTime
    yield createSystemMessage(
      `Stop hook failed: ${errorMessage(error)}`,
      'warning',
    )
    // Settlement effects already decided before the failing phase — their
    // re-prompts still drive the continuation.
    return { blockingErrors: settlementBlocks, preventContinuation: false }
  }

  return { blockingErrors: settlementBlocks, preventContinuation: false }
}
