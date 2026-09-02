/**
 * MCP elicitation: the `elicitation/create` request handler, the
 * URL-elicitation completion notification handler, elicitation hooks, and
 * the consent-event queue into app state.
 *
 * The URL phishing gate (SEP-1036) sits OUTSIDE the handler's error guard:
 * a fault in the risk-policy consultation propagates to the protocol layer
 * instead of silently degrading into a cancel — preserve that boundary.
 * The explicit consent card never auto-opens a browser.
 */
import type { Client } from './sdk.js'
import {
  ElicitationCompleteNotificationSchema,
  ElicitRequestSchema,
  type ElicitResult,
} from './sdk.js'

import type { AppState } from '../../state/AppState.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  executeElicitationHooks,
  executeElicitationResultHooks,
  executeNotificationHooks,
} from '../../utils/hooks.js'
import { logMCPDebug, logMCPError } from '../../utils/log.js'
import { urlElicitationVerdict } from './toolPolicy.js'

// ---------------------------------------------------------------------------
// Event shapes (contract data — field names are read by the app-state slice,
// the REPL and the elicitation dialog)
// ---------------------------------------------------------------------------

export type ElicitationWaitingState = {
  actionLabel: string
  showCancel?: boolean
}

type ElicitationParams = {
  message?: string
  mode?: string
  url?: string
  elicitationId?: string
  requestedSchema?: Record<string, unknown>
  [key: string]: unknown
}

export type ElicitationRequestEvent = {
  serverName: string
  requestId: string | number
  params: ElicitationParams
  signal: AbortSignal
  respond: (result: ElicitResult) => void
  waitingState?: ElicitationWaitingState
  onWaitingDismiss?: (action: 'dismiss' | 'retry' | 'cancel') => void
  completed?: boolean
  riskPosture?: string
}

type SetAppState = (updater: (prev: AppState) => AppState) => void

// ---------------------------------------------------------------------------
// Hook wrappers
// ---------------------------------------------------------------------------

/**
 * Run elicitation hooks for a request. A blocking hook error yields a
 * decline-shaped response; a hook-supplied response is returned as-is;
 * otherwise undefined ("no hook response" — the consent card proceeds).
 * An exception from the hook machinery itself is logged at MCP-error level
 * and treated as no response, so a broken hook cannot block the card.
 */
export async function runElicitationHooks(
  serverName: string,
  params: ElicitationParams,
  signal: AbortSignal,
): Promise<ElicitResult | undefined> {
  try {
    const mode: 'form' | 'url' = params.mode === 'url' ? 'url' : 'form'
    const { elicitationResponse, blockingError } = await executeElicitationHooks({
      serverName,
      message: params.message ?? '',
      requestedSchema: params.requestedSchema,
      signal,
      mode,
      url: params.url,
      elicitationId: params.elicitationId,
    })
    if (blockingError) return { action: 'decline' }
    if (elicitationResponse) {
      logForDebugging(
        `elicitation hooks responded for "${serverName}": ${JSON.stringify(elicitationResponse)}`,
      )
      return elicitationResponse as ElicitResult
    }
    return undefined
  } catch (error) {
    logMCPError(serverName, `elicitation hooks failed: ${String(error)}`)
    return undefined
  }
}

/**
 * Run elicitation-result hooks over a settled result.
 *
 * A blocking hook error forces the decline action (with an observability
 * notification); a hook response overrides action (and content, falling back
 * to the original content when the hook supplied none); a machinery failure
 * returns the original result unchanged. A notification of type
 * `elicitation_response` is always emitted.
 */
export async function runElicitationResultHooks(
  serverName: string,
  result: ElicitResult,
  signal: AbortSignal,
  mode?: 'form' | 'url',
  elicitationId?: string,
): Promise<ElicitResult> {
  const notify = (action: string): void => {
    void executeNotificationHooks({
      message: `MCP server "${serverName}" elicitation resolved: ${action}`,
      notificationType: 'elicitation_response',
    }).catch(() => {})
  }
  try {
    const { elicitationResultResponse, blockingError } = await executeElicitationResultHooks({
      serverName,
      action: result.action,
      content: result.content,
      signal,
      mode,
      elicitationId,
    })
    if (blockingError) {
      void executeNotificationHooks({
        message: `MCP server "${serverName}" elicitation declined by a hook`,
        notificationType: 'elicitation_response',
      }).catch(() => {})
      return { action: 'decline' }
    }
    const final: ElicitResult = elicitationResultResponse
      ? ({
          action: elicitationResultResponse.action,
          content: elicitationResultResponse.content ?? result.content,
        } as ElicitResult)
      : result
    notify(final.action)
    return final
  } catch (error) {
    logMCPError(serverName, `elicitation result hooks failed: ${String(error)}`)
    notify(result.action)
    return result
  }
}

// ---------------------------------------------------------------------------
// Handler registration
// ---------------------------------------------------------------------------

/**
 * Register the `elicitation/create` request handler and the URL-elicitation
 * completion notification handler on a connected client. A client created
 * without the elicitation capability throws at registration — swallowed, so
 * such a client simply ends up with nothing registered. Never throws.
 */
export function registerElicitationHandler(
  client: Client,
  serverName: string,
  setAppState: SetAppState,
): void {
  try {
    client.setRequestHandler(ElicitRequestSchema, async (request, extra) => {
      // Step 1 (outside the guard): log the whole serialised request.
      logMCPDebug(serverName, `elicitation request: ${JSON.stringify(request)}`)
      const params = (request.params ?? {}) as ElicitationParams
      const isUrlMode = params.mode === 'url'

      // Step 2 (outside the guard): the URL phishing gate. A fault in the
      // policy consultation propagates to the protocol layer by design.
      let riskPosture: string | undefined
      if (isUrlMode) {
        const verdict = urlElicitationVerdict(serverName)
        riskPosture = verdict.posture
        if (verdict.refuse) {
          logMCPDebug(
            serverName,
            `URL elicitation auto-declined by risk policy (${verdict.posture})`,
          )
          void executeNotificationHooks({
            message: `MCP server "${serverName}" asked to open a URL; refused by risk policy (${verdict.posture})`,
            notificationType: 'elicitation_response',
          }).catch(() => {})
          return { action: 'decline' } satisfies ElicitResult
        }
      }

      // Steps 3–6 under the guard.
      try {
        const hookResponse = await runElicitationHooks(serverName, params, extra.signal)
        if (hookResponse !== undefined) return hookResponse

        const response = await new Promise<ElicitResult>(resolvePromise => {
          if (extra.signal.aborted) {
            resolvePromise({ action: 'cancel' })
            return
          }
          const onAbort = (): void => {
            resolvePromise({ action: 'cancel' })
          }
          extra.signal.addEventListener('abort', onAbort, { once: true })
          const event: ElicitationRequestEvent = {
            serverName,
            requestId: extra.requestId as string | number,
            params,
            signal: extra.signal,
            respond: result => {
              extra.signal.removeEventListener('abort', onAbort)
              resolvePromise(result)
            },
            ...(isUrlMode && params.elicitationId !== undefined
              ? { waitingState: { actionLabel: 'Skip confirmation' } }
              : {}),
            ...(riskPosture !== undefined ? { riskPosture } : {}),
          }
          setAppState(prev => {
            const queue = prev.elicitation?.queue ?? []
            return {
              ...prev,
              elicitation: { ...(prev.elicitation ?? {}), queue: [...queue, event] },
            } as AppState
          })
        })

        logForDebugging(
          `elicitation response for "${serverName}": ${JSON.stringify(response)}`,
        )
        return await runElicitationResultHooks(
          serverName,
          response,
          extra.signal,
          isUrlMode ? 'url' : 'form',
          params.elicitationId,
        )
      } catch (error) {
        logMCPError(serverName, `elicitation handling failed: ${String(error)}`)
        return { action: 'cancel' } satisfies ElicitResult
      }
    })

    client.setNotificationHandler(ElicitationCompleteNotificationSchema, notification => {
      const elicitationId = (notification.params as { elicitationId?: string } | undefined)
        ?.elicitationId
      logForDebugging(
        `elicitation complete from "${serverName}": ${JSON.stringify(notification.params)}`,
      )
      void executeNotificationHooks({
        message: `MCP server "${serverName}" confirmed elicitation ${elicitationId ?? '(unknown)'} complete`,
        notificationType: 'elicitation_complete',
      }).catch(() => {})
      setAppState(prev => {
        const queue = prev.elicitation?.queue ?? []
        const index = queue.findIndex(
          (event: ElicitationRequestEvent) =>
            event.serverName === serverName &&
            event.params?.mode === 'url' &&
            event.params?.elicitationId === elicitationId,
        )
        if (index === -1) {
          logForDebugging(
            `elicitation completion for unknown elicitation ${elicitationId ?? '(unknown)'} ignored`,
          )
          return prev
        }
        const updated = [...queue]
        updated[index] = { ...(queue[index] as ElicitationRequestEvent), completed: true }
        return {
          ...prev,
          elicitation: { ...(prev.elicitation ?? {}), queue: updated },
        } as AppState
      })
    })
  } catch {
    // The client was created without the elicitation capability — nothing is
    // registered, silently.
  }
}
