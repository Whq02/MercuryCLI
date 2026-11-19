

export type UrlElicitation = { mode: 'url'; url: string; elicitationId: string; message: string }

export function parseUrlElicitations(error: unknown): UrlElicitation[] {
  const data = (error as { data?: { elicitations?: unknown[] } } | null)?.data
  const raw = Array.isArray(data?.elicitations) ? data.elicitations : []
  return raw.filter((entry): entry is UrlElicitation => {
    const record = entry as Record<string, unknown> | null
    return (
      record !== null &&
      record.mode === 'url' &&
      typeof record.url === 'string' &&
      typeof record.elicitationId === 'string' &&
      typeof record.message === 'string'
    )
  })
}

export function queueUrlElicitation(
  serverName: string,
  elicitation: UrlElicitation,
  signal: AbortSignal,
  setAppState: (updater: (prev: unknown) => unknown) => void,
): Promise<'accept' | 'decline' | 'cancel'> {
  if (signal.aborted) return Promise.resolve('cancel')
  return new Promise(resolve => {
    let settled = false
    const finish = (answer: 'accept' | 'decline' | 'cancel'): void => {
      if (settled) return
      settled = true
      signal.removeEventListener('abort', onAbort)
      resolve(answer)
    }
    const onAbort = (): void => finish('cancel')
    signal.addEventListener('abort', onAbort, { once: true })
    const event = {
      serverName,
      requestId: elicitation.elicitationId,
      elicitationId: elicitation.elicitationId,
      params: { mode: 'url', url: elicitation.url, message: elicitation.message },
      signal,
      respond: (response: { action?: string }) => {
        if (response.action === 'accept') return
        finish(response.action === 'decline' ? 'decline' : 'cancel')
      },
      waitingState: { actionLabel: 'Open the URL, then return here', showCancel: true },
      onWaitingDismiss: (action: 'dismiss' | 'retry' | 'cancel') => finish(action === 'retry' ? 'accept' : 'cancel'),
    }
    setAppState(prev => {
      const state = prev as { elicitation?: { queue?: unknown[] } }
      const queue = state.elicitation?.queue ?? []
      return { ...state, elicitation: { ...(state.elicitation ?? {}), queue: [...queue, event] } }
    })
  })
}
