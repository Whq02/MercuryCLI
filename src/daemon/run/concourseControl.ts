import { logForDebugging } from '../../utils/debug.js'
import type { makeConcourseDispatchHandler } from '../concourseDispatch.js'
import { readConcourseControlOps, recordConcourseControlOp, buildConcoursePromptRow, heldGitLaunchesFor, replayGitBlockedDispatches, denyProceedLaunchesFor, replayDenyProceedDispatches } from '../concourseDispatch.js'
import { pauseConcourseWorker, readSessionWorkers, resumeConcourseWorker, attachYieldConcourseSession, blurConcourseSession, detachRespawnConcourseSession, focusConcourseSession, grantConcourseWorkflows, isNewbornRecord, parkAllConcourseSessions, parkConcourseSession, retireConcourseSession, revokeConcourseWorkflows, turnInFlightOf, workerPidAlive, stopConcourseSession, reviveConcourseWorker, setConcourseSessionTitle } from '../concourseWorkers.js'
import type { ControlServerDeps } from '../controlServer.js'
import { isProcessAlive } from '../ownerWatch.js'
import { answerPermissionAsk } from '../permissionAsks.js'
import type { TaskRoster } from '../roster.js'
import { dropSaturnSelfWakes, type SaturnSelfWakeDropWhy } from '../saturn.js'
import { applyConcourseContractOp } from '../sessionContract.js'
import { controlSessionAgent, applySeatScheduleControl, onSeatSpawned, pushScheduleRosterForSession, refreshSessionFacts, setSessionEffort, setSessionKitDial, actOnSessionMcp, listSessionMcpTools, setSessionModel, setSessionPermissionMode, setSessionSpawnSwitch, withdrawSessionSend, backgroundSessionShell, sendSessionNow, pauseSessionGate, postSessionBoard, leaveSession } from '../sessionSeat.js'
import type { DaemonRunState } from './state.js'
import { passedOver, passedOverAs } from '../../utils/passedOver.js'
import { errorMessage } from '../../utils/errors.js'

type ConcourseControlDoor = NonNullable<ControlServerDeps['concourseControl']>

interface ConcourseControlNeeds {
  concourseDispatchHandler: ReturnType<typeof makeConcourseDispatchHandler>
}

function dropSelfWakesAtFlip(sessionId: string, by: string, why: SaturnSelfWakeDropWhy, roster: TaskRoster | null = null): void {
  try {
    const gone = dropSaturnSelfWakes(sessionId, by, why)
    if (gone.dropped.length > 0) {
      console.error(
        `[daemon] ${sessionId}: ${gone.dropped.length} self-paced wake${gone.dropped.length === 1 ? '' : 's'} dropped (${why}) — ${gone.dropped.join(', ')}${gone.droppedHolds > 0 ? `, ${gone.droppedHolds} held fire${gone.droppedHolds === 1 ? '' : 's'} with ${gone.dropped.length === 1 ? 'it' : 'them'}` : ''}`,
      )
      if (roster !== null) pushScheduleRosterForSession(sessionId, roster)
    }
  } catch (err) {
    logForDebugging(`[daemon] ${sessionId}: self-paced wake drop (${why}) failed — ${err instanceof Error ? err.message : String(err)}; the ticker converges it`)
  }
}

export function makeConcourseControl(state: DaemonRunState, { concourseDispatchHandler }: ConcourseControlNeeds): ConcourseControlDoor {
  return async ({ action, sessionId, by, reason, hard, requestId, allow, answer, model, words, effort, mode, contract, kitEdit, mcpAction, mcpServer, scheduleEdit, spawnSwitch, terminalApplication, clientOpId, mintedAtMs, title, titleSource, agentId, note, clientMessageId, paused, boardPost }) => {
    const roster = state.roster
    void reason
    if (clientOpId !== undefined) {
      const prior = readConcourseControlOps()[clientOpId]
      if (prior && prior.action === action && prior.sessionId === sessionId)
        return { outcome: prior.outcome, ...(prior.detail !== undefined ? { detail: prior.detail } : {}) }
    }
    const settle = (r: { outcome: 'applied' | 'noop' | 'refused'; detail?: string }): typeof r => {
      if (clientOpId !== undefined) {
        try {
          recordConcourseControlOp({ clientOpId, action, sessionId, outcome: r.outcome, ...(r.detail !== undefined ? { detail: r.detail } : {}), atMs: Date.now() })
        } catch (e) {
          logForDebugging(
            `[daemon] concourse-control: applied-ops ledger write failed (${e instanceof Error ? e.message : String(e)}) — receipt returned unrecorded`,
          )
        }
      }
      return r
    }
    if (action === 'answer-permission') {
      if (requestId === undefined || requestId === '') {
        return { outcome: 'refused' as const, detail: 'answer-permission requires requestId' }
      }
      return answerPermissionAsk(
        requestId,
        allow === true,
        by,
        {
          onGitReady: folder => {
            const waiting = heldGitLaunchesFor(folder)
            void replayGitBlockedDispatches(folder, concourseDispatchHandler)
              .then(rows => {
                for (const row of rows) {
                  console.error(
                    `[daemon] git-ready replay ${row.clientMessageId} (${row.title ?? 'untitled'}): ${row.ok ? `started as ${row.sessionId ?? '?'}${row.branchName !== undefined ? ` on ${row.branchName}` : ''}` : row.error ?? 'still held'}`,
                  )
                }
              })
              .catch(err => console.error(`[daemon] git-ready replay failed for ${folder}, so its held messages were not started: ${errorMessage(err)}`))
            return waiting
          },
          onDenyProceed: folder => {
            const proceeding = denyProceedLaunchesFor(folder)
            if (proceeding.length > 0) {
              void replayDenyProceedDispatches(folder, concourseDispatchHandler)
                .then(rows => {
                  for (const row of rows) {
                    console.error(
                      `[daemon] deny-proceed replay ${row.clientMessageId} (${row.title ?? 'untitled'}): ${row.ok ? `started as ${row.sessionId ?? '?'} — in the folder as it is, alone` : row.error ?? 'still held'}`,
                    )
                  }
                })
                .catch(err => console.error(`[daemon] deny-proceed replay failed for ${folder}, so its held messages were not started: ${errorMessage(err)}`))
            }
            return proceeding
          },
        },
        answer as Parameters<typeof answerPermissionAsk>[4],
      )
    }
    if (action === 'park-all') {
      const all = parkAllConcourseSessions(by, roster ?? undefined, undefined, {
        reason: undefined,
        exceptFocusedByLiveTerminal: true,
      })
      console.error(
        `[daemon] park-all by ${by}: parked ${all.parked.length}, draining ${all.draining.length}, released ${all.released.length} newborn(s), skipped ${all.skipped.length}${all.refused.length > 0 ? `, refused ${all.refused.join(', ')}` : ''}`,
      )
      return {
        outcome: 'applied' as const,
        detail: `parked ${all.parked.join(', ') || '-'} · draining ${all.draining.join(', ') || '-'} · released ${all.released.join(', ') || '-'} · skipped ${all.skipped.join(', ') || '-'}`,
      }
    }
    const rec = Object.values(readSessionWorkers()).find(
      r => r.sessionId === sessionId && r.endedAt === undefined,
    )
    if (!rec) return settle({ outcome: 'refused' as const, detail: 'unknown-session: no live worker record owns this session' })
    if (action === 'park') {
      if (roster && rec.pid !== undefined && !isNewbornRecord(rec) && !turnInFlightOf(rec) && workerPidAlive(rec) && rec.attachedAt === undefined) {
        const retired = await retireConcourseSession(sessionId, by, roster)
        return retired.outcome === 'parked'
          ? { outcome: 'applied' as const, detail: `parked ${retired.runnerId}` }
          : { outcome: 'refused' as const, detail: `${retired.runnerId ?? rec.runnerId}: ${retired.reason}` }
      }
      const out = parkConcourseSession(sessionId, by, roster ?? undefined)
      return out.outcome === 'refused'
        ? { outcome: 'refused' as const, detail: out.detail ?? out.reason }
        : out.outcome === 'noop'
          ? { outcome: 'noop' as const, detail: out.reason }
          : out.outcome === 'draining'
            ? { outcome: 'draining' as const, detail: `${out.runnerId} finishes its turn, then parks` }
            : { outcome: 'applied' as const, detail: out.released ? `released newborn ${out.runnerId}` : `parked ${out.runnerId}` }
    }
    if (action === 'set-title') {
      return settle(setConcourseSessionTitle(sessionId, title ?? '', by, titleSource === 'minted' ? 'minted' : 'operator'))
    }
    if (action === 'contract') {
      if (contract === undefined) return { outcome: 'refused' as const, detail: 'contract requires { contract: { op, text? } }' }
      return settle(applyConcourseContractOp(sessionId, contract, by))
    }
    if (action === 'set-schedule') {
      if (scheduleEdit === undefined) return { outcome: 'refused' as const, detail: 'set-schedule requires { scheduleEdit: { op, schedule? | scheduleId? } }' }
      return settle(applySeatScheduleControl(sessionId, scheduleEdit, by, roster))
    }
    if (action === 'mcp-action') {
      if (!mcpAction || !roster) return { outcome: 'refused' as const, detail: 'the MCP action or runner is unavailable' }
      return actOnSessionMcp(sessionId, mcpAction, roster)
    }
    if (action === 'mcp-tools') {
      if (!mcpServer || !roster) return { outcome: 'refused' as const, detail: 'the MCP server or runner is unavailable' }
      return listSessionMcpTools(sessionId, mcpServer, roster)
    }
    if (action === 'set-kit') {
      if (kitEdit === undefined) return { outcome: 'refused' as const, detail: 'set-kit requires { kitEdit: { mcp?, skills?, extensions? } }' }
      if (roster === null) return { outcome: 'refused' as const, detail: 'daemon roster not ready' }
      const dialed = setSessionKitDial(sessionId, kitEdit, by, roster)
      return dialed.outcome === 'queued'
        ? dialed
        : settle({ outcome: dialed.outcome, ...(dialed.detail !== undefined ? { detail: dialed.detail } : {}) })
    }
    if (action === 'set-model') {
      if (model === undefined || model === '') return { outcome: 'refused' as const, detail: 'set-model requires model' }
      return roster !== null ? await setSessionModel(sessionId, model, roster, undefined, words) : { outcome: 'refused' as const, detail: 'daemon roster not ready' }
    }
    if (action === 'set-effort') {
      if (effort === undefined || effort === '') return { outcome: 'refused' as const, detail: 'set-effort requires effort' }
      return roster !== null ? setSessionEffort(sessionId, effort, roster) : { outcome: 'refused' as const, detail: 'daemon roster not ready' }
    }
    if (action === 'set-spawn-switch') {
      if (spawnSwitch === undefined) return { outcome: 'refused' as const, detail: 'set-spawn-switch requires { spawnSwitch: { kind: subagents|workflows, on } }' }
      if (spawnSwitch.kind === 'workflows') return { outcome: 'noop' as const }
      return roster !== null ? setSessionSpawnSwitch(sessionId, { kind: spawnSwitch.kind, on: spawnSwitch.on }, by, roster) : { outcome: 'refused' as const, detail: 'daemon roster not ready' }
    }
    if (action === 'set-permission-mode') {
      if (mode === undefined || mode === '') return { outcome: 'refused' as const, detail: 'set-permission-mode requires mode' }
      return roster !== null ? setSessionPermissionMode(sessionId, mode, roster) : { outcome: 'refused' as const, detail: 'daemon roster not ready' }
    }
    if (action === 'session-facts') {
      return roster !== null ? refreshSessionFacts(sessionId, roster) : { outcome: 'refused' as const, detail: 'daemon roster not ready' }
    }
    if (action === 'focus' || action === 'blur') {
      const out = action === 'focus' ? focusConcourseSession(sessionId, by, undefined, terminalApplication) : blurConcourseSession(sessionId, by)
      if (out.outcome === 'applied') {
        const left = action === 'focus' && out.cleared.length > 0 ? ` — seat left ${out.cleared.join(', ')}` : ''
        return { outcome: 'applied' as const, detail: `${action} ${out.runnerId}${left}` }
      }
      return out.outcome === 'noop'
        ? { outcome: 'noop' as const, detail: out.reason }
        : { outcome: 'refused' as const, detail: out.reason }
    }
    if (action === 'interrupt') {
      const door = roster?.door(rec.runnerId)
      if (door === undefined) return settle({ outcome: 'refused' as const, detail: 'worker has no live runner door' })
      if (door.closed) return settle({ outcome: 'refused' as const, detail: 'the interrupt did not reach the runner: its door is closed' })
      const sent = door.send('turn/interrupt', { ...(clientOpId !== undefined ? { op_id: `concourse-interrupt-${clientOpId}` } : {}), ...(hard === true ? { hard: true } : {}) })
      sent.answer.catch(passedOverAs(undefined))
      dropSelfWakesAtFlip(sessionId, by, 'interrupted', roster)
      return settle({ outcome: 'applied' as const, detail: `${hard === true ? 'second interrupt' : 'interrupt'} ${rec.runnerId}` })
    }
    if (action === 'stop-agent' || action === 'resume-agent') {
      if (agentId === undefined || agentId === '') return { outcome: 'refused' as const, detail: `${action} requires agentId` }
      if (roster === null) return { outcome: 'refused' as const, detail: 'daemon roster not ready' }
      return controlSessionAgent(sessionId, agentId, action, roster, undefined, note !== undefined ? { note } : undefined)
    }
    if (action === 'withdraw-send') {
      if (clientMessageId === undefined || clientMessageId === '') return { outcome: 'refused' as const, detail: 'withdraw-send requires clientMessageId' }
      if (roster === null) return { outcome: 'refused' as const, detail: 'daemon roster not ready' }
      return withdrawSessionSend(sessionId, clientMessageId, roster)
    }
    if (action === 'background-shell') {
      if (roster === null) return { outcome: 'refused' as const, detail: 'daemon roster not ready' }
      return backgroundSessionShell(sessionId, roster)
    }
    if (action === 'send-now') {
      if (roster === null) return { outcome: 'refused' as const, detail: 'daemon roster not ready' }
      return sendSessionNow(sessionId, roster)
    }
    if (action === 'board-post') {
      if (boardPost === undefined) return { outcome: 'refused' as const, detail: 'board-post requires { boardPost: { clientOpId, channel, target?, text } }' }
      if (roster === null) return { outcome: 'refused' as const, detail: 'daemon roster not ready' }
      return postSessionBoard(sessionId, boardPost, roster)
    }
    if (action === 'pause-gate') {
      if (typeof paused !== 'boolean') return { outcome: 'refused' as const, detail: 'pause-gate requires paused' }
      if (roster === null) return { outcome: 'refused' as const, detail: 'daemon roster not ready' }
      return pauseSessionGate(sessionId, paused, roster)
    }
    if (action === 'leave') {
      if (roster === null) return { outcome: 'refused' as const, detail: 'daemon roster not ready' }
      return leaveSession(sessionId, roster)
    }
    if (action === 'stop') {
      roster?.door(rec.runnerId)?.request('turn/interrupt', { hard: true }).catch(passedOver)
      const out = stopConcourseSession(sessionId, by, roster ?? undefined)
      if (out.outcome === 'applied') dropSelfWakesAtFlip(sessionId, by, 'stopped')
      return out.outcome === 'refused'
        ? { outcome: 'refused' as const, detail: out.reason }
        : out.outcome === 'noop'
          ? { outcome: 'noop' as const, detail: out.reason }
          : out.acknowledged
            ? { outcome: 'applied' as const, detail: `stopped ${out.runnerId}` }
            : { outcome: 'applied' as const, detail: `stop sent — ${out.runnerId} ends its turn and its crewmates; the row reads stopped once it is gone` }
    }
    if (action === 'attach') {
      const out = attachYieldConcourseSession(sessionId, by, roster ?? undefined)
      return out.outcome === 'refused'
        ? { outcome: 'refused' as const, detail: out.detail ?? out.reason }
        : { outcome: out.outcome, detail: out.runnerId }
    }
    if (action === 'detach') {
      const out = detachRespawnConcourseSession(sessionId, by, roster ?? undefined, undefined, {
        ...(mintedAtMs !== undefined ? { mintedAtMs } : {}),
      })
      return out.outcome === 'applied'
        ? {
            outcome: 'applied' as const,
            detail: `${out.runnerId}${out.pid !== undefined ? ` pid ${out.pid}` : ''}`,
          }
        : out.outcome === 'noop'
          ? { outcome: 'noop' as const, detail: out.reason }
          : { outcome: 'refused' as const, detail: out.detail ?? out.reason }
    }
    if (action === 'grant-workflows' || action === 'revoke-workflows') {
      const out =
        action === 'grant-workflows'
          ? grantConcourseWorkflows(sessionId, by)
          : revokeConcourseWorkflows(sessionId, by)
      if (action === 'grant-workflows' && out.outcome === 'applied' && roster !== null) {
        const r = roster
        void buildConcoursePromptRow(
          '[switchboard notice] The crewmates-allowed tag just landed on this session — crewmates are available from your next turn. Automated notice; no reply needed.',
        )
          .then(row => r.reply(rec.runnerId, row))
          .catch(passedOver)
      }
      return out.outcome === 'applied'
        ? { outcome: 'applied' as const, detail: `${action} ${rec.runnerId}` }
        : out.outcome === 'noop'
          ? { outcome: 'noop' as const, detail: out.reason }
          : {
              outcome: 'refused' as const,
              detail: out.reason === 'cap-one' && out.detail !== undefined ? out.detail : out.reason,
            }
    }
    if (action === 'pause') {
      const out = pauseConcourseWorker(rec.runnerId, by)
      return settle(
        out.outcome === 'applied'
          ? { outcome: 'applied' as const, detail: `pause ${rec.runnerId}` }
          : { outcome: out.outcome, detail: out.reason },
      )
    }
    const out = resumeConcourseWorker(rec.runnerId, by)
    if (out.outcome === 'refused') return settle({ outcome: 'refused' as const, detail: out.reason })
    const fresh = Object.values(readSessionWorkers()).find(
      r => r.sessionId === sessionId && r.endedAt === undefined,
    )
    if (
      fresh &&
      fresh.attachedAt === undefined &&
      (fresh.pid === undefined || !isProcessAlive(fresh.pid))
    ) {
      const rev = reviveConcourseWorker(sessionId, by, roster ?? undefined, { allowStopped: true })
      if (rev.outcome === 'applied' && roster !== null) onSeatSpawned(rev.runnerId, roster)
      return settle(
        rev.outcome === 'applied'
          ? {
              outcome: 'applied' as const,
              detail: `resume ${rec.runnerId} — revived${rev.pid !== undefined ? ` (pid ${rev.pid})` : ''}`,
            }
          : rev.outcome === 'noop'
            ? { outcome: 'applied' as const, detail: `resume ${rec.runnerId}` }
            : {
                outcome: 'refused' as const,
                detail: `the valve opened but the session could not be revived: ${rev.detail ?? rev.reason}`,
              },
      )
    }
    return settle(
      out.outcome === 'applied'
        ? { outcome: 'applied' as const, detail: `resume ${rec.runnerId}` }
        : { outcome: out.outcome, detail: out.reason },
    )
  }
}
