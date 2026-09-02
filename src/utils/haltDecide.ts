// ============================================================================
//  haltDecide — the PURE decision/format core of the /halt hard-stop (#35).
//  Split out from haltAll.ts (which imports the daemon RPC + stopTask, dragging in
//  the feature()-macro'd voice module → unloadable under bare `bun run`) so the
//  decision logic stays unit-testable. No imports, no side effects.
// ============================================================================

export type ReapedWorker = {
  short: string
  kind: 'long-lived' | 'one-shot'
  purpose: string
  pid?: number
}

export type HaltResult = {
  tasksStopped: string[]
  tasksFailed: string[]
  daemon: { ok: boolean; reaped?: number; workers?: ReapedWorker[]; reason?: string }
}

type LooseTask = { id: string; status: string }

/** Which in-process tasks should a hard stop kill? Every RUNNING one. Pure. */
export function runningTaskIds(tasks: Record<string, LooseTask> | undefined): string[] {
  if (!tasks) return []
  return Object.values(tasks)
    .filter(t => t && t.status === 'running')
    .map(t => t.id)
}

/** How many reaped workers the halt line NAMES before folding the rest
 *  into '+N more' — the report stays one line while staying honest. */
const HALT_NAMED_WORKER_CAP = 6

/** Summarize a halt outcome into one honest operator-facing line. Pure.
 *  A reaped daemon names WHAT it reaped ('implementer seat', a dispatched
 *  run's prompt clip) — 'reaped 5 workers' told the operator nothing about
 *  what those five were. */
export function summarizeHalt(r: HaltResult): string {
  const parts: string[] = []
  parts.push(
    r.tasksStopped.length > 0
      ? `stopped ${r.tasksStopped.length} in-process agent(s)`
      : 'no in-process agents running',
  )
  if (r.tasksFailed.length > 0) parts.push(`${r.tasksFailed.length} would not stop`)
  if (r.daemon.ok) {
    const workers = r.daemon.workers ?? []
    if (workers.length > 0) {
      const named = workers
        .slice(0, HALT_NAMED_WORKER_CAP)
        .map(w => `${w.short} — ${w.purpose}`)
        .join(', ')
      const more = workers.length - HALT_NAMED_WORKER_CAP
      parts.push(
        `daemon halted (reaped ${workers.length}: ${named}${more > 0 ? `, +${more} more` : ''})`,
      )
    } else if (r.daemon.reaped != null && r.daemon.reaped > 0) {
      // An older daemon that only counted: report the count, honestly bare.
      parts.push(`daemon halted (reaped ${r.daemon.reaped} worker${r.daemon.reaped === 1 ? '' : 's'})`)
    } else {
      parts.push('daemon halted (no live workers to reap)')
    }
  } else {
    parts.push(`daemon: ${r.daemon.reason ?? 'not running'}`)
  }
  return parts.join(' · ')
}
