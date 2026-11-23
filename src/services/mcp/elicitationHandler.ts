import type { Client, ElicitResult } from '../../utils/mcp/sdk.js'

import type { AppState } from '../../state/AppState.js'
import { logForDebugging } from '../../utils/debug.js'
import { logMCPDebug, logMCPError } from '../../utils/log.js'
import { urlElicitationVerdict } from '../../utils/mcp/toolPolicy.js'
import { passedOver } from '../../utils/passedOver.js'

export type ElicitationRequestEvent = {
  serverName: string
  requestId?: string | number
  elicitationId?: string
  params: {
    message?: string
    mode?: 'form' | 'url'
    requestedSchema?: {
      type?: 'object'
      properties?: Record<string, unknown>
      required?: string[]
    }
    url?: string
    elicitationId?: string
  }
  signal: AbortSignal
  respond: (response: ElicitResult) => void
  onWaitingDismiss?: (action: 'cancel' | 'retry' | 'dismiss') => void
  waitingState?: {
    showCancel?: boolean
    actionLabel?: string
  }
  completed?: boolean
  riskPosture?: string
}

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
  try {
    client.setRequestHandler('elicitation/create', async (request, ctx): Promise<ElicitResult> => {
      return withElicitationEntered(client, async () => {
        try {
          logMCPDebug(serverName, `elicitation request: ${JSON.stringify(request)}`)
          const params: ElicitationRequestEvent['params'] = request.params ?? {}
          const isUrlMode = params.mode === 'url'
          let riskPosture: string | undefined

          if (isUrlMode) {
            const verdict = urlElicitationVerdict(serverName)
            if (verdict.refuse) {
              logMCPDebug(serverName, `URL elicitation auto-declined by risk policy (${verdict.posture})`)
              return { action: 'decline' }
            }
            if (verdict.posture) {
              riskPosture = verdict.posture
            }
          }

          const signal = ctx.mcpReq.signal
          if (signal.aborted) {
            return { action: 'cancel' }
          }

          const result = await new Promise<ElicitResult>(resolve => {
            let settled = false
            const onAbort = () => {
              if (settled) return
              settled = true
              signal.removeEventListener('abort', onAbort)
              resolve({ action: 'cancel' })
            }
            const respond = (response: ElicitResult) => {
              if (settled) return
              settled = true
              signal.removeEventListener('abort', onAbort)
              resolve(response)
            }
            signal.addEventListener('abort', onAbort, { once: true })

            const event: ElicitationRequestEvent = {
              serverName,
              requestId: ctx.mcpReq.id,
              params,
              signal,
              respond,
              ...(isUrlMode && params.elicitationId !== undefined
                ? { waitingState: { actionLabel: 'Skip confirmation' } }
                : {}),
              ...(riskPosture !== undefined ? { riskPosture } : {}),
            }

            setAppState(prev => ({
              ...prev,
              elicitation: {
                ...prev.elicitation,
                queue: [...prev.elicitation.queue, event],
              },
            }))
          })

          logForDebugging(`elicitation response for "${serverName}": ${JSON.stringify(result)}`)
          return result
        } catch (error) {
          logMCPError(serverName, `elicitation handling failed: ${String(error)}`)
          return { action: 'cancel' }
        }
      })
    })
  } catch (error) {
    passedOver(error)
  }

  try {
    client.setNotificationHandler('notifications/elicitation/complete', notification => {
      logForDebugging(`elicitation complete from "${serverName}": ${JSON.stringify(notification.params)}`)
      const given = notification.params?.elicitationId
      const elicitationId = typeof given === 'string' ? given : undefined
      setAppState(prev => {
        const queue = prev.elicitation.queue
        const index =
          elicitationId === undefined
            ? -1
            : queue.findIndex(
                event =>
                  event.serverName === serverName &&
                  event.params.mode === 'url' &&
                  event.params.elicitationId === elicitationId,
              )
        if (index === -1) {
          logForDebugging(`elicitation completion for unknown elicitation ${elicitationId ?? '(unknown)'} ignored`)
          return prev
        }
        const nextQueue = [...queue]
        nextQueue[index] = { ...queue[index]!, completed: true }
        return {
          ...prev,
          elicitation: {
            ...prev.elicitation,
            queue: nextQueue,
          },
        }
      })
    })
  } catch (error) {
    passedOver(error)
  }
}
