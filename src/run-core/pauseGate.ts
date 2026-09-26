import { emitTaskProgress } from '../utils/task/sdkProgress.js'

export type PauseGateState = {
  paused: boolean
  parked: number
  since: number | null
  by: string | null
}

export type PauseGate = {
  pause(by?: string): boolean
  resume(): boolean
  toggle(): boolean
  paused(): boolean
  pausedBy(): string | null
  park(signal: AbortSignal, seat?: string): Promise<void>
  parked(): readonly string[]
  state(): PauseGateState
  subscribe(listener: (state: PauseGateState) => void): () => void
}

export const PAUSE_GATE_MAIN_SEAT = 'main'

export const OPERATOR_PAUSE_WORDS = 'paused by the operator'

export const OPERATOR_PAUSE_DOOR = 'p resumes it'

const PAUSE_WORDS_PREFIX = 'paused by '

export function pauseGateWords(by: string | null = null): string {
  return by === null ? OPERATOR_PAUSE_WORDS : `${PAUSE_WORDS_PREFIX}${by}`
}

export function pauseGateModelWords(by: string | null = null): string {
  return `${pauseGateWords(by)} · at a model call — ${OPERATOR_PAUSE_DOOR}`
}

export function pauseGateToolWords(toolName: string, by: string | null = null): string {
  return `${pauseGateWords(by)} · at a tool (${toolName}) — ${OPERATOR_PAUSE_DOOR}`
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
  let by: string | null = null
  const waiters = new Set<Waiter>()
  const listeners = new Set<(state: PauseGateState) => void>()
  let snapshot: PauseGateState = { paused: false, parked: 0, since: null, by: null }

  const emit = (): void => {
    snapshot = { paused: closed, parked: waiters.size, since, by }
    for (const listener of listeners) {
      try {
        listener(snapshot)
      } catch {
        continue
      }
    }
  }

  const pause = (pauser?: string): boolean => {
    if (closed) return false
    closed = true
    since = Date.now()
    by = pauser === undefined || pauser === '' ? null : pauser
    emit()
    return true
  }

  const resume = (): boolean => {
    if (!closed) return false
    closed = false
    since = null
    by = null
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
    pausedBy: () => by,
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

export type PauseGateCarrier = {
  pauseGate?: PauseGate
}

export function closedPauseGateOf(context: PauseGateCarrier): PauseGate | null {
  if (operatorPauseGate.paused()) return operatorPauseGate
  if (context.pauseGate !== undefined && context.pauseGate.paused()) return context.pauseGate
  return null
}

type ParkFrameTask = {
  id: string
  type?: string
  status?: string
  description?: string
  toolUseId?: string
  startTime?: number
  totalTokens?: number
  totalToolCalls?: number
  progress?: { tokenCount?: number; toolUseCount?: number } | null
  agentControllers?: Map<string, unknown>
}

export type ParkFrameCarrier = {
  agentId?: unknown
  getAppState?: () => unknown
}

export function parkFrameTaskOf(context: ParkFrameCarrier): ParkFrameTask | null {
  if (context.agentId === undefined || context.agentId === null || typeof context.getAppState !== 'function') return null
  const agentId = String(context.agentId)
  const state = context.getAppState() as { tasks?: Record<string, ParkFrameTask> } | null | undefined
  const tasks = state?.tasks ?? {}
  const own = tasks[agentId]
  if (own !== undefined) return own.status === 'running' ? own : null
  for (const task of Object.values(tasks)) {
    if (task.type === 'local_workflow' && task.status === 'running' && task.agentControllers?.has(agentId) === true) return task
  }
  return null
}

export function requestParkFrame(context: ParkFrameCarrier): boolean {
  const task = parkFrameTaskOf(context)
  if (task === null) return false
  emitTaskProgress({
    taskId: task.id,
    toolUseId: task.toolUseId,
    description: task.description ?? '',
    startTime: task.startTime ?? Date.now(),
    totalTokens: task.totalTokens ?? task.progress?.tokenCount ?? 0,
    toolUses: task.totalToolCalls ?? task.progress?.toolUseCount ?? 0,
  })
  return true
}

export type ParkContext = PauseGateCarrier &
  ParkFrameCarrier & {
    abortController: { signal: AbortSignal }
    seatHolder?: string
    onSeatWait?: (words: string | null) => void
  }

export async function parkBeforeTool(context: ParkContext, toolName: string): Promise<void> {
  let spoke = false
  for (;;) {
    const gate = closedPauseGateOf(context)
    if (gate === null || context.abortController.signal.aborted) break
    spoke = true
    context.onSeatWait?.(pauseGateToolWords(toolName, gate.pausedBy()))
    requestParkFrame(context)
    await gate.park(context.abortController.signal, pauseGateSeatOf(context))
  }
  if (!spoke) return
  context.onSeatWait?.(null)
  requestParkFrame(context)
}
