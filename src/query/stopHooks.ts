import type { Message, UserMessage } from '../types/message.js'
import type { AssistantMessage } from '../types/message.js'
import type { ToolUseContext } from '../Tool.js'
import type { QuerySource } from '../constants/querySource.js'
import type { SystemPrompt } from '../utils/systemPromptType.js'
import type { ChatHookContext } from '../utils/hooks/postSamplingHooks.js'
import {
  executeStopHooks,
} from '../utils/hooks/events.js'
import {
  createCacheSafeParams,
  saveCacheSafeParams,
} from '../utils/forkedAgent.js'
import { isBareMode } from '../utils/envUtils.js'
import { createUserMessage } from '../utils/messages/factories.js'
import {
  createStopHookSummaryMessage,
  createSystemMessage,
} from '../utils/messages/systemMessages.js'
import { createAttachmentMessage } from '../utils/attachments.js'
import { createUserInterruptionMessage } from '../utils/messages/factories.js'
import { extractTextContent } from '../utils/messages/text.js'
import { getSessionId } from '../bootstrap/state.js'
import { logForDebugging } from '../utils/debug.js'
import { errorMessage } from '../utils/errors.js'
import { runTurnSettlementEffects } from './settlementEffects.js'

export type StopHookOutcome = {
  blockingErrors: UserMessage[]
  preventContinuation: boolean
}

const MAIN_THREAD_SOURCE = 'main_thread'
const SDK_SOURCE = 'sdk'

type StopHookInfo = { command: string; promptText?: string; durationMs?: number }

type ExecutorStream = ReturnType<typeof executeStopHooks>

async function* consumeHookStream(
  stream: ExecutorStream,
  options: {
    formatBlockingError: (error: { blockingError: string; command: string }) => string
    defaultStopReason: string
    attachmentEvent: 'Stop'
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
        yield createUserInterruptionMessage({ toolUse: false, reason: options.signal?.reason })
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
  const hookContext: ChatHookContext = {
    messages: [...messagesForQuery, ...assistantMessages],
    systemPrompt,
    userContext,
    systemContext,
    toolUseContext,
    querySource,
  }
  const turnStartTime = Date.now()

  if (querySource === MAIN_THREAD_SOURCE || querySource === SDK_SOURCE) {
    saveCacheSafeParams(createCacheSafeParams(hookContext))
  }

  const agentId = toolUseContext.agentId

  if (!isBareMode()) {
    {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const suggestion = require('../services/PromptSuggestion/promptSuggestion.js') as {
        executePromptSuggestion: (context: ChatHookContext) => Promise<void>
      }
      void suggestion.executePromptSuggestion(hookContext).catch(error => {
        logForDebugging(`prompt suggestion failed: ${errorMessage(error)}`)
      })
    }
    if (!agentId) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mneme = require('../mneme/mnemeMaintenance.js') as {
        scheduleMnemeMaintenance: (trigger: 'turn-end') => void
      }
      mneme.scheduleMnemeMaintenance('turn-end')
    }
  }

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

  try {
    const permissionMode = toolUseContext.getAppState().toolPermissionContext.mode
    const signal = toolUseContext.abortController.signal
    const history = [...messagesForQuery, ...assistantMessages]

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
  } catch (error) {
    void turnStartTime
    yield createSystemMessage(
      `Stop hook failed: ${errorMessage(error)}`,
      'warning',
    )
    return { blockingErrors: settlementBlocks, preventContinuation: false }
  }

  return { blockingErrors: settlementBlocks, preventContinuation: false }
}
