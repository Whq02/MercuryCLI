export type PauseGateState = {
  paused: boolean
  parked: number
  since: number | null
}

export type PauseGate = {
  pause(): boolean
  resume(): boolean
  toggle(): boolean
  paused(): boolean
  park(signal: AbortSignal, seat?: string): Promise<void>
  parked(): readonly string[]
  state(): PauseGateState
  subscribe(listener: (state: PauseGateState) => void): () => void
}

export const PAUSE_GATE_MAIN_SEAT = 'main'

export const OPERATOR_PAUSE_WORDS = 'paused by the operator'

export const OPERATOR_PAUSE_DOOR = 'p resumes it'

export function pauseGateModelWords(): string {
  return `${OPERATOR_PAUSE_WORDS} · at a model call — ${OPERATOR_PAUSE_DOOR}`
}

export function pauseGateToolWords(toolName: string): string {
  return `${OPERATOR_PAUSE_WORDS} · at a tool (${toolName}) — ${OPERATOR_PAUSE_DOOR}`
}

export function isOperatorPauseWait(wait: string | null | undefined): boolean {
  return typeof wait === 'string' && wait.startsWith(OPERATOR_PAUSE_WORDS)
}

export function operatorPauseWaitParts(wait: string | null | undefined): { gate: string; detail: string; door: string } | null {
  if (!isOperatorPauseWait(wait)) return null
  const rest = (wait as string).slice(OPERATOR_PAUSE_WORDS.length)
  const body = rest.startsWith(' · ') ? rest.slice(3) : rest.trim()
  const dash = body.indexOf(' — ')
  return dash < 0 ? { gate: OPERATOR_PAUSE_WORDS, detail: body, door: '' } : { gate: OPERATOR_PAUSE_WORDS, detail: body.slice(0, dash), door: body.slice(dash + 3) }
}

export function pauseGateChipWords(state: Pick<PauseGateState, 'paused' | 'parked'>): string | null {
  if (!state.paused) return null
  return state.parked === 0 ? OPERATOR_PAUSE_WORDS : `${OPERATOR_PAUSE_WORDS} · ${state.parked} parked`
}

type Waiter = {
  seat: string
  release: () => void
}

export function createPauseGate(): PauseGate {
  let closed = false
  let since: number | null = null
  const waiters = new Set<Waiter>()
  const listeners = new Set<(state: PauseGateState) => void>()
  let snapshot: PauseGateState = { paused: false, parked: 0, since: null }

  const emit = (): void => {
    snapshot = { paused: closed, parked: waiters.size, since }
    for (const listener of listeners) {
      try {
        listener(snapshot)
      } catch {
        continue
      }
    }
  }

  const pause = (): boolean => {
    if (closed) return false
    closed = true
    since = Date.now()
    emit()
    return true
  }

  const resume = (): boolean => {
    if (!closed) return false
    closed = false
    since = null
    const released = [...waiters]
    waiters.clear()
    for (const waiter of released) waiter.release()
    emit()
    return true
  }

  const park = (signal: AbortSignal, seat: string = PAUSE_GATE_MAIN_SEAT): Promise<void> => {
    if (!closed || signal.aborted) return Promise.resolve()
    return new Promise<void>(resolve => {
      const waiter: Waiter = {
        seat,
        release: () => {
          signal.removeEventListener('abort', onAbort)
          resolve()
        },
      }
      const onAbort = (): void => {
        if (!waiters.delete(waiter)) return
        waiter.release()
        emit()
      }
      signal.addEventListener('abort', onAbort, { once: true })
      waiters.add(waiter)
      emit()
    })
  }

  return {
    pause,
    resume,
    toggle: () => {
      if (closed) {
        resume()
        return false
      }
      pause()
      return true
    },
    paused: () => closed,
    park,
    parked: () => [...waiters].map(waiter => waiter.seat),
    state: () => snapshot,
    subscribe: listener => {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

export const operatorPauseGate: PauseGate = createPauseGate()

export function pauseGateSeatOf(context: { agentId?: unknown; seatHolder?: string }): string {
  if (typeof context.seatHolder === 'string' && context.seatHolder !== '') return context.seatHolder
  return context.agentId !== undefined && context.agentId !== null ? String(context.agentId) : PAUSE_GATE_MAIN_SEAT
}
