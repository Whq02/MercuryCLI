import { AsyncLocalStorage } from 'node:async_hooks'
import { HOOK_EVENTS } from './contract.js'

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
const observers = new Set<HookEventHandler>()

export function subscribeHookExecutionEvents(observer: HookEventHandler): () => void {
  observers.add(observer)
  for (const event of queued) observer(event)
  return () => { observers.delete(observer) }
}

export type HookRunContext = {
  sessionId?: string
  cwd?: string
  trustAccepted?: boolean
  handler?: HookEventHandler
}

const runContext = new AsyncLocalStorage<HookRunContext>()

export function getHookRunContext(): HookRunContext | undefined {
  return runContext.getStore()
}

export async function* withHookRunContext<T>(
  context: HookRunContext,
  source: AsyncGenerator<T>,
): AsyncGenerator<T> {
  const scope = { ...runContext.getStore(), ...context }
  try {
    for (;;) {
      const item = await runContext.run(scope, () => source.next())
      if (item.done) return
      yield item.value
    }
  } finally {
    await runContext.run(scope, () => source.return(undefined as never))
  }
}

const recognisedEvents: ReadonlySet<string> = new Set<string>(HOOK_EVENTS)

function shouldEmit(hookEvent: string): boolean {
  if (hookEvent === 'SessionStart' || hookEvent === 'Setup') return true
  return allHookEventsEnabled && recognisedEvents.has(hookEvent)
}

function deliver(event: HookExecutionEvent): void {
  if (recognisedEvents.has(event.hookEvent)) {
    getHookRunContext()?.handler?.(event)
    for (const observer of observers) observer(event)
  }
  if (!shouldEmit(event.hookEvent)) return
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

export function takeHookEventHandler(): HookEventHandler | null {
  return handler
}


export function emitHookStarted(hookId: string, hookName: string, hookEvent: string): void {
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
  deliver({ type: 'response', ...params })
}

type HookOutputSnapshot = { stdout: string; stderr: string; output: string }

export function hookProgressReporter(params: {
  hookId: string
  hookName: string
  hookEvent: string
}): (snapshot: HookOutputSnapshot) => void {
  let lastOutput = ''
  return ({ stdout, stderr, output }) => {
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
  }
}

export function startHookProgressInterval(params: {
  hookId: string
  hookName: string
  hookEvent: string
  getOutput: () => HookOutputSnapshot | Promise<HookOutputSnapshot>
  intervalMs?: number
}): () => void {
  void params
  return () => {}
}
