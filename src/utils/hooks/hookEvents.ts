import { HOOK_EVENTS } from '../../entrypoints/sdk/coreTypes.js'
import { logForDebugging } from '../debug.js'

/**
 * In-process broadcast bus for hook start/progress/response events. One
 * handler slot; events queue (bounded) while no handler is registered and
 * flush in order on registration.
 */

export type HookStartedEvent = {
  type: 'started'
  hookId: string
  hookName: string
  hookEvent: string
}

export type HookProgressEvent = {
  type: 'progress'
  hookId: string
  hookName: string
  hookEvent: string
  stdout: string
  stderr: string
  output: string
}

export type HookResponseEvent = {
  type: 'response'
  hookId: string
  hookName: string
  hookEvent: string
  output: string
  stdout: string
  stderr: string
  exitCode?: number
  outcome: 'success' | 'error' | 'cancelled'
}

export type HookExecutionEvent = HookStartedEvent | HookProgressEvent | HookResponseEvent

export type HookEventHandler = (event: HookExecutionEvent) => void

const QUEUE_CAP = 100

let handler: HookEventHandler | null = null
let queued: HookExecutionEvent[] = []
let allHookEventsEnabled = false

const recognisedEvents: ReadonlySet<string> = new Set<string>(HOOK_EVENTS)

// SessionStart and Setup are low-noise lifecycle events that were in the
// original allowlist and must stay backwards compatible; everything else
// requires the all-events switch AND a recognised hook event name.
function shouldEmit(hookEvent: string): boolean {
  if (hookEvent === 'SessionStart' || hookEvent === 'Setup') return true
  return allHookEventsEnabled && recognisedEvents.has(hookEvent)
}

function deliver(event: HookExecutionEvent): void {
  if (handler) {
    handler(event)
    return
  }
  if (queued.length >= QUEUE_CAP) queued.shift()
  queued.push(event)
}

/** Registering flushes anything queued while there was no handler, in order. */
export function registerHookEventHandler(newHandler: HookEventHandler | null): void {
  handler = newHandler
  if (!newHandler) return
  const backlog = queued
  queued = []
  for (const event of backlog) newHandler(event)
}

export function setAllHookEventsEnabled(enabled: boolean): void {
  allHookEventsEnabled = enabled
}

export function emitHookStarted(hookId: string, hookName: string, hookEvent: string): void {
  if (!shouldEmit(hookEvent)) return
  deliver({ type: 'started', hookId, hookName, hookEvent })
}

export function emitHookProgress(params: {
  hookId: string
  hookName: string
  hookEvent: string
  stdout: string
  stderr: string
  output: string
}): void {
  if (!shouldEmit(params.hookEvent)) return
  deliver({ type: 'progress', ...params })
}

/**
 * Response emission always logs, even when the event is gated out, so
 * verbose debugging sees every hook's full output.
 */
export function emitHookResponse(params: {
  hookId: string
  hookName: string
  hookEvent: string
  output: string
  stdout: string
  stderr: string
  exitCode?: number
  outcome: 'success' | 'error' | 'cancelled'
}): void {
  // On an ERROR the promise names stderr — the old stdout-first pick
  // printed the hook's stdout where the browser's sentence says stderr
  // (FC-083); success keeps stdout first (its content channel).
  const logged =
    params.outcome === 'error'
      ? params.stderr || params.stdout || params.output
      : params.stdout || params.stderr || params.output
  if (logged) {
    logForDebugging(`hook ${params.hookName} (${params.hookEvent}) ${params.outcome}: ${logged}`)
  }
  if (!shouldEmit(params.hookEvent)) return
  deliver({ type: 'response', ...params })
}

/**
 * Poll an output getter and emit a progress event only when the combined
 * output changed. Gated out ⇒ no work at all and a no-op stopper. The
 * interval must not keep the process alive.
 */
type HookOutputSnapshot = { stdout: string; stderr: string; output: string }

export function startHookProgressInterval(params: {
  hookId: string
  hookName: string
  hookEvent: string
  getOutput: () => HookOutputSnapshot | Promise<HookOutputSnapshot>
  intervalMs?: number
}): () => void {
  if (!shouldEmit(params.hookEvent)) return () => {}
  let lastOutput = ''
  const timer = setInterval(() => {
    void Promise.resolve(params.getOutput()).then(({ stdout, stderr, output }) => {
      if (output === lastOutput) return
      lastOutput = output
      emitHookProgress({
        hookId: params.hookId,
        hookName: params.hookName,
        hookEvent: params.hookEvent,
        stdout,
        stderr,
        output,
      })
    })
  }, params.intervalMs ?? 1000)
  timer.unref?.()
  return () => clearInterval(timer)
}

/** Clears the handler, the queue, and the switch. */
export function clearHookEventState(): void {
  handler = null
  queued = []
  allHookEventsEnabled = false
}
