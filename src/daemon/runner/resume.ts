import { existsSync } from 'fs'
import { dirname, join } from 'path'
import {
  isSessionPersistenceDisabled,
  switchSession,
} from 'src/boot/process-state/processState.js'
import { armProvisionalSessionReconcile } from 'src/daemon/runner/provisionalSessionReconcile.js'
import type { AppState } from 'src/screen/app-state/AppStateStore.js'
import { asSessionId } from 'src/sessions/transcripts/ids.js'
import type { Message, NormalizedUserMessage } from 'src/engine/message-shapes/message.js'
import { binaryName } from 'src/platform/settings/config.js'
import {
  hasConversationTurn,
  loadConversationForResume,
  type TurnInterruptionState,
} from 'src/sessions/resume/conversationRecovery.js'
import { gracefulShutdownSync } from 'src/platform/processes/gracefulShutdown.js'
import { logError } from 'src/platform/logs/errorLog.js'
import { restoreSessionStateFromLog } from 'src/sessions/resume/sessionRestore.js'
import { runSessionStartHooks } from 'src/daemon/runner/sessionStart.js'
import { consumeSessionHomePin } from 'src/sessions/transcripts/sessionHomePin.js'
import {
  carrySessionBriefs,
  resetSessionFilePointer,
  restoreSessionMetadata,
} from 'src/sessions/transcripts/sessionStorage.js'
import { parseSessionIdentifier } from 'src/sessions/resume/sessionIdentifier.js'
import { formatPrintsOutcomeRow, refusedOutcome } from './refusalEnvelope.js'
import { jsonStringify } from '../../platform/logs/slowOperations.js'
import type { ContentReplacementRecord } from '../../engine/tool-dispatch/toolResultStorage.js'
import { recordContentReplacement, listProjectSessions, sessionIdOfListing } from '../../sessions/transcripts/sessionStorage.js'
import { sessionFilePath } from '../../sessions/transcripts/loading.js'
import { claimSessionWriter } from '../../sessions/transcripts/sessionWriter.js'
import { resumeMissMessage } from '../../sessions/transcripts/resumeMiss.js'
import type { UUID } from 'node:crypto'

export function emitLoadError(
  message: string,
  outputFormat: string | undefined,
): void {
  if (formatPrintsOutcomeRow(outputFormat)) {
    process.stdout.write(`${jsonStringify(refusedOutcome([message], 'load'))}\n`)
  } else {
    process.stderr.write(`${message}\n`)
  }
}

export function removeInterruptedMessage(
  messages: Message[],
  interruptedUserMessage: NormalizedUserMessage,
): void {
  const index = messages.findIndex(message => message.uuid === interruptedUserMessage.uuid)
  if (index === -1) return
  messages.splice(index, 2)
}

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

type LoadedConversation = NonNullable<Awaited<ReturnType<typeof loadConversationForResume>>>

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
  armProvisionalSessionReconcile()

  const fail = (message: string, code = 1): LoadInitialMessagesResult => {
    emitLoadError(message, options.outputFormat)
    gracefulShutdownSync(code)
    return { messages: [] }
  }

  const adopt = async (
    result: LoadedConversation,
    messages: Message[],
    fallbackHome: string | null,
  ): Promise<LoadInitialMessagesResult> => {
    const isFork = options.forkSession === true
    if (!isFork && result.sessionId) {
      const projectDir = result.fullPath ? dirname(result.fullPath) : fallbackHome
      switchSession(asSessionId(result.sessionId), projectDir)
      if (persistSession) {
        await resetSessionFilePointer()
      }
    }
    const adoptedLog = messages === result.messages ? result : { ...result, messages }
    await restoreSessionStateFromLog(adoptedLog, setAppState)
    restoreSessionMetadata(isFork ? { ...result, worktreeSession: undefined } : result)
    if (isFork) {
      carrySessionBriefs()
      if (persistSession && result.contentReplacements && result.contentReplacements.length > 0) {
        await recordContentReplacement(result.contentReplacements)
      }
    }
    return {
      messages,
      ...(result.sessionId !== undefined ? { resumedSessionId: String(result.sessionId) } : {}),
      contentReplacements: result.contentReplacements,
      turnInterruptionState: result.turnInterruptionState,
      agentSetting: result.agentSetting,
      brief: result.brief,
      briefAdd: result.briefAdd,
      model: result.model,
    }
  }

  if (options.continue) {
    let loaded: LoadedConversation
    try {
      const listings = await listProjectSessions()
      const latest = listings[0]
      const latestId = latest ? sessionIdOfListing(latest) : undefined
      if (!latest || !latestId) {
        return fail('No conversation found to continue')
      }
      const sourcePath = latest.fullPath ?? sessionFilePath(latestId)
      if (persistSession && !options.forkSession) {
        await claimSessionWriter(sourcePath)
      }
      const result = await loadConversationForResume(latestId, sourcePath)
      if (!result || !hasConversationTurn(result.messages)) {
        return fail('No conversation found to continue')
      }
      loaded = result
    } catch (error) {
      logError(error)
      return fail(error instanceof Error ? error.message : 'Failed to continue session')
    }
    return adopt(loaded, loaded.messages, null)
  }

  if (options.resume !== undefined && options.resume !== false) {
    const given = typeof options.resume === 'string' ? options.resume : ''
    const parsed = parseSessionIdentifier(given)
    if (!parsed) {
      return fail(
        `${binaryName()} run --resume needs a session id (a UUID) or a .jsonl transcript path: ${jsonStringify(given)} is neither`,
        2,
      )
    }
    const homePin = consumeSessionHomePin()
    let sourceFile = parsed.jsonlFile ?? undefined
    if (sourceFile === undefined && homePin !== null) {
      const pinnedPath = join(homePin, `${parsed.sessionId}.jsonl`)
      if (existsSync(pinnedPath)) {
        sourceFile = pinnedPath
      }
    }
    let loaded: { result: LoadedConversation; messages: Message[] }
    try {
      const candidatePath = sourceFile ?? sessionFilePath(parsed.sessionId)
      if (persistSession && !options.forkSession && existsSync(candidatePath)) {
        await claimSessionWriter(candidatePath)
      }
      const result = await loadConversationForResume(parsed.sessionId, sourceFile)
      if (!result || !hasConversationTurn(result.messages)) {
        if (parsed.isJsonlFile) {
          return fail(`No conversation could be loaded from: ${given || parsed.sessionId}`)
        }
        return fail(await resumeMissMessage(parsed.sessionId, sourceFile))
      }
      let messages = result.messages
      if (options.resumeSessionAt) {
        const atIndex = messages.findIndex(message => message.uuid === options.resumeSessionAt)
        if (atIndex === -1) {
          return fail(`No message in this conversation has the uuid ${options.resumeSessionAt}`)
        }
        messages = messages.slice(0, atIndex + 1)
      }
      loaded = { result, messages }
    } catch (error) {
      logError(error)
      return fail(
        error instanceof Error
          ? `Failed to resume session: ${error.message}`
          : 'Failed to resume session with mercury run',
      )
    }
    return adopt(loaded.result, loaded.messages, homePin)
  }

  const messages = await (options.sessionStartHooksPromise ?? runSessionStartHooks('new'))
  return { messages }
}

