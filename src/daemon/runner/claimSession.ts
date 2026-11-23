import type { Message } from '../../engine/message-shapes/message.js'
import { isToolResultMessage } from '../../engine/messages/merge.js'
import { isLocalCommandCaveat } from '../../engine/messages/apiPlan.js'
import { refused } from '../runner-wire/errors.js'
import type { AppState } from '../../screen/app-state/AppStateStore.js'
import { resolvePermissionModeTransition } from './controlHandlers.js'
import type { PermissionMode as WirePermissionMode } from '../../permissions/rules/permissions.js'
import { isEffortLevel } from '../../models/effort/effort.js'
import { dropCredentialMemos } from '../../models/sign-in/lifecycle/oauthLifecycle.js'
import { primeOpenaiCatalogue } from '../../models/roads/openai/openaiCatalogue.js'
import { openaiCatalogueFromWire } from '../../engine/connector/seatWire.js'
import { resolveHeadlessModel, bootModelRefusalLine } from './model.js'
import { errorMessage } from '../../platform/errors/errors.js'
import { consumeSessionHomePin } from '../../sessions/transcripts/sessionHomePin.js'
import { join, dirname } from 'node:path'
import { existsSync } from 'node:fs'
import { sessionFilePath } from '../../sessions/transcripts/loading.js'
import { unreadableTranscriptMessage } from '../../sessions/transcripts/resumeMiss.js'
import type { UUID } from 'node:crypto'
import { setFlagEnv } from '../../platform/substrate/flagRegistry.js'
import { isSessionPersistenceDisabled, switchSession, setEngineModelOverride } from '../../boot/process-state/processState.js'
import { claimSessionWriter } from '../../sessions/transcripts/sessionWriter.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { emitLoadError } from './resume.js'
import { gracefulShutdownSync } from '../../platform/processes/gracefulShutdown.js'
import { clearSystemPromptSections } from '../../engine/system-prompt/systemPromptSections.js'
import { loadConversationForResume } from '../../sessions/resume/conversationRecovery.js'
import { logError } from '../../platform/logs/errorLog.js'
import { restoreConversationModel, restoreSessionStateFromLog } from '../../sessions/resume/sessionRestore.js'
import { parseUserSpecifiedModel, getEngineModel } from '../../models/catalogue/engineModel.js'
import { noticeRow } from '../../engine/rows/project.js'
import type { SessionId } from '../../sessions/transcripts/ids.js'
import { resetSessionFilePointer, restoreSessionMetadata, saveSessionModel } from '../../sessions/transcripts/sessionStorage.js'
import { reconstructContentReplacementState } from '../../engine/tool-dispatch/toolResultStorage.js'
import { markSessionPermissionModeAtClaim } from '../../screen/cockpit/runtimePosture.js'
import type { ParamsOf, ResultOf } from '../runner-wire/methods.js'
import type { SESSION_VERBS } from '../runner-wire/sessionVerbs.js'
import type { RunnerPorts } from './runnerPorts.js'

export function priorTurnCount(messages: readonly Message[]): number {
  return messages.filter(message => message.type === 'user' && (message as { isMeta?: boolean }).isMeta !== true && !isToolResultMessage(message) && !isLocalCommandCaveat(message)).length
}

export async function claimSession(params: ParamsOf<typeof SESSION_VERBS.claim.runner.name>, ports: RunnerPorts): Promise<ResultOf<typeof SESSION_VERBS.claim.runner.name>> {
  const { armSessionRunnerWiring, driver, enqueueRow, getAppState, heldNoticeWaits, hydrateResumedRun, live, liveMcp, liveScope, messages, options, peer, persistBootModelRefusal, releaseQueueUntilClaimed, setAppState, settleClearBirth, settleSessionBriefs, wire } = ports
  if (!live.awaitingSessionClaim || live.claimSettling !== null) throw refused('claim refused — this runner already carries a session identity', 'claim')
  const sid = String(params.session_id ?? '')
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sid)) {
    throw refused(`claim refused — session_id must be a UUID (got ${JSON.stringify(sid)})`, 'claim')
  }
  const claimedMode = typeof params.mode === 'string' && params.mode !== '' ? params.mode : undefined
  const claimedEffort = typeof params.effort === 'string' && params.effort !== '' ? params.effort : undefined
  const claimedTitle = typeof params.title === 'string' && params.title.trim() !== '' ? params.title.trim() : undefined
  let claimedContext: AppState['toolPermissionContext'] | undefined
  if (claimedMode !== undefined) {
    const transition = resolvePermissionModeTransition(
      claimedMode as WirePermissionMode,
      getAppState().toolPermissionContext,
      'claim',
    )
    if (!transition.ok) throw refused(`claim refused — ${transition.error}`, 'claim')
    claimedContext = transition.context
  }
  if (claimedEffort !== undefined && !isEffortLevel(claimedEffort)) {
    throw refused(`claim refused — effort '${claimedEffort}' is not on the shared ladder`, 'claim')
  }
  dropCredentialMemos()
  if (params.openai_catalogue !== undefined) {
    primeOpenaiCatalogue(openaiCatalogueFromWire(params.openai_catalogue) as Parameters<typeof primeOpenaiCatalogue>[0])
  }
  let claimedModel: string | undefined
  if (typeof params.model === 'string' && params.model !== '') {
    try { claimedModel = await resolveHeadlessModel(params.model) }
    catch (error) { throw refused(errorMessage(error), 'claim') }
  }
  const claimedHome = consumeSessionHomePin()
  const pinnedFile = claimedHome !== null ? join(claimedHome, `${sid}.jsonl`) : undefined
  const resumeFile = pinnedFile !== undefined && existsSync(pinnedFile) ? pinnedFile : undefined
  if (params.resume === true && resumeFile === undefined && !existsSync(sessionFilePath(sid as UUID))) {
    if (claimedHome !== null) setFlagEnv('MERCURY_SESSION_HOME', claimedHome)
    throw refused(`claim refused — no conversation found for session ${sid}`, 'claim')
  }
  if (!isSessionPersistenceDisabled()) {
    try { await claimSessionWriter(pinnedFile ?? sessionFilePath(sid as UUID)) }
    catch (error) { throw refused(errorMessage(error), 'claim') }
  }
  if (typeof params.restart_reason === 'string') live.runnerRestartReason = params.restart_reason
  const boundAt = Date.now()
  const releaseSessionVerbs = peer?.holdScope('session') ?? null
  logForDebugging(`[session-runner] claim bound: session ${sid}${claimedModel !== undefined ? ` on ${claimedModel}` : ''}${params.resume === true ? ' — loading the conversation' : ''}`)
  const settling = (async (): Promise<void> => {
    const endAsColdRunnerWould = (message: string): void => {
      emitLoadError(message, wire ? 'text' : options.outputFormat)
      gracefulShutdownSync(1)
    }
    let recordedModelRefusal: string | null = null
    try {
      clearSystemPromptSections()
      if (params.resume === true) {
        const resumed = await loadConversationForResume(sid, resumeFile)
        if (!resumed || resumed.messages.length === 0) {
          endAsColdRunnerWould(unreadableTranscriptMessage(sid, resumeFile) ?? `No conversation found for session id ${sid}`)
          return
        }
        if (claimedModel === undefined) {
          const recorded = restoreConversationModel(resumed)
          if (recorded) {
            try { claimedModel = await resolveHeadlessModel(recorded) }
            catch (error) {
              if (recorded.toLowerCase().startsWith('compat/')) {
                claimedModel = parseUserSpecifiedModel(recorded)
                recordedModelRefusal = bootModelRefusalLine(claimedModel, errorMessage(error))
              } else {
                enqueueRow(noticeRow(liveScope(), 'warning', `The resumed session's model '${recorded}' is not usable (${errorMessage(error)}) — this run uses ${getEngineModel()} instead.`))
              }
            }
          }
        }
        switchSession(sid as SessionId, resumed.fullPath ? dirname(resumed.fullPath) : claimedHome)
        live.resumeOf = String(resumed.sessionId ?? sid)
        if (!isSessionPersistenceDisabled()) await resetSessionFilePointer()
        await restoreSessionStateFromLog(resumed, setAppState)
        restoreSessionMetadata(resumed)
        settleSessionBriefs(resumed, true)
        messages.splice(0, messages.length, ...resumed.messages)
        live.turnsRun = priorTurnCount(messages)
        live.contentReplacementState = reconstructContentReplacementState(messages, resumed.contentReplacements ?? [])
      } else {
        switchSession(sid as SessionId, claimedHome)
        settleSessionBriefs({}, true)
      }
      if (claimedModel !== undefined) {
        live.activeModel = claimedModel
        setEngineModelOverride(claimedModel)
        saveSessionModel(live.activeModel)
        setFlagEnv('MERCURY_MODEL', claimedModel)
      }
      if (claimedEffort !== undefined) {
        setFlagEnv('MERCURY_EFFORT_LEVEL', claimedEffort)
        setAppState(previous => ({ ...previous, effortValue: claimedEffort }))
      }
      if (claimedContext !== undefined) {
        const nextContext = claimedContext
        setAppState(previous => ({ ...previous, toolPermissionContext: nextContext }))
        markSessionPermissionModeAtClaim(nextContext.mode)
      }
      await armSessionRunnerWiring(sid)
      if (params.resume === true) await hydrateResumedRun()
      void (options.initializeMcp?.() ?? Promise.resolve()).then(() => {
        live.mcpInitialized = true
        return liveMcp.refresh()
      }).catch(logError)
      live.awaitingSessionClaim = false
      if (claimedTitle !== undefined && !isSessionPersistenceDisabled()) {
        const { saveCustomTitle } = await import('../../sessions/transcripts/sessionListings.js')
        await saveCustomTitle(sid as UUID, claimedTitle)
      }
      if (recordedModelRefusal !== null) {
        live.bootRefusalFact = recordedModelRefusal
        await persistBootModelRefusal(recordedModelRefusal)
      }
      settleClearBirth()
      live.sessionFactsHoldSpent = false
      live.sessionFactsHold = null
      releaseQueueUntilClaimed?.()
      logForDebugging(`[session-runner] claimed: session ${sid}${claimedModel !== undefined ? ` on ${claimedModel}` : ''} — ready ${Date.now() - boundAt}ms after the claim`)
      if (heldNoticeWaits()) driver.kick()
    } catch (error) {
      logError(error)
      endAsColdRunnerWould(`Failed to resume session: ${errorMessage(error)}`)
    } finally {
      releaseSessionVerbs?.()
    }
  })()
  live.claimSettling = settling
  void settling.finally(() => {
    if (live.claimSettling === settling) live.claimSettling = null
  })
  return { session_id: sid }
}
