const holds = new Map<string, Promise<void>>()

export function holdToolsUntil(agentId: string, ready: Promise<unknown>): void {
  const settled = ready.then(
    () => undefined,
    () => undefined,
  )
  holds.set(agentId, settled)
  void settled.then(() => {
    if (holds.get(agentId) === settled) holds.delete(agentId)
  })
}

export function releaseToolHold(agentId: string): void {
  holds.delete(agentId)
}

export function heldAgentCount(): number {
  return holds.size
}

export function worktreeHoldOf(context: { agentId?: unknown; abortController: { signal: AbortSignal } }): Promise<void> | undefined {
  if (context.agentId === undefined || context.agentId === null) return undefined
  const held = holds.get(String(context.agentId))
  if (held === undefined) return undefined
  const signal = context.abortController.signal
  if (signal.aborted) return undefined
  return new Promise<void>(resolve => {
    const done = (): void => {
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
    void held.then(done)
  })
}
