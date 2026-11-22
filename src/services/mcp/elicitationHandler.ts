import type { Client, ElicitResult } from '../../utils/mcp/sdk.js'

import type { AppState } from '../../state/AppState.js'
import { logForDebugging } from '../../utils/debug.js'
import { logMCPDebug, logMCPError } from '../../utils/log.js'
import { urlElicitationVerdict } from '../../utils/mcp/toolPolicy.js'
import { passedOver } from '../../utils/passedOver.js'
import { notBuilt, type Unbuilt } from '../../pi/holes.js'

export type ElicitationRequestEvent = Unbuilt

type SetAppState = (updater: (prev: AppState) => AppState) => void


type ElicitationPhase = 'entered' | 'left'
type ElicitationListener = (phase: ElicitationPhase, question: symbol) => void

const elicitationListeners = new WeakMap<Client, Set<ElicitationListener>>()

function announceElicitation(client: Client, phase: ElicitationPhase, question: symbol): void {
  const listeners = elicitationListeners.get(client)
  if (!listeners) return
  for (const listener of [...listeners]) listener(phase, question)
}

export function watchElicitations(client: Client, listener: ElicitationListener): () => void {
  let listeners = elicitationListeners.get(client)
  if (!listeners) {
    listeners = new Set()
    elicitationListeners.set(client, listeners)
  }
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function enterElicitation(client: Client): () => void {
  const question = Symbol('elicitation')
  announceElicitation(client, 'entered', question)
  let left = false
  return () => {
    if (left) return
    left = true
    announceElicitation(client, 'left', question)
  }
}

export async function withElicitationEntered<T>(client: Client, run: () => Promise<T>): Promise<T> {
  const leave = enterElicitation(client)
  try {
    return await run()
  } finally {
    leave()
  }
}

export type ElicitationPausedClock = {
  now: () => number
  readonly paused: boolean
  release: () => void
}

export function elicitationPausedClock(client: Client, base: () => number = Date.now): ElicitationPausedClock {
  const open = new Set<symbol>()
  let pausedAt: number | null = null
  let pausedTotal = 0
  const unwatch = watchElicitations(client, (phase, question) => {
    if (phase === 'entered') {
      open.add(question)
      if (pausedAt === null) pausedAt = base()
      return
    }
    if (!open.delete(question) || open.size > 0 || pausedAt === null) return
    pausedTotal += base() - pausedAt
    pausedAt = null
  })
  return {
    now: () => (pausedAt ?? base()) - pausedTotal,
    get paused() {
      return pausedAt !== null
    },
    release: unwatch,
  }
}


export function registerElicitationHandler(
  client: Client,
  serverName: string,
  setAppState: SetAppState,
): void {
  return notBuilt('src/services/mcp/elicitationHandler.ts:112')
}
