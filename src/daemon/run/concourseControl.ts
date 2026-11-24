import { logForDebugging } from '../../platform/logs/debugLog.js'
import type { makeConcourseDispatchHandler } from '../concourse-workers/concourseDispatch.js'
import { readConcourseControlOps, recordConcourseControlOpRidingOut, buildConcoursePromptRow, heldGitLaunchesFor, replayGitBlockedDispatches, denyProceedLaunchesFor, replayDenyProceedDispatches } from '../concourse-workers/concourseDispatch.js'
import { pauseConcourseWorker, readSessionWorkers, resumeConcourseWorker, attachYieldConcourseSession, blurConcourseSession, detachRespawnConcourseSession, focusConcourseSession, grantConcourseWorkflows, isNewbornRecord, parkAllConcourseSessions, parkConcourseSession, retireConcourseSession, revokeConcourseWorkflows, turnInFlightOf, workerPidAlive, stopConcourseSession, reviveConcourseWorker, setConcourseSessionTitle } from '../concourse-workers/concourseWorkers.js'
import type { ControlServerDeps } from '../control/controlServer.js'
import { isProcessAlive } from '../control/ownerWatch.js'
import { answerPermissionAsk } from '../session-seat/permissionAsks.js'
import type { TaskRoster } from '../roster/roster.js'
import { dropSaturnSelfWakes, type SaturnSelfWakeDropWhy } from '../saturn/saturn.js'
import { SESSION_VERBS } from '../runner-wire/sessionVerbs.js'
import { controlSessionCrewmate, applySeatScheduleControl, onSeatSpawned, pushScheduleRosterForSession, refreshSessionFacts, setSessionEffort, setSessionKitDial, actOnSessionMcp, listSessionMcpTools, setSessionModel, setSessionPermissionMode, setSessionSpawnSwitch, withdrawSessionSend, isGenericSeatVerb, forwardGenericSeatVerb, pauseSessionGate, postSessionBoard, leaveSession } from '../session-seat/sessionSeat.js'
import type { DaemonRunState } from './state.js'
import { passedOver, passedOverAs } from '../../platform/errors/passedOver.js'
import { errorMessage } from '../../platform/errors/errors.js'

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
  return async ({ action, sessionId, by, reason, hard, requestId, allow, answer, model, words, replacedDefault, effort, mode, kitEdit, mcpAction, mcpServer, scheduleEdit, spawnSwitch, terminalApplication, clientOpId, mintedAtMs, title, titleSource, agentId, note, clientMessageId, paused, boardPost }) => {
    const roster = state.roster
    void reason
    if (clientOpId !== undefined) {
      const prior = readConcourseControlOps()[clientOpId]
      if (prior && prior.action === action && prior.sessionId === sessionId)
        return { outcome: prior.outcome, ...(prior.detail !== undefined ? { detail: prior.detail } : {}) }
    }
    const settle = async (r: { outcome: 'applied' | 'noop' | 'refused'; detail?: string }): Promise<typeof r> => {
      if (clientOpId !== undefined) {
        try {
          await recordConcourseControlOpRidingOut({ clientOpId, action, sessionId, outcome: r.outcome, ...(r.detail !== undefined ? { detail: r.detail } : {}), atMs: Date.now() })
        } catch (e) {
          logForDebugging(
            `[daemon] concourse-control: applied-ops ledger write failed (${e instanceof Error ? e.message : String(e)}) — receipt returned unrecorded`,
          )
          return { ...r, detail: `${r.detail ?? r.outcome} — not recorded, so sending it again may apply it twice` }
        }
      }
      return r
    }
    if (action === SESSION_VERBS.answerAsk.daemon.action) {
      if (requestId === undefined || requestId === '') {
        return { outcome: 'refused' as const, detail: `${SESSION_VERBS.answerAsk.daemon.action} requires requestId` }
      }
      const answered = answerPermissionAsk(
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
      const rules = (answer as { permissionUpdates?: unknown } | undefined)?.permissionUpdates
      if (answered.outcome === 'applied' && Array.isArray(rules) && rules.length > 0 && roster !== null && sessionId) {
        refreshSessionFacts(sessionId, roster)
      }
      return answered
    }
    if (action === SESSION_VERBS.parkAll.daemon.action) {
      const all = parkAllConcourseSessions(by, roster ?? undefined, undefined, {
        reason: undefined,
        exceptFocusedByLiveTerminal: true,
      })
      console.error(
        `[daemon] ${SESSION_VERBS.parkAll.daemon.action} by ${by}: parked ${all.parked.length}, draining ${all.draining.length}, released ${all.released.length} newborn(s), skipped ${all.skipped.length}${all.refused.length > 0 ? `, refused ${all.refused.join(', ')}` : ''}`,
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
    if (action === SESSION_VERBS.park.daemon.action) {
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
    if (action === SESSION_VERBS.setTitle.daemon.action) {
      return settle(setConcourseSessionTitle(sessionId, title ?? '', by, titleSource === 'minted' ? 'minted' : 'operator'))
    }
    if (action === SESSION_VERBS.setSchedule.daemon.action) {
      if (scheduleEdit === undefined) return { outcome: 'refused' as const, detail: `${SESSION_VERBS.setSchedule.daemon.action} requires { scheduleEdit: { op, schedule? | scheduleId? } }` }
      return settle(applySeatScheduleControl(sessionId, scheduleEdit, by, roster))
    }
    if (action === SESSION_VERBS.mcpAction.daemon.action) {
      if (!mcpAction || !roster) return { outcome: 'refused' as const, detail: 'the MCP action or runner is unavailable' }
      return actOnSessionMcp(sessionId, mcpAction, roster)
    }
    if (action === SESSION_VERBS.mcpTools.daemon.action) {
      if (!mcpServer || !roster) return { outcome: 'refused' as const, detail: 'the MCP server or runner is unavailable' }
      return listSessionMcpTools(sessionId, mcpServer, roster)
    }
    if (action === SESSION_VERBS.setKit.daemon.action) {
      if (kitEdit === undefined) return { outcome: 'refused' as const, detail: `${SESSION_VERBS.setKit.daemon.action} requires { kitEdit: { mcp?, skills?, extensions? } }` }
      if (roster === null) return { outcome: 'refused' as const, detail: 'daemon roster not ready' }
      const dialed = setSessionKitDial(sessionId, kitEdit, by, roster)
      return dialed.outcome === 'queued'
        ? dialed
        : settle({ outcome: dialed.outcome, ...(dialed.detail !== undefined ? { detail: dialed.detail } : {}) })
    }
    if (action === SESSION_VERBS.setModel.daemon.action) {
      if (model === undefined || model === '') return { outcome: 'refused' as const, detail: `${SESSION_VERBS.setModel.daemon.action} requires model` }
      return roster !== null ? await setSessionModel(sessionId, model, roster, undefined, words, replacedDefault) : { outcome: 'refused' as const, detail: 'daemon roster not ready' }
    }
    if (action === SESSION_VERBS.setEffort.daemon.action) {
      if (effort === undefined || effort === '') return { outcome: 'refused' as const, detail: `${SESSION_VERBS.setEffort.daemon.action} requires effort` }
      return roster !== null ? setSessionEffort(sessionId, effort, roster) : { outcome: 'refused' as const, detail: 'daemon roster not ready' }
    }
    if (action === SESSION_VERBS.setSpawnSwitch.daemon.action) {
      if (spawnSwitch === undefined) return { outcome: 'refused' as const, detail: `${SESSION_VERBS.setSpawnSwitch.daemon.action} requires { spawnSwitch: { kind: subagents|workflows, on } }` }
      if (spawnSwitch.kind === 'workflows') return { outcome: 'noop' as const }
      return roster !== null ? setSessionSpawnSwitch(sessionId, { kind: spawnSwitch.kind, on: spawnSwitch.on }, by, roster) : { outcome: 'refused' as const, detail: 'daemon roster not ready' }
    }
    if (action === SESSION_VERBS.setPermissionMode.daemon.action) {
      if (mode === undefined || mode === '') return { outcome: 'refused' as const, detail: `${SESSION_VERBS.setPermissionMode.daemon.action} requires mode` }
      return roster !== null ? setSessionPermissionMode(sessionId, mode, roster) : { outcome: 'refused' as const, detail: 'daemon roster not ready' }
    }
    if (action === SESSION_VERBS.sessionFacts.daemon.action) {
      return roster !== null ? refreshSessionFacts(sessionId, roster) : { outcome: 'refused' as const, detail: 'daemon roster not ready' }
    }
    if (action === SESSION_VERBS.focus.daemon.action || action === SESSION_VERBS.blur.daemon.action) {
      const out = action === SESSION_VERBS.focus.daemon.action ? focusConcourseSession(sessionId, by, undefined, terminalApplication) : blurConcourseSession(sessionId, by)
      if (out.outcome === 'applied') {
        const left = action === SESSION_VERBS.focus.daemon.action && out.cleared.length > 0 ? ` — seat left ${out.cleared.join(', ')}` : ''
        return { outcome: 'applied' as const, detail: `${action} ${out.runnerId}${left}` }
      }
      return out.outcome === 'noop'
        ? { outcome: 'noop' as const, detail: out.reason }
        : { outcome: 'refused' as const, detail: out.reason }
    }
    if (action === SESSION_VERBS.interrupt.daemon.action) {
      const door = roster?.door(rec.runnerId)
      if (door === undefined) return settle({ outcome: 'refused' as const, detail: 'worker has no live runner door' })
      if (door.closed) return settle({ outcome: 'refused' as const, detail: 'the interrupt did not reach the runner: its door is closed' })
      const sent = door.send(SESSION_VERBS.interrupt.runner.name, { ...(clientOpId !== undefined ? { op_id: `concourse-interrupt-${clientOpId}` } : {}), ...(hard === true ? { hard: true } : {}) })
      sent.answer.catch(passedOverAs(undefined))
      dropSelfWakesAtFlip(sessionId, by, 'interrupted', roster)
      return settle({ outcome: 'applied' as const, detail: `${hard === true ? 'second interrupt' : SESSION_VERBS.interrupt.daemon.action} ${rec.runnerId}` })
    }
    if (action === SESSION_VERBS.stopAgent.daemon.action || action === SESSION_VERBS.resumeAgent.daemon.action) {
      if (agentId === undefined || agentId === '') return { outcome: 'refused' as const, detail: `${action} requires agentId` }
      if (roster === null) return { outcome: 'refused' as const, detail: 'daemon roster not ready' }
      return controlSessionCrewmate(sessionId, agentId, action, roster, undefined, note !== undefined ? { note } : undefined)
    }
    if (action === SESSION_VERBS.withdrawSend.daemon.action) {
      if (clientMessageId === undefined || clientMessageId === '') return { outcome: 'refused' as const, detail: `${SESSION_VERBS.withdrawSend.daemon.action} requires clientMessageId` }
      if (roster === null) return { outcome: 'refused' as const, detail: 'daemon roster not ready' }
      return withdrawSessionSend(sessionId, clientMessageId, roster)
    }
    if (isGenericSeatVerb(action)) {
      if (roster === null) return { outcome: 'refused' as const, detail: 'daemon roster not ready' }
      return forwardGenericSeatVerb(sessionId, action, roster)
    }
    if (action === SESSION_VERBS.postBoard.daemon.action) {
      if (boardPost === undefined) return { outcome: 'refused' as const, detail: `${SESSION_VERBS.postBoard.daemon.action} requires { boardPost: { clientOpId, channel, target?, text } }` }
      if (roster === null) return { outcome: 'refused' as const, detail: 'daemon roster not ready' }
      return postSessionBoard(sessionId, boardPost, roster)
    }
    if (action === SESSION_VERBS.pauseGate.daemon.action) {
      if (typeof paused !== 'boolean') return { outcome: 'refused' as const, detail: `${SESSION_VERBS.pauseGate.daemon.action} requires paused` }
      if (roster === null) return { outcome: 'refused' as const, detail: 'daemon roster not ready' }
      return pauseSessionGate(sessionId, paused, roster)
    }
    if (action === SESSION_VERBS.leave.daemon.action) {
      if (roster === null) return { outcome: 'refused' as const, detail: 'daemon roster not ready' }
      return leaveSession(sessionId, roster)
    }
    if (action === SESSION_VERBS.stop.daemon.action) {
      roster?.door(rec.runnerId)?.request(SESSION_VERBS.interrupt.runner.name, { hard: true }).catch(passedOver)
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
    if (action === SESSION_VERBS.attach.daemon.action) {
      const out = attachYieldConcourseSession(sessionId, by, roster ?? undefined)
      return out.outcome === 'refused'
        ? { outcome: 'refused' as const, detail: out.detail ?? out.reason }
        : { outcome: out.outcome, detail: out.runnerId }
    }
    if (action === SESSION_VERBS.detach.daemon.action) {
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
    if (action === SESSION_VERBS.grantWorkflows.daemon.action || action === SESSION_VERBS.revokeWorkflows.daemon.action) {
      const out =
        action === SESSION_VERBS.grantWorkflows.daemon.action
          ? grantConcourseWorkflows(sessionId, by)
          : revokeConcourseWorkflows(sessionId, by)
      if (action === SESSION_VERBS.grantWorkflows.daemon.action && out.outcome === 'applied' && roster !== null) {
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
    if (action === SESSION_VERBS.pause.daemon.action) {
      const out = pauseConcourseWorker(rec.runnerId, by)
      return settle(
        out.outcome === 'applied'
          ? { outcome: 'applied' as const, detail: `${SESSION_VERBS.pause.daemon.action} ${rec.runnerId}` }
          : { outcome: out.outcome, detail: out.reason },
      )
    }
    if (action !== SESSION_VERBS.resume.daemon.action) {
      return { outcome: 'refused' as const, detail: `unknown session action: ${action}` }
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
              detail: `${SESSION_VERBS.resume.daemon.action} ${rec.runnerId} — revived${rev.pid !== undefined ? ` (pid ${rev.pid})` : ''}`,
            }
          : rev.outcome === 'noop'
            ? { outcome: 'applied' as const, detail: `${SESSION_VERBS.resume.daemon.action} ${rec.runnerId}` }
            : {
                outcome: 'refused' as const,
                detail: `the valve opened but the session could not be revived: ${rev.detail ?? rev.reason}`,
              },
      )
    }
    return settle(
      out.outcome === 'applied'
        ? { outcome: 'applied' as const, detail: `${SESSION_VERBS.resume.daemon.action} ${rec.runnerId}` }
        : { outcome: out.outcome, detail: out.reason },
    )
  }
}
