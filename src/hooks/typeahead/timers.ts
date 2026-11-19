const liveTypeaheadTimers = new Set<ReturnType<typeof setTimeout>>()

export function typeaheadTimerCensus(): number {
  return liveTypeaheadTimers.size
}

export function armTypeaheadTimer(run: () => void, delayMs: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    liveTypeaheadTimers.delete(timer)
    run()
  }, delayMs)
  liveTypeaheadTimers.add(timer)
  return timer
}

export function disarmTypeaheadTimer(timer: ReturnType<typeof setTimeout>): void {
  clearTimeout(timer)
  liveTypeaheadTimers.delete(timer)
}
