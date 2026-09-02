
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

export function runningTaskIds(tasks: Record<string, LooseTask> | undefined): string[] {
  if (!tasks) return []
  return Object.values(tasks)
    .filter(t => t && t.status === 'running')
    .map(t => t.id)
}

const HALT_NAMED_WORKER_CAP = 6

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
      parts.push(`daemon halted (reaped ${r.daemon.reaped} worker${r.daemon.reaped === 1 ? '' : 's'})`)
    } else {
      parts.push('daemon halted (no live workers to reap)')
    }
  } else {
    parts.push(`daemon: ${r.daemon.reason ?? 'not running'}`)
  }
  return parts.join(' · ')
}
