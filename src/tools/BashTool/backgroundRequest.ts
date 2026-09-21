export type ShellRunV1 = {
  agentId: string | undefined
  request: () => void
}

const runs = new Set<ShellRunV1>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

export function registerShellRun(run: ShellRunV1): () => void {
  runs.add(run)
  notify()
  return () => {
    if (runs.delete(run)) notify()
  }
}

export function mainShellRunsNow(): number {
  let count = 0
  for (const run of runs) if (run.agentId === undefined) count += 1
  return count
}

export function subscribeShellRuns(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function requestShellBackground(): number {
  let taken = 0
  for (const run of runs) {
    if (run.agentId !== undefined) continue
    run.request()
    taken += 1
  }
  return taken
}
