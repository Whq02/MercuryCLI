import { useMemo, useRef, useState } from 'react';
import { useTimer } from '../../../hooks/effects.js';
import { readFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { flagEnv } from '../../../substrate/flagRegistry.js';
import { logForDebugging } from '../../../utils/debug.js';
import { buildConcourseSnapshot, sanitizeLabel, subscribeConcourseDraft } from '../../../services/concourse/concourseSnapshot.js';
import { subscribeObligations } from '../../../services/crew/obligations.js';
import { subscribeCurrentProject } from '../../../utils/bootCardFacts.js';
import { subscribeFocusedSessionConnector } from '../../../services/engine-connector/focusedConnector.js';
import type { ConcourseSnapshotV1 } from '../contracts.js';
import { passedOver } from '../../../utils/passedOver.js';

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
    let watcher: import('node:fs').FSWatcher | null = null
    let lastDelta = ''
    void Promise.all([import('../../../daemon/concourseWorkers.js'), import('node:fs')])
      .then(([sup, fs]) => {
        if (!alive.current) return
        const deltaPath = sup.concourseDeltaPath()
        const dir = dirname(deltaPath)
        const name = basename(deltaPath)
        try {
          fs.mkdirSync(dir, { recursive: true })
          watcher = fs.watch(dir, (_ev, file) => {
            if (file !== null && file !== name) return
            try {
              const raw = fs.readFileSync(deltaPath, 'utf8')
              const stamp = JSON.parse(raw) as { pid?: number; revision?: number }
              const key = `${stamp.pid ?? 0}:${stamp.revision ?? 0}`
              if (key === lastDelta) return
              lastDelta = key
            } catch (error) {
              passedOver(error)
            }
            rebuild()
          })
          watcher.on('error', () => {
            try {
              watcher?.close()
            } catch (error) {
              passedOver(error)
            }
            watcher = null
          })
        } catch (error) {
          passedOver(error)
        }
      })
      .catch(passedOver)
    const timer = setInterval(rebuild, 15_000)
    timer.unref?.()
    return () => {
      alive.current = false
      unsubObl()
      unsubDraft()
      unsubProject()
      unsubSlot()
      watcher?.close()
      clearInterval(timer)
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
