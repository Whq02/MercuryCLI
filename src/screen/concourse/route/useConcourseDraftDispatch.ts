import { useCallback, useRef } from 'react';
import { useLoad } from '../../effects/effects.js';
import { basename } from 'node:path';
import { logForDebugging } from '../../../platform/logs/debugLog.js';
import { getCwd } from '../../../platform/files/cwd.js';
import { getInitialEffortSetting } from '../../../models/effort/effort.js';
import { dispatchSeedInputs, readConcourseSeedOverrides, writeConcourseDraft } from '../../concourse-model/concourseSnapshot.js';
import type { ConcourseSnapshotV1, ControlNoteState } from '../contracts.js';
import { concourseWaitCopy } from '../contracts.js';
import { thisMercuryCommand } from '../../../platform/update-channel/installPath.js';
import { pollUntil } from '../../../platform/async/deadline.js';
import { startTimeout } from '../../../platform/async/timers.js';

export function useConcourseDraftDispatch({
  snapshotRef,
  noteResident,
  refresh,
  noteControl,
}: {
  snapshotRef: { current: ConcourseSnapshotV1 | null }
  noteResident: (state: 'wink' | 'refused' | 'held', reason?: string) => void
  refresh: () => void
  noteControl: (control: string, state: ControlNoteState) => void
}) {
  const submitInFlight = useRef(false)
  const seedWriteChain = useRef<Promise<unknown>>(Promise.resolve())
  const birthInFlightRef = useRef(false)
  const submitIdRef = useRef<{ key: string; id: string } | null>(null)
  useLoad(() => {
    void import('../../concourse-model/concourseSnapshot.js').then(async s => {
      if (submitIdRef.current !== null) return
      const held = await s.readConcourseHeldDispatch()
      if (held !== null && submitIdRef.current === null)
        submitIdRef.current = { key: held.envelopeKey, id: held.clientMessageId }
    })
  }, [])
  const daemonOfferRef = useRef<{ draft: string } | null>(null)
  const submitDraft = useCallback(
    (draft: string): void => {
      if (submitInFlight.current) return
      submitInFlight.current = true
      void (async () => {
        try {
          const { daemonControlRpc } = await import('../../../daemon/control/controlSocket.js')
          const { randomUUID } = await import('../../../platform/primitives/crypto.js')
          await seedWriteChain.current
          const seeds = await readConcourseSeedOverrides()
          const si = dispatchSeedInputs(seeds, getCwd(), snapshotRef.current?.newSession.seeds.modelId, getInitialEffortSetting())
          const envelopeKey = `${draft}\u0000${JSON.stringify(si)}`
          const minted = submitIdRef.current
          const clientMessageId =
            minted !== null && minted.key === envelopeKey ? minted.id : `concourse-ui-${randomUUID()}`
          submitIdRef.current = { key: envelopeKey, id: clientMessageId }
          const opInputs = {
            workspaceDir: si.workspaceDir,
            ...(si.modelKey !== undefined ? { model: si.modelKey } : {}),
            ...(si.effort !== undefined ? { effort: si.effort } : {}),
            title: si.title ?? draft.replace(/\s+/g, ' ').slice(0, 48),
            ...(si.agentName !== undefined ? { agentName: si.agentName } : {}),
            ...(si.seatsMax !== undefined ? { seatsMax: si.seatsMax } : {}),
            ...(seeds.isolation !== undefined ? { isolation: si.isolation } : {}),
          }
          const reply = await daemonControlRpc(
            {
              op: 'concourseDispatch',
              clientMessageId,
              by: 'operator',
              prompt: draft,
              ...opInputs,
            },
            { timeoutMs: 15_000 },
          )
          const snapshotStore = await import('../../concourse-model/concourseSnapshot.js')
          if ((reply as { ok?: boolean }).ok) {
            submitIdRef.current = null
            await snapshotStore.writeConcourseHeldDispatch(null)
            await writeConcourseDraft('')
            noteResident('wink')
            const okr = reply as { branchName?: string; mainHolderTitle?: string }
            const landedIn = basename(si.workspaceDir) || si.workspaceDir
            noteControl(
              'strip:composer',
              okr.branchName !== undefined
                ? {
                    state: 'applied',
                    reason: `on worktree ${okr.branchName} in ${landedIn}${okr.mainHolderTitle !== undefined ? ` — main checkout is with ${okr.mainHolderTitle}` : ''}`,
                  }
                : { state: 'applied', reason: `started in ${landedIn}` },
            )
          } else {
            const r = reply as {
              state?: string
              heldReason?: string
              heldByTitle?: string
              moves?: Array<{ verb: string; label: string }>
              detail?: string
              error?: string
              code?: string
            }
            if (r.state === 'queued') {
              await snapshotStore.writeConcourseHeldDispatch({
                clientMessageId,
                envelopeKey,
                prompt: draft,
                op: opInputs,
              })
              const waitCopy = concourseWaitCopy(r.heldReason, r.heldByTitle)
              noteResident('held', waitCopy)
              noteControl('strip:composer', {
                state: 'held',
                reason: waitCopy,
                next: r.moves?.[0]?.label ?? '↵ again replays the same request',
              })
            } else if (r.code === 'ETIMEOUT' || r.code === 'ENOCONN') {
              await snapshotStore.writeConcourseHeldDispatch({
                clientMessageId,
                envelopeKey,
                prompt: draft,
                op: opInputs,
              })
              if (r.code === 'ENOCONN') {
                daemonOfferRef.current = { draft }
                noteResident('held', 'the daemon that hosts background sessions is not running')
                noteControl('strip:composer', {
                  state: 'failed',
                  reason: 'the daemon that hosts background sessions is not running',
                  next: 'y starts it · n keeps your draft',
                })
              } else {
                noteResident('held', 'the daemon did not answer')
                noteControl('strip:composer', {
                  state: 'failed',
                  reason: 'the daemon did not answer',
                  next: '↵ retries the same request',
                })
              }
            } else {
              submitIdRef.current = null
              await snapshotStore.writeConcourseHeldDispatch(null)
              const reason = r.detail ?? r.error ?? 'the dispatch was refused'
              noteResident('refused', reason)
              noteControl('strip:composer', {
                state: 'refused',
                reason,
                next: 'edit the task or seeds · ↵ retries',
              })
            }
          }
        } catch (e) {
          logForDebugging(`[concourse] dispatch failed: ${e}`)
          noteResident('held', 'the daemon was unreachable')
          noteControl('strip:composer', { state: 'failed', reason: 'the daemon was unreachable', next: '↵ retries' })
        } finally {
          startTimeout(() => {
            submitInFlight.current = false
          }, 500)
          refresh()
        }
      })()
    },
    [noteResident, refresh, noteControl],
  )
  const answerDaemonOffer = useCallback(
    (yes: boolean): void => {
      const offer = daemonOfferRef.current
      if (offer === null) return
      daemonOfferRef.current = null
      if (!yes) {
        noteControl('strip:composer', {
          state: 'failed',
          reason: 'the daemon that hosts background sessions is not running',
          next: `start it with \`${thisMercuryCommand()} daemon\` · your draft is kept`,
        })
        return
      }
      noteControl('strip:composer', { state: 'pending', reason: 'starting the daemon…' })
      void (async () => {
        const { spawnOwnedDaemon } = await import('../../../daemon/control/ownedDaemon.js')
        const { daemonControlRpc } = await import('../../../daemon/control/controlSocket.js')
        const pid = spawnOwnedDaemon(getCwd(), { label: 'concourse' })
        if (pid === undefined) {
          noteControl('strip:composer', {
            state: 'failed',
            reason: 'the daemon did not start (see .mercury/daemon/daemon.log)',
            next: `run \`${thisMercuryCommand()} daemon\` yourself · your draft is kept`,
          })
          return
        }
        let tries = 0
        const ready = await pollUntil(
          async () => {
            const probe = await daemonControlRpc({ op: 'concourseList' }, { timeoutMs: 500 })
            if (probe.ok || probe.code !== 'ENOCONN') return true
            tries += 1
            return tries >= 40 ? false : undefined
          },
          250,
          Infinity,
          () => false,
        )
        if (ready) {
          submitDraft(offer.draft)
          return
        }
        noteControl('strip:composer', {
          state: 'failed',
          reason: 'the daemon started but never answered (see .mercury/daemon/daemon.log)',
          next: '↵ retries · your draft is kept',
        })
      })()
    },
    [noteControl, submitDraft],
  )
  return { seedWriteChain, birthInFlightRef, daemonOfferRef, submitDraft, answerDaemonOffer }
}
