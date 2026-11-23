import type { AppState } from '../../../state/AppState.js'

export type UrlElicitation = { mode: 'url'; url: string; elicitationId: string; message: string }

export function parseUrlElicitations(error: unknown): UrlElicitation[] {
  if (!error || typeof error !== 'object') return []
  const data = (error as { data?: unknown }).data
  if (!data || typeof data !== 'object') return []
  const raw = (data as { elicitations?: unknown }).elicitations
  if (!Array.isArray(raw)) return []
  const out: UrlElicitation[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const rec = item as Record<string, unknown>
    if (
      rec.mode === 'url' &&
      typeof rec.url === 'string' &&
      typeof rec.elicitationId === 'string' &&
      typeof rec.message === 'string'
    ) {
      out.push({
        mode: 'url',
        url: rec.url,
        elicitationId: rec.elicitationId,
        message: rec.message,
      })
    }
  }
  return out
}

export function queueUrlElicitation(
  serverName: string,
  elicitation: UrlElicitation,
  signal: AbortSignal,
  setAppState: (updater: (prev: AppState) => AppState) => void,
): Promise<'accept' | 'decline' | 'cancel'> {
  if (signal.aborted) return Promise.resolve('cancel')
  return new Promise<'accept' | 'decline' | 'cancel'>(resolve => {
    let settled = false
    const finish = (outcome: 'accept' | 'decline' | 'cancel'): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(outcome)
    }
    const event: AppState['elicitation']['queue'][number] = {
      serverName,
      params: {
        mode: 'url',
        message: elicitation.message,
        url: elicitation.url,
        elicitationId: elicitation.elicitationId,
      },
      signal,
      waitingState: {
        actionLabel: 'Retry tool call',
        showCancel: true,
      },
      respond: (result: { action: 'accept' | 'decline' | 'cancel' }) => {
        if (result.action === 'accept') return
        finish(result.action)
      },
      onWaitingDismiss: (action: 'cancel' | 'retry' | 'dismiss') => {
        finish(action === 'cancel' ? 'cancel' : 'accept')
      },
    }
    const onAbort = (): void => {
      setAppState(prev => ({
        ...prev,
        elicitation: {
          queue: prev.elicitation.queue.filter(entry => entry !== event),
        },
      }))
      finish('cancel')
    }
    signal.addEventListener('abort', onAbort, { once: true })
    setAppState(prev => ({
      ...prev,
      elicitation: {
        queue: [...prev.elicitation.queue, event],
      },
    }))
  })
}
