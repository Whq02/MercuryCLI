import type { DapSession } from '../dapClient.js'
import { sleep } from '../../../platform/async/sleep.js'
import { DapCancelledError, dapDeadline, waitForDap } from '../dapCancellation.js'
import type { StoppedInfo } from './shared.js'

export async function waitForStopOutcome(
  session: DapSession,
  stateWaiters: Set<() => void>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  sinceStamp: number,
): Promise<
  | { state: 'stopped'; info: StoppedInfo; session: DapSession }
  | { state: 'terminated' }
  | { state: 'timeout' }
  | { state: 'aborted' }
> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (signal?.aborted) return { state: 'aborted' }
    const stopped = session.treeStopped(sinceStamp)
    if (stopped?.lastStopped) {
      return { state: 'stopped', info: stopped.lastStopped, session: stopped }
    }
    if (session.treeTerminated()) return { state: 'terminated' }
    if (Date.now() >= deadline) return { state: 'timeout' }
    const woke = await new Promise<'event' | 'timeout' | 'aborted'>(resolve => {
      const cancelDeadline = dapDeadline(() => {
        cleanup()
        resolve('timeout')
      }, Math.max(0, deadline - Date.now()))
      const wake = (): void => {
        cleanup()
        resolve('event')
      }
      const onAbort = (): void => {
        cleanup()
        resolve('aborted')
      }
      const cleanup = (): void => {
        cancelDeadline()
        stateWaiters.delete(wake)
        signal?.removeEventListener('abort', onAbort)
      }
      stateWaiters.add(wake)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
    if (woke === 'timeout') return { state: 'timeout' }
    if (woke === 'aborted') return { state: 'aborted' }
  }
}

export async function waitForStop(session: DapSession, timeoutMs: number, signal: AbortSignal | undefined): Promise<StoppedInfo | null> {
  const outcome = await session.waitForStopOutcome(timeoutMs, signal)
  if (outcome.state === 'aborted') throw new DapCancelledError()
  return outcome.state === 'stopped' ? outcome.info : null
}

export async function drainOutput(session: DapSession, quietMs: number, maxMs: number, signal: AbortSignal | undefined): Promise<void> {
  const start = Date.now()
  let lastLen = session.output.length
  let lastChange = Date.now()
  for (;;) {
    if (Date.now() - start >= maxMs) break
    await waitForDap(sleep(50), signal)
    if (session.output.length !== lastLen) {
      lastLen = session.output.length
      lastChange = Date.now()
    } else if (Date.now() - lastChange >= quietMs) {
      break
    }
  }
  session.flushPartialOutput()
}
