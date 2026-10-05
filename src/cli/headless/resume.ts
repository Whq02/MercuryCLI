
import { type UUID } from 'crypto'
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import {
  isSessionPersistenceDisabled,
  setEngineModelOverride,
  switchSession,
} from 'src/bootstrap/state.js'
import { armProvisionalSessionReconcile } from 'src/utils/provisionalSessionReconcile.js'
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
import { refusedOutcome } from './refusalEnvelope.js'
import { errorMessage } from '../../utils/errors.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import type { ContentReplacementRecord } from '../../utils/toolResultStorage.js'
import { recordContentReplacement } from '../../utils/sessionStorage.js'

export function emitLoadError(
  message: string,
  outputFormat: string | undefined,
): void {
  if (outputFormat === 'rows') {
    process.stdout.write(jsonStringify(refusedOutcome([message], 'load')) + '\n')
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

type Resumed = NonNullable<Awaited<ReturnType<typeof loadConversationForResume>>>

type LoadInitialMessagesResult = {
  messages: Message[]
  contentReplacements?: ContentReplacementRecord[]
  turnInterruptionState?: TurnInterruptionState
  agentSetting?: string
  model?: string
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
  const refuse = (message: string, code = 1): LoadInitialMessagesResult => {
    emitLoadError(message, options.outputFormat)
    gracefulShutdownSync(code)
    return { messages: [] }
  }
  const adopt = async (result: Resumed, fallbackHome: string | null): Promise<LoadInitialMessagesResult> => {
    if (!options.forkSession && result.sessionId) {
      switchSession(
        asSessionId(result.sessionId),
        result.fullPath ? dirname(result.fullPath) : fallbackHome,
      )
      if (persistSession) {
        await resetSessionFilePointer()
      }
    }
    await restoreSessionStateFromLog(result, setAppState)
    restoreSessionMetadata(
      options.forkSession
        ? { ...result, worktreeSession: undefined }
        : result,
    )
    if (options.forkSession && persistSession && result.contentReplacements?.length) {
      await recordContentReplacement(result.contentReplacements)
    }
    return {
      messages: result.messages,
      contentReplacements: result.contentReplacements,
      turnInterruptionState: result.turnInterruptionState,
      agentSetting: result.agentSetting,
      model: result.model,
    }
  }
  armProvisionalSessionReconcile()

  if (options.continue) {
    try {
      const result = await loadConversationForResume(
        undefined ,
        undefined ,
      )
      if (result && hasConversationTurn(result.messages)) return adopt(result, null)
      return refuse('No conversation found to continue')
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
        const given = typeof options.resume === 'string' ? options.resume : ''
        return refuse(`${binaryName()} run --resume needs a session id (a UUID) or a .jsonl transcript path: ${JSON.stringify(given)} is neither`, 2)
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
        return refuse(
          parsedSessionId.isJsonlFile
            ? `No conversation could be loaded from: ${typeof options.resume === 'string' ? options.resume : parsedSessionId.sessionId}`
            : `No conversation found with session ID: ${parsedSessionId.sessionId}`,
        )
      }

      if (options.resumeSessionAt) {
        const index = result.messages.findIndex(
          m => m.uuid === options.resumeSessionAt,
        )
        if (index < 0) return refuse(`No message found with message.uuid of: ${options.resumeSessionAt}`)
        result.messages = result.messages.slice(0, index + 1)
      }

      return adopt(result, homePin)
    } catch (error) {
      logError(error)
      return refuse(
        error instanceof Error
          ? `Failed to resume session: ${error.message}`
          : 'Failed to resume session with mercury run',
      )
    }
  }

  return {
    messages: await (options.sessionStartHooksPromise ??
      processSessionStartHooks('startup')),
  }
}
