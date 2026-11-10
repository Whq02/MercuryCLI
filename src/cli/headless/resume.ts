
import { existsSync } from 'fs'
import { dirname, join } from 'path'
import {
  isSessionPersistenceDisabled,
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
import { runSessionStartHooks } from 'src/utils/sessionStart.js'
import { consumeSessionHomePin } from 'src/utils/sessionStorage/sessionHomePin.js'
import {
  carrySessionBriefs,
  resetSessionFilePointer,
  restoreSessionMetadata,
} from 'src/utils/sessionStorage.js'
import { parseSessionIdentifier } from 'src/utils/sessionUrl.js'
import { formatPrintsOutcomeRow, refusedOutcome } from './refusalEnvelope.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import type { ContentReplacementRecord } from '../../utils/toolResultStorage.js'
import { recordContentReplacement, listProjectSessions, sessionIdOfListing } from '../../utils/sessionStorage.js'
import { sessionFilePath } from '../../utils/sessionStorage/loading.js'
import { claimSessionWriter } from '../../utils/sessionStorage/sessionWriter.js'
import { resumeMissMessage } from '../../utils/sessionStorage/resumeMiss.js'
import type { UUID } from 'node:crypto'

export function emitLoadError(
  message: string,
  outputFormat: string | undefined,
): void {
  if (formatPrintsOutcomeRow(outputFormat)) {
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
  resumedSessionId?: string
  contentReplacements?: ContentReplacementRecord[]
  turnInterruptionState?: TurnInterruptionState
  agentSetting?: string
  brief?: string
  briefAdd?: string
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
    sessionStartHooksPromise?: ReturnType<typeof runSessionStartHooks>
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
    if (options.forkSession) carrySessionBriefs()
    if (options.forkSession && persistSession && result.contentReplacements?.length) {
      await recordContentReplacement(result.contentReplacements)
    }
    return {
      messages: result.messages,
      ...(result.sessionId !== undefined ? { resumedSessionId: String(result.sessionId) } : {}),
      contentReplacements: result.contentReplacements,
      turnInterruptionState: result.turnInterruptionState,
      agentSetting: result.agentSetting,
      brief: result.brief,
      briefAdd: result.briefAdd,
      model: result.model,
    }
  }
  armProvisionalSessionReconcile()

  if (options.continue) {
    try {
      const latest = (await listProjectSessions())[0]
      if (!latest) return refuse('No conversation found to continue')
      const sessionId = sessionIdOfListing(latest)
      const path = latest.fullPath ?? sessionFilePath(sessionId as UUID)
      if (persistSession && !options.forkSession) await claimSessionWriter(path)
      const result = await loadConversationForResume(String(sessionId), path)
      if (result && hasConversationTurn(result.messages)) return adopt(result, null)
      return refuse('No conversation found to continue')
    } catch (error) {
      logError(error)
      return refuse(error instanceof Error ? error.message : 'Failed to continue session')
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
      const sourceFile = parsedSessionId.jsonlFile || (pinnedFile !== undefined && existsSync(pinnedFile) ? pinnedFile : undefined)
      const writerPath = sourceFile ?? sessionFilePath(parsedSessionId.sessionId as UUID)
      if (persistSession && !options.forkSession && existsSync(writerPath)) await claimSessionWriter(writerPath)
      const result = await loadConversationForResume(parsedSessionId.sessionId, sourceFile)

      if (!result || !hasConversationTurn(result.messages)) {
        return refuse(
          parsedSessionId.isJsonlFile
            ? `No conversation could be loaded from: ${typeof options.resume === 'string' ? options.resume : parsedSessionId.sessionId}`
            : await resumeMissMessage(parsedSessionId.sessionId),
        )
      }

      if (options.resumeSessionAt) {
        const index = result.messages.findIndex(
          m => m.uuid === options.resumeSessionAt,
        )
        if (index < 0) return refuse(`No message in this conversation has the uuid ${options.resumeSessionAt}`)
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
      runSessionStartHooks('new')),
  }
}

