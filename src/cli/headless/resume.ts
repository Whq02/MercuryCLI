// ============================================================================
//  headless/resume — session resume loading for the headless engine
//  (core-ownership Phase 9.3 cut (b), moved verbatim from print.ts):
//  loadInitialMessages resolves --continue/--resume/--fork-session into the
//  initial transcript (+ session-state restore); removeInterruptedMessage
//  strips a trailing interrupt marker; emitLoadError reports load failures
//  in the caller's output format.
// ============================================================================

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
import { externalMetadataToAppState } from 'src/state/onChangeAppState.js'
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
import type { SessionExternalMetadata } from 'src/utils/sessionState.js'
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

/**
 * Report a session-load failure in the caller's output format: a full
 * error_during_execution result envelope on the stream-json wire (headless
 * consumers parse envelopes, not prose), plain stderr otherwise.
 */
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
      modelUsage: {},
      permission_denials: [],
      uuid: randomUUID(),
      errors: [message],
    }
    process.stdout.write(jsonStringify(errorResult) + '\n')
  } else {
    process.stderr.write(message + '\n')
  }
}

/**
 * Strip an interrupted user message and its synthetic assistant sentinel
 * from the array (in place). Restart paths that re-enqueue the interrupted
 * prompt call this first, so the transcript doesn't carry both the ghost
 * and the re-run.
 *
 * @internal export — test seam only
 */
export function removeInterruptedMessage(
  messages: Message[],
  interruptedUserMessage: NormalizedUserMessage,
): void {
  const idx = messages.findIndex(m => m.uuid === interruptedUserMessage.uuid)
  if (idx !== -1) {
    // Two entries: the user message and the sentinel right after it.
    // splice tolerates idx being the last element (it removes just one).
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
    restoredWorkerState: Promise<SessionExternalMetadata | null>
  },
): Promise<LoadInitialMessagesResult> {
  const persistSession = !isSessionPersistenceDisabled()
  // the headless resume switches abandon the boot-minted provisional
  // id exactly like the interactive path — arm the switch-time reconcile
  // (idempotent) before any switchSession below.
  armProvisionalSessionReconcile()

  // --continue: resume the most recent conversation for this project.
  if (options.continue) {
    try {
      const result = await loadConversationForResume(
        undefined /* sessionId */,
        undefined /* file path */,
      )
      // Null and empty are one truth (the --resume leg's own law): an empty
      // load "continues" nothing. A transcript without a turn (attachment
      // and system rows only — the metadata-only shape) continues nothing
      // either: hasConversationTurn is the one predicate on both doors.
      if (result && hasConversationTurn(result.messages)) {
        // Adopt the resumed session's identity — unless --fork-session,
        // which keeps the fresh boot id and lets the old transcript stand.
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

        // Re-arm the exit-time metadata append (reAppendSessionMetadata). A
        // fork drops the worktree binding — the forked session does not own
        // the original's worktree.
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
      // NOTHING TO CONTINUE refuses — the interactive door's own sentence
      // and exit (main.tsx's --continue leg). The old fall-through silently
      // started a FRESH conversation and answered it: a -p --continue on an
      // empty home spent a model turn pretending to be a continuation
      // (--resume's unknown-id twin already refused). One law on both doors.
      emitLoadError('No conversation found to continue', options.outputFormat)
      gracefulShutdownSync(1)
      return { messages: [] }
    } catch (error) {
      logError(error)
      gracefulShutdownSync(1)
      return { messages: [] }
    }
  }

  // --resume <target>: headless resume requires an explicit target — a
  // session id, a .jsonl path, or a session URL (parseSessionIdentifier
  // owns the accepted grammar). No interactive picker exists here.
  // PRESENCE, not truthiness (FC-038): --resume "" is a present-but-empty
  // target and must REFUSE like any other unparseable target — the falsy
  // guard silently started a brand-new session instead.
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

      // W0.1 home law:
      // a daemon-hosted switchboard respawn carries the pinned transcript
      // home (its cwd is the carved worktree, so the cwd-derived search
      // would miss the law home). Pin present + file exists ⇒ load exactly
      // that file (switchSession below then pins its dirname); file missing
      // ⇒ the normal search still finds pre-law legacy transcripts.
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

      // A fresh/empty remote hydrate leaves NO transcript file (hydrate
      // now SKIPS an empty write so it can't clobber a populated local file), so
      // loadConversationForResume returns null; an already-empty file would return
      // {messages: []}. Treat null and empty the same so SessionStart still fires.
      if (!result || !hasConversationTurn(result.messages)) {
        // Name what the OPERATOR supplied (FC-039): for a .jsonl path or a
        // URL the parsed sessionId is a freshly minted random UUID — the
        // refusal named an id the operator never typed, different every run.
        emitLoadError(
          parsedSessionId.isJsonlFile || parsedSessionId.isUrl
            ? `No conversation could be loaded from: ${typeof options.resume === 'string' ? options.resume : parsedSessionId.sessionId}`
            : `No conversation found with session ID: ${parsedSessionId.sessionId}`,
          options.outputFormat,
        )
        gracefulShutdownSync(1)
        return { messages: [] }
      }

      // --resume-session-at <uuid>: truncate the transcript just after the
      // named message — resume from a mid-conversation point.
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

      // Adopt the resumed session's identity (see the --continue leg).
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

      // Re-arm the exit-time metadata append; a fork drops the worktree
      // binding (see the --continue leg).
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

  // Fresh session (or a --continue that found nothing to resume): join the
  // SessionStart hooks main.tsx already kicked, or run them here when it
  // didn't — main.tsx skips the kick on --continue, so the nothing-to-resume
  // fall-through arrives with the promise undefined.
  return {
    messages: await (options.sessionStartHooksPromise ??
      processSessionStartHooks('startup')),
  }
}

