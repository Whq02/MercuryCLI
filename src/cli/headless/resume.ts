
import { randomUUID, type UUID } from 'crypto'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import {
  getSessionId,
  isSessionPersistenceDisabled,
  setMainLoopModelOverride,
  switchSession,
} from 'src/bootstrap/state.js'
import { EMPTY_USAGE } from 'src/services/api/logging.js'
import { armProvisionalSessionReconcile } from 'src/utils/provisionalSessionReconcile.js'
import { isPolicyAllowed } from 'src/services/policyLimits/index.js'
import type { AppState } from 'src/state/AppStateStore.js'
import { asSessionId } from 'src/types/ids.js'
import type { Message, NormalizedUserMessage } from 'src/types/message.js'
import { binaryName } from 'src/utils/config.js'
import {
  hasConversationTurn,
  loadConversationForResume,
  type TurnInterruptionState,
} from 'src/utils/conversationRecovery.js'
import { gracefulShutdownSync } from 'src/utils/gracefulShutdown.js'
import { logError } from 'src/utils/log.js'
import { restoreSessionStateFromLog } from 'src/utils/sessionRestore.js'
import { processSessionStartHooks } from 'src/utils/sessionStart.js'
import { consumeSessionHomePin } from 'src/utils/sessionStorage/sessionHomePin.js'
import {
  resetSessionFilePointer,
  restoreSessionMetadata,
} from 'src/utils/sessionStorage.js'
import { parseSessionIdentifier } from 'src/utils/sessionUrl.js'
import { errorMessage } from '../../utils/errors.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { jsonStringify } from '../../utils/slowOperations.js'

export function emitLoadError(
  message: string,
  outputFormat: string | undefined,
): void {
  if (outputFormat === 'stream-json') {
    const errorResult = {
      type: 'result',
      subtype: 'error_during_execution',
      duration_ms: 0,
      duration_api_ms: 0,
      is_error: true,
      num_turns: 0,
      stop_reason: null,
      session_id: getSessionId(),
      total_cost_usd: 0,
      usage: EMPTY_USAGE,
      model_usage: {},
      permission_denials: [],
      uuid: randomUUID(),
      errors: [message],
    }
    process.stdout.write(jsonStringify(errorResult) + '\n')
  } else {
    process.stderr.write(message + '\n')
  }
}

export function removeInterruptedMessage(
  messages: Message[],
  interruptedUserMessage: NormalizedUserMessage,
): void {
  const idx = messages.findIndex(m => m.uuid === interruptedUserMessage.uuid)
  if (idx !== -1) {
    messages.splice(idx, 2)
  }
}

type LoadInitialMessagesResult = {
  messages: Message[]
  turnInterruptionState?: TurnInterruptionState
  agentSetting?: string
}

export async function loadInitialMessages(
  setAppState: (f: (prev: AppState) => AppState) => void,
  options: {
    continue: boolean | undefined
    resume: string | boolean | undefined
    resumeSessionAt: string | undefined
    forkSession: boolean | undefined
    outputFormat: string | undefined
    sessionStartHooksPromise?: ReturnType<typeof processSessionStartHooks>
  },
): Promise<LoadInitialMessagesResult> {
  const persistSession = !isSessionPersistenceDisabled()
  armProvisionalSessionReconcile()

  if (options.continue) {
    try {
      const result = await loadConversationForResume(
        undefined ,
        undefined ,
      )
      if (result && hasConversationTurn(result.messages)) {
        if (!options.forkSession) {
          if (result.sessionId) {
            switchSession(
              asSessionId(result.sessionId),
              result.fullPath ? dirname(result.fullPath) : null,
            )
            if (persistSession) {
              await resetSessionFilePointer()
            }
          }
        }
        restoreSessionStateFromLog(result, setAppState)

        restoreSessionMetadata(
          options.forkSession
            ? { ...result, worktreeSession: undefined }
            : result,
        )

        return {
          messages: result.messages,
          turnInterruptionState: result.turnInterruptionState,
          agentSetting: result.agentSetting,
        }
      }
      emitLoadError('No conversation found to continue', options.outputFormat)
      gracefulShutdownSync(1)
      return { messages: [] }
    } catch (error) {
      logError(error)
      gracefulShutdownSync(1)
      return { messages: [] }
    }
  }

  if (options.resume !== undefined && options.resume !== false) {
    try {
      const parsedSessionId = parseSessionIdentifier(
        typeof options.resume === 'string' ? options.resume : '',
      )
      if (!parsedSessionId) {
        let errorMessage =
          `Error: --resume requires a valid session ID when used with --print. Usage: ${binaryName()} -p --resume <session-id>`
        if (typeof options.resume === 'string') {
          errorMessage += `. Session IDs must be in UUID format (e.g., 550e8400-e29b-41d4-a716-446655440000). Provided value "${options.resume}" is not a valid UUID`
        }
        emitLoadError(errorMessage, options.outputFormat)
        gracefulShutdownSync(1)
        return { messages: [] }
      }

      const homePin = consumeSessionHomePin()
      const pinnedFile =
        homePin !== null && !parsedSessionId.jsonlFile
          ? join(homePin, `${parsedSessionId.sessionId}.jsonl`)
          : undefined
      const result = await loadConversationForResume(
        parsedSessionId.sessionId,
        parsedSessionId.jsonlFile ||
          (pinnedFile !== undefined && existsSync(pinnedFile)
            ? pinnedFile
            : undefined),
      )

      if (!result || !hasConversationTurn(result.messages)) {
        emitLoadError(
          parsedSessionId.isJsonlFile || parsedSessionId.isUrl
            ? `No conversation could be loaded from: ${typeof options.resume === 'string' ? options.resume : parsedSessionId.sessionId}`
            : `No conversation found with session ID: ${parsedSessionId.sessionId}`,
          options.outputFormat,
        )
        gracefulShutdownSync(1)
        return { messages: [] }
      }

      if (options.resumeSessionAt) {
        const index = result.messages.findIndex(
          m => m.uuid === options.resumeSessionAt,
        )
        if (index < 0) {
          emitLoadError(
            `No message found with message.uuid of: ${options.resumeSessionAt}`,
            options.outputFormat,
          )
          gracefulShutdownSync(1)
          return { messages: [] }
        }

        result.messages = result.messages.slice(0, index + 1)
      }

      if (!options.forkSession && result.sessionId) {
        switchSession(
          asSessionId(result.sessionId),
          result.fullPath ? dirname(result.fullPath) : null,
        )
        if (persistSession) {
          await resetSessionFilePointer()
        }
      }
      restoreSessionStateFromLog(result, setAppState)

      restoreSessionMetadata(
        options.forkSession
          ? { ...result, worktreeSession: undefined }
          : result,
      )

      return {
        messages: result.messages,
        turnInterruptionState: result.turnInterruptionState,
        agentSetting: result.agentSetting,
      }
    } catch (error) {
      logError(error)
      const errorMessage =
        error instanceof Error
          ? `Failed to resume session: ${error.message}`
          : 'Failed to resume session with --print mode'
      emitLoadError(errorMessage, options.outputFormat)
      gracefulShutdownSync(1)
      return { messages: [] }
    }
  }

  return {
    messages: await (options.sessionStartHooksPromise ??
      processSessionStartHooks('startup')),
  }
}
