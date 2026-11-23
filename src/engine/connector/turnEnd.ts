import { pollUntil, withDeadline } from '../../platform/async/deadline.js'
import { hasSeatLive } from './seatLive.js'
import type { EngineConnectorV1 } from './types.js'

const FALLBACK_POLL_MS = 100

function subscribeTurnActive(connector: EngineConnectorV1, listener: () => void): () => void {
  if (!hasSeatLive(connector)) return () => {}
  let last = connector.turnActive()
  let open = true
  const off = connector.subscribeLive(() => {
    if (!open) return
    const next = connector.turnActive()
    if (next === last) return
    last = next
    listener()
  })
  return () => {
    if (!open) return
    open = false
    off()
  }
}

export async function waitForTurnEnd(
  connector: EngineConnectorV1,
  opts: { limitMs?: number; signal?: AbortSignal } = {},
): Promise<boolean> {
  if (!connector.turnActive()) return true
  const limitMs = opts.limitMs ?? Infinity
  const signal = opts.signal
  if (signal?.aborted || limitMs <= 0) return !connector.turnActive()
  if (!hasSeatLive(connector)) {
    return pollUntil(
      () => (!connector.turnActive() ? true : undefined),
      left => Math.min(FALLBACK_POLL_MS, Math.max(1, left)),
      limitMs,
      () => !connector.turnActive(),
      { signal, onAbort: () => !connector.turnActive() },
    )
  }
  let off: (() => void) | null = null
  try {
    let settle: ((done: boolean) => void) | null = null
    const ended = new Promise<boolean>(resolve => {
      settle = resolve
    })
    off = subscribeTurnActive(connector, () => {
      if (!connector.turnActive()) settle?.(true)
    })
    if (!connector.turnActive()) return true
    return await withDeadline(ended, limitMs, () => !connector.turnActive(), {
      signal,
      onAbort: () => !connector.turnActive(),
    })
  } finally {
    off?.()
  }
}
