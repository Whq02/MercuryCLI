import { HOOK_EVENTS } from '../../entrypoints/sdk/coreTypes.js'
import { logForDebugging } from '../debug.js'


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

export function clearHookEventState(): void {
  handler = null
  queued = []
  allHookEventsEnabled = false
}
