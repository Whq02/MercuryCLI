
import { dirname, basename } from 'node:path'
import { isProcessAlive } from '../../daemon/ownerWatch.js'
import { concourseDeltaPath, readSessionWorkers, type ConcourseWorkerRecordV1 } from '../../daemon/concourseSupervisor.js'
import { currentProject, inProject, projectDisplayName, type ProjectIdentity } from '../../utils/bootCardFacts.js'
import { logForDebugging } from '../../utils/debug.js'

export const CROSS_PROJECT_FINISHED_REF = 'cross-project:finished:'

export function isCrossProjectFinishedRef(ref: string | undefined): boolean {
  return typeof ref === 'string' && ref.startsWith(CROSS_PROJECT_FINISHED_REF)
}

export function finishedStampOf(rec: ConcourseWorkerRecordV1, alive: boolean): number | undefined {
  if (rec.endedAt !== undefined || !alive) return undefined
  if (rec.attachedAt !== undefined || rec.stoppedAt !== undefined || rec.pausedAt !== undefined || rec.crash !== undefined) return undefined
  if ((rec as { parkedAt?: number }).parkedAt !== undefined) return undefined
  if (rec.lastTurnSettledAt === undefined) return undefined
  if (rec.lastDeliveryAt !== undefined && rec.lastTurnSettledAt < rec.lastDeliveryAt) return undefined
  return rec.lastTurnSettledAt
}

export interface CrossProjectMint {
  ref: string
  sessionId: string
  question: string
  dir: string
  name: string
}

export interface FinishSweepDeps {
  records: () => ConcourseWorkerRecordV1[]
  current: () => ProjectIdentity
  isAlive: (pid: number) => boolean
  seen: Map<string, number>
}

export function sweepCrossProjectFinishes(deps: FinishSweepDeps): CrossProjectMint[] {
  const recs = deps.records().filter(r => r.endedAt === undefined)
  const live = new Set(recs.map(r => r.sessionId))
  for (const id of [...deps.seen.keys()]) if (id !== SEEDED_SENTINEL && !live.has(id)) deps.seen.delete(id)
  const seeded = deps.seen.has(SEEDED_SENTINEL)
  const out: CrossProjectMint[] = []
  let current: ProjectIdentity | null = null
  for (const rec of recs) {
    const stamp = finishedStampOf(rec, rec.pid !== undefined && deps.isAlive(rec.pid))
    if (stamp === undefined) continue
    const prev = deps.seen.get(rec.sessionId)
    deps.seen.set(rec.sessionId, Math.max(prev ?? 0, stamp))
    if (!seeded) continue
    if (prev !== undefined && stamp <= prev) continue
    current ??= deps.current()
    if (inProject(current, rec.workspaceId)) continue
    const name = projectDisplayName(rec.workspaceId)
    const title = rec.title !== undefined && rec.title.length > 0 ? rec.title : rec.runnerId
    out.push({
      ref: `${CROSS_PROJECT_FINISHED_REF}${rec.sessionId}:${stamp}`,
      sessionId: rec.sessionId,
      question: `your agent in ${name} finished · ${title}`,
      dir: rec.workspaceId,
      name,
    })
  }
  if (!seeded) deps.seen.set(SEEDED_SENTINEL, 1)
  return out
}

const SEEDED_SENTINEL = '\u0000seeded'

async function mintCrossProjectFinish(m: CrossProjectMint): Promise<void> {
  const { upsertObligation } = await import('../crew/obligations.js')
  await upsertObligation({ ref: m.ref, sessionId: m.sessionId, question: m.question, owner: 'operator', scope: 'switchboard' })
}

export interface CrossProjectWatchHandle {
  dispose(): void
  _seenForTesting(): ReadonlyMap<string, number>
}

export function startCrossProjectFinishWatch(
  opts: { recordsDir?: string; tickMs?: number; enabled?: () => boolean } = {},
): CrossProjectWatchHandle {
  const seen = new Map<string, number>()
  if (opts.enabled !== undefined && !opts.enabled()) {
    return { dispose: () => {}, _seenForTesting: () => seen }
  }
  let alive = true
  let busy = false
  const beat = (): void => {
    if (!alive || busy) return
    busy = true
    void (async () => {
      try {
        const mints = sweepCrossProjectFinishes({
          records: () => Object.values(readSessionWorkers(opts.recordsDir)),
          current: currentProject,
          isAlive: isProcessAlive,
          seen,
        })
        for (const m of mints) {
          if (!alive) break
          await mintCrossProjectFinish(m)
        }
      } catch (e) {
        logForDebugging(`[cross-project] finish sweep failed (next beat retries): ${e}`)
      } finally {
        busy = false
      }
    })()
  }
  let watcher: import('node:fs').FSWatcher | null = null
  void import('node:fs')
    .then(fs => {
      if (!alive) return
      const deltaPath = concourseDeltaPath(opts.recordsDir)
      const dir = dirname(deltaPath)
      const name = basename(deltaPath)
      try {
        fs.mkdirSync(dir, { recursive: true })
        watcher = fs.watch(dir, (_ev, file) => {
          if (file !== null && file !== name) return
          beat()
        })
        watcher.on('error', () => {
          try {
            watcher?.close()
          } catch {
          }
          watcher = null
        })
      } catch {
      }
    })
    .catch(() => {})
  const timer = setInterval(beat, opts.tickMs ?? 15_000)
  timer.unref?.()
  beat()
  return {
    dispose: () => {
      alive = false
      clearInterval(timer)
      try {
        watcher?.close()
      } catch {
      }
      watcher = null
    },
    _seenForTesting: () => seen,
  }
}
