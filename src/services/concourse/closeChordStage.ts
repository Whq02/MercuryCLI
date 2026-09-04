
export const CLOSE_CHORD_STAGE_WINDOW_MS = 5000

export interface CloseChordStageSnapshot {
  readonly sessionId: string
  readonly at: number
}

export interface CloseChordStage {
  arm(sessionId: string, now?: number): void
  clear(): void
  standsFor(sessionId: string | null | undefined): boolean
  read(): CloseChordStageSnapshot | null
  subscribe(listener: () => void): () => void
  dispose(): void
}

export function createCloseChordStage(windowMs: number = CLOSE_CHORD_STAGE_WINDOW_MS): CloseChordStage {
  let stage: CloseChordStageSnapshot | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const fn of [...listeners]) fn()
  }
  const stopTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
  }
  const set = (next: CloseChordStageSnapshot | null): void => {
    stopTimer()
    stage = next
    if (next !== null) {
      timer = setTimeout(() => {
        timer = null
        if (stage !== next) return
        stage = null
        notify()
      }, windowMs)
      timer.unref?.()
    }
    notify()
  }
  return {
    arm: (sessionId, now = Date.now()) => set({ sessionId, at: now }),
    clear: () => {
      if (stage !== null) set(null)
    },
    standsFor: sessionId => stage !== null && sessionId !== null && sessionId !== undefined && stage.sessionId === sessionId,
    read: () => stage,
    subscribe: listener => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dispose: () => {
      stopTimer()
      stage = null
      listeners.clear()
    },
  }
}
