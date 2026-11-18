import { claimSession } from './claimSession.js'
import { answerSessionFacts } from './sessionFactsArm.js'
import { mcpAction, mcpTools, setSessionKit } from './mcpArms.js'
import { popById, holdQueuedWordsForTurnEnd } from '../../utils/messageQueueManager.js'
import { resolvePermissionModeTransition, handleRewindSession, handleFileRestoreSession } from './controlHandlers.js'
import type { PermissionMode as WirePermissionMode } from '../../types/permissions.js'
import { refused } from '../../runner/wire/errors.js'
import { markSessionPermissionMode } from '../../utils/cockpit/runtimePosture.js'
import { wrapInSystemReminder } from '../../utils/messages/text.js'
import { resolveHeadlessModel } from './model.js'
import { getDefaultEngineModelSetting, getEngineModel } from '../../utils/model/model.js'
import { errorMessage } from '../../utils/errors.js'
import { isEffortLevel } from '../../utils/effort.js'
import { latchSessionScheduleRoster } from '../../services/saturn/sessionScheduleBridge.js'
import { rewindOutcomeToWire } from '../../services/engine-connector/seatWire.js'
import { readGlobalConfigAgain } from '../../utils/config.js'
import { resetLimitsForCredentialSwitch } from '../../services/anthropicLimits.js'
import { dropCredentialMemos } from '../../utils/auth.js'
import { readOpenaiAccountAgain } from '../../services/providers/openai/openaiCatalogue.js'
import { noteCrewAccountChange } from '../../utils/crew/crewAccountChange.js'
import { operatorPauseGate } from '../../run-core/pauseGate.js'
import { SEND_NOW_NOTHING_QUEUED, sendQueuedWordsNow } from './sendNow.js'
import { swarmOwnerPost } from '../../services/crewBoard/seam.js'
import { stopAgentByOperator } from '../../services/agents/operatorStop.js'
import { AGENT_INTERRUPT_BY_OPERATOR, isLocalAgentTask, queueOperatorMessage, AGENT_RESUME_NOTE, enqueueAgentReceiptRow } from '../../tasks/LocalAgentTask/LocalAgentTask.js'
import { drainRows } from '../../utils/sdkEventQueue.js'
import { setRunInputClosed } from '../../bootstrap/state.js'
import { gracefulShutdownSync } from '../../utils/gracefulShutdown.js'
import { leaveNoteBeforeExit, exitNoteCharsKept } from '../../mneme/exitHandoff.js'
import { HANDOFF_ASK_BUDGET_MS } from '../../mneme/handoffAsk.js'
import { noticeRow } from '../../rows/project.js'
import { closeLineageSession, lineageKept } from '../../mneme/lineageSession.js'
import { getLastCacheSafeParams } from '../../utils/forkedAgent.js'
import type { ToolUseContext } from '../../Tool.js'
import type { RunnerPorts } from './runnerPorts.js'
import type { RunnerArms } from './runnerMethods.js'

const INTERRUPT_DEDUPE_CAP = 200

const SEAT_VERB_AT = (held: boolean): 'now' | 'turn_end' => (held ? 'turn_end' : 'now')

export function runnerArmsOf(ports: RunnerPorts): RunnerArms {
  const { acceptInputRow, applySeatEffort, applySeatModel, asks, canUseTool, driver, enqueueRow, getAppState, getReadFileCache, interruptOutcomes, io, isLocalShellTask, killTask, landSpawnSwitch, live, liveScope, messages, options, quiescence, relaunchContext, requestShellBackground, setAppState } = ports
  return {
    'project/query': async params => {
      const { projectQuery } = await import('./projectQuery.js')
      return projectQuery(params, getAppState().toolPermissionContext)
    },
    'turn/interrupt': params => {
      if (params.op_id !== undefined && interruptOutcomes.has(params.op_id)) return { interrupted: interruptOutcomes.get(params.op_id)! }
      if (params.turn_id !== undefined && live.currentTurnId !== null && params.turn_id !== live.currentTurnId) return { interrupted: false }
      const interrupted = live.inFlightAbort !== null || live.leaveAbort !== null
      if (params.op_id !== undefined) {
        interruptOutcomes.set(params.op_id, interrupted)
        if (interruptOutcomes.size > INTERRUPT_DEDUPE_CAP) interruptOutcomes.delete(interruptOutcomes.keys().next().value!)
      }
      live.inFlightAbort?.abort()
      live.leaveAbort?.abort(new Error('the handoff was skipped by ctrl-c'))
      driver.releaseHold()
      if (params.hard === true) {
        for (const task of Object.values(getAppState().tasks)) {
          if (isLocalShellTask(task) && task.status === 'running') void killTask(task.id, setAppState)
        }
      }
      return { interrupted }
    },
    'queue/add': params => acceptInputRow(params),
    'queue/withdraw': params => {
      const popped = popById(params.id)
      return popped.popped ? { withdrawn: true, text: popped.text } : { withdrawn: false, reason: popped.reason }
    },
    'session/set_mode': params => {
      const resolved = resolvePermissionModeTransition(params.mode as WirePermissionMode, getAppState().toolPermissionContext)
      if (!resolved.ok) throw refused(resolved.error, 'mode')
      const nextContext = resolved.context
      setAppState(previous => ({ ...previous, toolPermissionContext: nextContext }))
      const modeReminder = markSessionPermissionMode(nextContext.mode)
      if (modeReminder !== null) {
        void import('../../utils/messageQueueManager.js').then(({ enqueuePendingNotification }) => {
          enqueuePendingNotification({ value: wrapInSystemReminder(modeReminder), mode: 'task-notification', priority: 'next', ridesNextWords: true })
        })
      }
      void asks.recheckPendingPermissionRequests()
      return { mode: params.mode }
    },
    'session/set_model': async (params, ref) => {
      const requested = params.model
      let resolved: string
      try {
        resolved = await resolveHeadlessModel(requested === undefined || requested === 'default'
          ? (getDefaultEngineModelSetting() ?? getEngineModel())
          : requested)
      } catch (error) {
        throw refused(errorMessage(error), 'model')
      }
      const words = typeof params.words === 'string' && params.words.trim() !== '' ? params.words.trim() : undefined
      if (live.inFlightAbort !== null) {
        live.heldSeatModel = { requestId: ref.id, model: String(resolved), ...(words === undefined ? {} : { words }) }
        holdQueuedWordsForTurnEnd(true)
        return { model: String(resolved), at: SEAT_VERB_AT(true) }
      }
      await applySeatModel(String(resolved), words)
      return { model: String(resolved), at: SEAT_VERB_AT(false) }
    },
    'session/claim': params => claimSession(params, ports),
    'session/set_effort': (params, ref) => {
      const requestedEffort = String(params.effort ?? '')
      if (!isEffortLevel(requestedEffort)) throw refused(`effort refused ('${requestedEffort}' is not on the shared ladder)`, 'effort')
      if (live.inFlightAbort !== null) {
        live.heldSeatEffort = { requestId: ref.id, effort: requestedEffort }
        holdQueuedWordsForTurnEnd(true)
        return { effort: requestedEffort, at: SEAT_VERB_AT(true) }
      }
      applySeatEffort(requestedEffort)
      return { effort: requestedEffort, at: SEAT_VERB_AT(false) }
    },
    'session/facts': () => answerSessionFacts(ports),
    'schedule/roster': params => {
      const rows = Array.isArray(params.schedules)
        ? (params.schedules as unknown[]).flatMap(raw => {
            if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return []
            const r = raw as Record<string, unknown>
            if (typeof r.id !== 'string' || typeof r.when !== 'string') return []
            const kind: 'fire' | 'birth' | null = r.kind === 'fire' ? 'fire' : r.kind === 'birth' ? 'birth' : null
            if (kind === null) return []
            return [
              {
                id: r.id,
                when: r.when,
                nextFireMs: typeof r.next_fire_ms === 'number' ? r.next_fire_ms : null,
                kind,
                ...(r.paused === true ? { paused: true as const } : {}),
                ...(typeof r.title === 'string' && r.title !== '' ? { title: r.title } : {}),
              },
            ]
          })
        : []
      latchSessionScheduleRoster(rows)
      return {}
    },
    'session/rewind': async params => {
      const outcome = await handleRewindSession(params, {
        messages,
        getAppState,
        setAppState,
        drift: getReadFileCache(),
        turnActive: live.inFlightAbort !== null,
      })
      return rewindOutcomeToWire(outcome) as Record<string, unknown>
    },
    'session/file_restore': async params => {
      const outcome = await handleFileRestoreSession(params, { messages, getAppState, setAppState, drift: getReadFileCache(), turnActive: live.inFlightAbort !== null })
      return rewindOutcomeToWire(outcome) as Record<string, unknown>
    },
    'session/set_spawn_switch': (params, ref) => {
      if (params.switch === 'workflows') return { switch: params.switch, on: params.on, at: SEAT_VERB_AT(false) }
      const toggle = { kind: params.switch, on: params.on }
      if (live.inFlightAbort !== null) {
        live.deferredSpawnSwitches = [...live.deferredSpawnSwitches.filter(d => d.kind !== toggle.kind), { ...toggle, requestId: ref.id }]
        holdQueuedWordsForTurnEnd(true)
        return { switch: toggle.kind, on: toggle.on, at: SEAT_VERB_AT(true) }
      }
      landSpawnSwitch(toggle.kind, toggle.on)
      return { switch: toggle.kind, on: toggle.on, at: SEAT_VERB_AT(false) }
    },
    'credentials/changed': () => {
      readGlobalConfigAgain()
      resetLimitsForCredentialSwitch()
      dropCredentialMemos()
      readOpenaiAccountAgain()
      noteCrewAccountChange()
    },
    'mcp/action': (params, _ref, signal) => mcpAction(params, signal, ports),
    'mcp/tools': params => mcpTools(params, ports),
    'session/set_kit': params => setSessionKit(params, ports),
    'session/pause_gate': params => {
      const changed = params.paused ? operatorPauseGate.pause() : operatorPauseGate.resume()
      return { paused: operatorPauseGate.paused(), parked: operatorPauseGate.parked().length, changed }
    },
    'shell/background': () => {
      const taken = requestShellBackground()
      if (taken > 0) return { taken }
      throw refused('no shell command is running in the main conversation', 'no-shell')
    },
    'session/send_now': () => {
      if (live.inFlightAbort === null) return SEND_NOW_NOTHING_QUEUED
      return sendQueuedWordsNow(getAppState, setAppState)
    },
    'session/board_post': params => {
      const receipt = swarmOwnerPost({ clientOpId: params.client_op_id, channel: params.channel, ...(params.target === undefined ? {} : { target: params.target }), text: params.text })
      if (!receipt.ok) return { ok: false as const, reason: receipt.reason, ...(receipt.candidates ? { candidates: receipt.candidates } : {}) }
      return { ok: true as const, event_id: receipt.eventId, seq: receipt.seq, replay: receipt.replay, address: receipt.channel.kind === 'general' ? 'all' : receipt.channel.target, recipients: receipt.recipients }
    },
    'agent/stop': async params => {
      try {
        const receipt = await stopAgentByOperator(params.agent_id, { getAppState, setAppState }, params.note === AGENT_INTERRUPT_BY_OPERATOR ? { reason: AGENT_INTERRUPT_BY_OPERATOR } : {})
        if (receipt.outcome !== 'applied') throw refused(receipt.reason, 'agent')
        return { receipt: 'applied', kind: receipt.kind, status: receipt.status }
      } finally {
        for (const row of drainRows()) enqueueRow(row)
      }
    },
    'session/quiesce': async params => {
      const answer = await quiescence.request({ subtype: 'quiesce', action: params.action, token: params.token })
      if (!answer.ok) throw refused(answer.reason, 'quiesce')
      if (answer.phase === 'committed') {
        live.inputClosed = true
        setRunInputClosed(true)
        setTimeout(() => gracefulShutdownSync(0, 'closed'), 50)
      }
      return { token: answer.token, phase: answer.phase }
    },
    'session/leave': async (_params, _ref, signal) => {
      if (live.inFlightAbort !== null || live.leaveAbort !== null) return { note: 'skipped', ledger: 'absent' }
      const controller = new AbortController()
      live.leaveAbort = controller
      const onCancel = (): void => controller.abort(signal.reason)
      signal.addEventListener('abort', onCancel, { once: true })
      try {
        const note = await leaveNoteBeforeExit({ budgetMs: HANDOFF_ASK_BUDGET_MS, signal: controller.signal, onNotice: text => io.outbound.enqueue(noticeRow(liveScope(), 'warning', text)) })
        const closed = await closeLineageSession('quit')
        const kept = note === 'stored' ? exitNoteCharsKept() : null
        return { note, ledger: closed !== null && lineageKept() ? 'closed' : 'absent', ...(kept === null ? {} : { noteChars: kept }) }
      } finally {
        signal.removeEventListener('abort', onCancel)
        if (live.leaveAbort === controller) live.leaveAbort = null
      }
    },
    'agent/resume': async (params, _ref, signal) => {
      const target = getAppState().tasks[params.agent_id]
      if (target !== undefined && target.status === 'running') {
        const note = params.note !== undefined ? params.note.trim() : ''
        if (note === '' || !isLocalAgentTask(target)) throw refused('the crewmate is running — nothing to resume', 'agent')
        queueOperatorMessage(params.agent_id, note, setAppState)
        return { queued: true, agent_id: params.agent_id }
      }
      if (live.awaitingSessionClaim) throw refused('nothing to resume from yet — the session is still starting', 'nothing-to-resume')
      const { AgentNotRecorded, resumeAgentBackground, operatorResumeWords } = await import('../../tools/AgentTool/resumeAgent.js')
      let standing = getLastCacheSafeParams()?.toolUseContext as ToolUseContext | undefined
      if (standing === undefined) {
        await options.initializeMcp?.()
        standing = await relaunchContext()
        if (signal.aborted) throw refused('nothing to resume from yet — the session is still starting', 'nothing-to-resume')
      }
      const { toolUseId: _staleToolUseId, ...lastContext } = standing
      void _staleToolUseId
      const resumed = await resumeAgentBackground({
        agentId: params.agent_id,
        prompt: params.note !== undefined && params.note.trim() !== '' ? params.note : AGENT_RESUME_NOTE,
        replyTarget: params.note?.trim() ? 'operator' : 'parent',
        toolUseContext: { ...lastContext, abortController: new AbortController() } as ToolUseContext,
        canUseTool,
      }).catch((error: unknown) => {
        throw error instanceof AgentNotRecorded ? refused(error.message, 'agent') : error
      })
      if (!params.note?.trim()) enqueueAgentReceiptRow({ taskId: resumed.agentId, description: resumed.description, summary: operatorResumeWords(resumed.description) + (resumed.note ?? '') })
      return {
        agent_id: resumed.agentId,
        output_file: resumed.outputFile,
        ...(resumed.cwdFallback !== undefined ? { cwd_fallback: resumed.cwdFallback } : {}),
        ...(resumed.recordedCwd !== undefined ? { recorded_cwd: resumed.recordedCwd } : {}),
        ...(resumed.note ? { note: resumed.note } : {}),
      }
    },
  }
}
