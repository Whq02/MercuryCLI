import { useMemo, useRef, useState } from 'react';
import { useTimer } from '../../effects/effects.js';
import { readFileSync } from 'node:fs';
import { flagEnv } from '../../../platform/substrate/flagRegistry.js';
import { logForDebugging } from '../../../platform/logs/debugLog.js';
import { subscribeConcourseDispatches } from '../../../daemon/concourse-workers/concourseDispatch.js';
import { subscribeConcourseDelta } from '../../../daemon/concourse-workers/store.js';
import { buildConcourseSnapshot, sanitizeLabel, subscribeConcourseDraft } from '../../concourse-model/concourseSnapshot.js';
import { subscribeObligations } from '../../../crew/crewmates/obligations.js';
import { subscribeCurrentProject } from '../../boot-face/bootCardFacts.js';
import { subscribeFocusedSessionConnector } from '../../../engine/connector/focusedConnector.js';
import type { ConcourseSnapshotV1 } from '../contracts.js';
import { passedOver } from '../../../platform/errors/passedOver.js';
import { subscribeUiClock } from '../../cockpit/uiClock.js';

let lastCoherentSnapshot: ConcourseSnapshotV1 | null = null

export function makeCoalescedRebuild(
  runBuild: () => Promise<void>,
  isAlive: () => boolean,
): () => void {
  let active = false
  let pending = false
  const kick = (): void => {
    if (active) {
      pending = true
      return
    }
    active = true
    void runBuild().finally(() => {
      active = false
      if (pending && isAlive()) {
        pending = false
        kick()
      }
    })
  }
  return kick
}

export function useConcourseSnapshot(): {
  snapshot: ConcourseSnapshotV1 | null
  failing: boolean
  setPeek: (sessionId: string) => void
  noteResident: (state: 'wink' | 'refused' | 'held', reason?: string) => void
  refresh: () => void
} {
  const [snapshot, setSnapshot] = useState<ConcourseSnapshotV1 | null>(lastCoherentSnapshot)
  const [failing, setFailing] = useState(false)
  const peekRef = useRef<string | undefined>(undefined)
  const residentRef = useRef<'wink' | 'refused' | 'held' | undefined>(undefined)
  const residentReasonRef = useRef<string | undefined>(undefined)
  const alive = useRef(true)
  const buildSeq = useRef(0)
  const rebuild = useMemo(
    () =>
      makeCoalescedRebuild(async () => {
        const seq = ++buildSeq.current
        try {
          const s = await buildConcourseSnapshot({
            ...(peekRef.current !== undefined ? { peekSessionId: peekRef.current } : {}),
            ...(residentRef.current !== undefined ? { residentOverride: residentRef.current } : {}),
          })
          if (!alive.current || seq !== buildSeq.current) return
          const reason = residentReasonRef.current
          const next =
            reason !== undefined && s.peek !== null
              ? { ...s, peek: { ...s.peek, residentReason: reason } }
              : s
          lastCoherentSnapshot = next
          setSnapshot(next)
          setFailing(false)
        } catch (e) {
          logForDebugging(`[concourse] snapshot rebuild failed: ${e}`)
          if (alive.current && seq === buildSeq.current) setFailing(true)
        }
      }, () => alive.current),
    [],
  )
  useTimer(() => {
    alive.current = true
    rebuild()
    const unsubObl = subscribeObligations(
      () => {
        rebuild()
      },
      { scope: 'switchboard' },
    )
    const unsubDraft = subscribeConcourseDraft(rebuild)
    const unsubProject = subscribeCurrentProject(rebuild)
    const unsubSlot = subscribeFocusedSessionConnector(() => rebuild())
    const unsubDelta = subscribeConcourseDelta(rebuild)
    const unsubDispatches = subscribeConcourseDispatches(rebuild)
    const unsubFloor = subscribeUiClock(15_000, rebuild)
    return () => {
      alive.current = false
      unsubObl()
      unsubDraft()
      unsubProject()
      unsubSlot()
      unsubDelta()
      unsubDispatches()
      unsubFloor()
    }
  }, [rebuild])
  return {
    snapshot,
    setPeek: (sessionId: string) => {
      peekRef.current = sessionId
      residentRef.current = undefined
      rebuild()
    },
    noteResident: (state: 'wink' | 'refused' | 'held', reason?: string) => {
      residentRef.current = state
      residentReasonRef.current = reason
      rebuild()
    },
    refresh: rebuild,
    failing,
  }
}

export function readFixtureSnapshot(): ConcourseSnapshotV1 | null {
  try {
    const path = flagEnv('MERCURY_CONCOURSE_FIXTURE')
    if (!path) return null
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as ConcourseSnapshotV1
    if (parsed.schema !== 1) return null
    const floor = <T extends { title: string }>(r: T): T => ({ ...r, title: sanitizeLabel(r.title) })
    return {
      ...parsed,
      needsYou: parsed.needsYou.map(o => ({ ...floor(o), question: sanitizeLabel(o.question) })),
      groups: parsed.groups.map(g => ({ ...g, rows: g.rows.map(floor) })),
      peek: parsed.peek ? floor(parsed.peek) : null,
    }
  } catch (error) {
    passedOver(error)
    return null
  }
}
