import { AsyncLocalStorage } from 'node:async_hooks'
import { logForDebugging } from '../debug.js'

type HookStartedEvent = { type: 'started'; hookId: string; hookName: string; hookEvent: string }

type HookProgressEvent = { type: 'progress'; hookId: string; hookName: string; hookEvent: string; stdout: string; stderr: string; output: string }

type HookResponseEvent = {
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

type HookEventHandler = (event: HookExecutionEvent) => void

const HOOK_PROGRESS_MIN_DELTA_BYTES = 8192

const observers = new Set<HookEventHandler>()
const HELD_EVENTS_MAX = 256
const held: HookExecutionEvent[] = []

export function subscribeHookExecutionEvents(observer: HookEventHandler): () => void {
  observers.add(observer)
  for (const event of held.splice(0)) observer(event)
  return () => {
    observers.delete(observer)
  }
}

type HookRunContext = {
  sessionId?: string
  cwd?: string
  transcriptPath?: string
  handler?: HookEventHandler
}

const runContext = new AsyncLocalStorage<HookRunContext>()

export function getHookRunContext(): HookRunContext | undefined {
  return runContext.getStore()
}

export function withHookRunContext<T>(context: HookRunContext, run: () => Promise<T>): Promise<T> {
  return runContext.run({ ...runContext.getStore(), ...context }, run)
}

function deliver(event: HookExecutionEvent): void {
  const handler = getHookRunContext()?.handler
  handler?.(event)
  if (observers.size === 0) {
    if (handler !== undefined || event.hookEvent !== 'session.start') return
    held.push(event)
    if (held.length > HELD_EVENTS_MAX) held.splice(0, held.length - HELD_EVENTS_MAX)
    return
  }
  for (const observer of observers) observer(event)
}

export function emitHookStarted(hookId: string, hookName: string, hookEvent: string): void {
  deliver({ type: 'started', hookId, hookName, hookEvent })
}

function hookOutputForDebugLog(output: string): string {
  if (output.length <= 5_000) return output
  const totalBytes = Buffer.byteLength(output, 'utf8')
  return `${output.slice(0, 4_000)}\n[${totalBytes} bytes total]\n${output.slice(-1_000)}`
}

export function emitHookResponse(params: Omit<HookResponseEvent, 'type'>): void {
  const logged = params.outcome === 'error' ? params.stderr || params.stdout || params.output : params.stdout || params.stderr || params.output
  if (logged) logForDebugging(`hook ${params.hookName} (${params.hookEvent}) ${params.outcome}: ${hookOutputForDebugLog(logged)}`)
  deliver({ type: 'response', ...params })
}

type HookOutputSnapshot = { stdout: string; stderr: string; output: string }

export function hookProgressReporter(params: { hookId: string; hookName: string; hookEvent: string }): (snapshot: HookOutputSnapshot) => void {
  let lastOutput = ''
  let pendingDelta = ''
  return ({ output }) => {
    if (output === lastOutput) return
    if (output.length < lastOutput.length || !output.startsWith(lastOutput)) {
      lastOutput = output
      pendingDelta = ''
      return
    }
    pendingDelta += output.slice(lastOutput.length)
    lastOutput = output
    if (pendingDelta.length < HOOK_PROGRESS_MIN_DELTA_BYTES) return
    const delta = pendingDelta
    pendingDelta = ''
    deliver({ type: 'progress', hookId: params.hookId, hookName: params.hookName, hookEvent: params.hookEvent, stdout: delta, stderr: '', output: delta })
  }
}
