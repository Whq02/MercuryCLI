import { useRef } from 'react';
import { useLoad } from '../../../hooks/effects.js';
import { logForDebugging } from '../../../utils/debug.js';
import { getCwd } from '../../../utils/cwd.js';
import { readConcourseSeedOverrides, writeConcourseSeedOverride } from '../../../services/concourse/concourseSnapshot.js';
import type { ConcourseSnapshotV1, ControlNoteState } from '../contracts.js';
import { passedOver, passedOverAs } from '../../../utils/passedOver.js';

export function useConcourseAdmissionPump({
  fixture,
  liveSnapshot,
  refresh,
  drainQueuedStack,
  noteControl,
}: {
  fixture: ConcourseSnapshotV1 | null
  liveSnapshot: ConcourseSnapshotV1 | null
  refresh: () => void
  drainQueuedStack: (dispatchId: string, sessionId: string) => Promise<void>
  noteControl: (control: string, state: ControlNoteState) => void
}): void {
  const bootGroundApplied = useRef(false)
  useLoad(() => {
    if (fixture !== null || bootGroundApplied.current) return
    bootGroundApplied.current = true
    void (async () => {
      try {
        const seeds = await readConcourseSeedOverrides()
        if (typeof seeds.projectDir === 'string' && seeds.projectDir.length > 0 && seeds.projectDir !== getCwd()) {
          await writeConcourseSeedOverride({ projectDir: null })
          refresh()
        }
      } catch (error) {
        passedOver(error)
      }
    })()
  }, [fixture, refresh])
  const pumpBusyRef = useRef(false)
  useLoad(() => {
    if (fixture !== null) return
    if (pumpBusyRef.current) return
    const snap = liveSnapshot
    if (!snap) return
    pumpBusyRef.current = true
    void (async () => {
      try {
        const store = await import('../../../services/concourse/concourseSnapshot.js')
        const dispatchMod = await import('../../../daemon/concourseDispatch.js')
        const { daemonControlRpc } = await import('../../../daemon/controlSocket.js')
        try {
          const attachedMod = await import('../../../services/switchboard/attachedSession.js')
          const marker = await store.readConcoursePendingHandback()
          let handedBack = 0
          if (
            marker !== null &&
            (await attachedMod.completeHandback(marker.kind, marker.sessionId, {
              mintedAtMs: marker.mintedAtMs,
            }))
          ) {
            handedBack++
          }
          handedBack += await attachedMod.healStaleAttachRecords()
          if (handedBack > 0) {
            noteControl('strip:composer', {
              state: 'applied',
              reason: 'the session was handed back — it lives on the board again',
            })
            refresh()
          }
        } catch (error) {
          passedOver(error)
        }
        const deliveries = await store.readConcourseHeldDeliveries()
        const deliveryIds = Object.keys(deliveries)
        if (deliveryIds.length > 0) {
          const { readSessionWorkers } = await import('../../../daemon/concourseWorkers.js')
          const workers = Object.values(readSessionWorkers())
          for (const sessionId of deliveryIds) {
            const heldDelivery = deliveries[sessionId]
            if (heldDelivery === undefined) continue
            const drec = dispatchMod.readConcourseDispatches()[heldDelivery.clientMessageId]
            if (drec === undefined || drec.heldReason === undefined || drec.state !== 'queued') {
              await store.writeConcourseHeldDelivery(sessionId, null)
              continue
            }
            const w = workers.find(x => x.sessionId === sessionId && x.endedAt === undefined)
            const free = w !== undefined && w.attachedAt === undefined && w.pausedAt === undefined && w.attachRequestedAt === undefined
            if (!free) continue
            const dreply = await daemonControlRpc(
              {
                op: 'concourseDispatch',
                clientMessageId: heldDelivery.clientMessageId,
                prompt: heldDelivery.text,
                workspaceDir: '',
                targetSessionId: sessionId,
                by: 'operator',
              },
              { timeoutMs: 15_000 },
            )
            if (dreply.ok === true || dreply.heldReason === undefined) {
              await store.writeConcourseHeldDelivery(sessionId, null)
              refresh()
            }
          }
        }
        try {
          const rowsNY = snap.needsYou ?? []
          if (rowsNY.length > 0) {
            const o = await import('../../../services/crew/obligations.js')
            const sup = await import('../../../daemon/concourseWorkers.js')
            const state = await import('../../../bootstrap/state.js')
            const hostId = String(state.getSessionId())
            const workerRecs = Object.values(sup.readSessionWorkers())
            const ledger = dispatchMod.readConcourseDispatches()
            for (const ny of rowsNY.slice(0, 12)) {
              const sid = ny.sessionId
              if (sid === hostId || sid.startsWith('folder:')) continue
              let stale = false
              if (sid.startsWith('dispatch:')) {
                const drow = ledger[sid.slice('dispatch:'.length)]
                stale =
                  drow !== undefined &&
                  (drow.sessionId !== undefined || drow.reason?.startsWith('withdrawn') === true)
              } else {
                stale =
                  workerRecs.some(r => r.sessionId === sid && r.endedAt !== undefined) &&
                  !workerRecs.some(r => r.sessionId === sid && r.endedAt === undefined)
              }
              if (stale) {
                await o
                  .resolveObligation(ny.obligationId, { kind: 'superseded', by: 'board-sweep', scope: 'switchboard' })
                  .catch(passedOverAs(undefined))
              }
            }
          }
        } catch (error) {
          passedOver(error)
        }
        const held = await store.readConcourseHeldDispatch()
        if (held === null || held.prompt === undefined) return
        const rec = dispatchMod.readConcourseDispatches()[held.clientMessageId]
        if (rec === undefined) return
        if (rec.sessionId !== undefined && rec.state !== 'queued' && rec.state !== 'failed') {
          await drainQueuedStack(held.clientMessageId, rec.sessionId)
          await store.writeConcourseHeldDispatch(null)
          return
        }
        if (rec.state !== 'queued' || rec.heldReason === undefined || rec.sessionId !== undefined) return
        const reason = dispatchMod.normalizeHoldReason(rec.heldReason)
        const rows = snap.groups.flatMap(g => g.rows)
        let cleared = false
        if (reason === 'seat') {
          const { effectiveSeatCeiling } = await import('../../../daemon/concourseWorkers.js')
          cleared = snap.counts.live < effectiveSeatCeiling()
        } else if (reason === 'repo-held') {
          cleared = !rows.some(
            r =>
              r.workspaceDir === rec.workspaceId &&
              r.worktreeBranch === undefined &&
              !r.sessionId.startsWith('dispatch:') &&
              r.state !== 'queued' &&
              r.state !== 'stopped',
          )
        } else if (reason === 'no-repository' || reason === 'unborn-head') {
          const { workspaceKindOf } = await import('../../../daemon/concourseWorktrees.js')
          cleared = rec.workspaceId !== undefined && workspaceKindOf(rec.workspaceId) === 'git'
        }
        if (!cleared) return
        const reply = (await daemonControlRpc(
          {
            op: 'concourseDispatch',
            clientMessageId: held.clientMessageId,
            by: 'operator',
            prompt: held.prompt,
            ...(held.op ?? {}),
          } as never,
          { timeoutMs: 15_000 },
        )) as { ok?: boolean; sessionId?: string; branchName?: string }
        if (reply.ok === true) {
          await store.writeConcourseHeldDispatch(null)
          noteControl('strip:composer', {
            state: 'applied',
            reason:
              reply.branchName !== undefined
                ? `the queued session started on worktree ${reply.branchName}`
                : 'the queued session started — its block cleared',
          })
          if (reply.sessionId !== undefined) await drainQueuedStack(held.clientMessageId, reply.sessionId)
          refresh()
        }
      } catch (e) {
        logForDebugging(`[concourse] admission pump beat failed (next refresh retries): ${e}`)
      } finally {
        pumpBusyRef.current = false
      }
    })()
  }, [liveSnapshot, fixture, drainQueuedStack, noteControl, refresh])
}
