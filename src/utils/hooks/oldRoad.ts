import type { AppState } from '../../state/AppState.js'
import type { Message, SystemInformationalMessage } from '../../types/message.js'
import type { Tool, Tools } from '../../Tool.js'
import type { SetAppState } from '../messageQueueManager.js'
import type { HookEntry, HooksSettings } from '../settings/types.js'
import { HookAnswerSchema, type HookAnswer, type HookPayload } from './contract.js'
import { captureHooksSnapshot, hooksDisabled, hooksSnapshot, managedHooksOnly, refreshHooksSnapshot, resetHooksSnapshot } from './hooksConfigSnapshot.js'
import { addSessionHooks } from './sessionHooks.js'

export const HOOK_LIFECYCLE_EVENTS: ReadonlySet<string> = new Set()
export const HookJSONOutputSchema = (): ReturnType<typeof HookAnswerSchema> => HookAnswerSchema()
export type HookJSONOutput = HookAnswer
export type SyncHookJSONOutput = HookAnswer
export type AsyncHookJSONOutput = { async: true; asyncTimeout?: number }
export type HookInput = HookPayload

export type FunctionHookContext = {
  hookInput?: HookPayload
  tool?: Tool
}

export type FunctionHookPass = { pass: true; note: SystemInformationalMessage }

export type FunctionHookCallback = (
  messages: Message[],
  signal?: AbortSignal,
  context?: FunctionHookContext,
) => Promise<boolean | string | FunctionHookPass> | boolean | string | FunctionHookPass

export type FunctionHook = {
  type: 'function'
  id?: string
  timeout?: number
  callback: FunctionHookCallback
  errorMessage: string
  silent?: boolean
}

export type SessionHook = HookEntry | FunctionHook

type FunctionGroup = { matcher: string; hooks: FunctionHook[] }

const functionStore = new Map<string, Map<string, FunctionGroup[]>>()

export function addFunctionHook(
  _setAppState: SetAppState,
  sessionId: string,
  event: string,
  matcher: string,
  callback: FunctionHookCallback,
  errorMessage: string,
  options?: { timeout?: number; silent?: boolean; id?: string },
): string {
  const id = options?.id ?? `function-hook-${Math.random()}`
  const hook: FunctionHook = { type: 'function', id, timeout: options?.timeout || 5000, callback, errorMessage, silent: options?.silent }
  let events = functionStore.get(sessionId)
  if (events === undefined) {
    events = new Map()
    functionStore.set(sessionId, events)
  }
  let groups = events.get(event)
  if (groups === undefined) {
    groups = []
    events.set(event, groups)
  }
  if (options?.id !== undefined) {
    for (const group of groups) group.hooks = group.hooks.filter(h => h.id !== options.id)
  }
  let group = groups.find(g => g.matcher === matcher)
  if (group === undefined) {
    group = { matcher, hooks: [] }
    groups.push(group)
  }
  group.hooks.push(hook)
  return id
}

export function removeFunctionHook(_setAppState: SetAppState, sessionId: string, event: string, hookId: string): void {
  const groups = functionStore.get(sessionId)?.get(event)
  if (groups === undefined) return
  for (const group of groups) group.hooks = group.hooks.filter(h => h.id !== hookId)
}

export function getSessionFunctionHooks(
  _appState: AppState,
  sessionId: string,
  event?: string,
): Map<string, Array<{ matcher: string; hooks: FunctionHook[] }>> {
  const result = new Map<string, Array<{ matcher: string; hooks: FunctionHook[] }>>()
  const events = functionStore.get(sessionId)
  if (events === undefined) return result
  for (const [key, groups] of events) {
    if (event !== undefined && key !== event) continue
    const live = groups.filter(g => g.hooks.length > 0)
    if (live.length > 0) result.set(key, live)
  }
  return result
}

export function clearSessionHooks(setAppState: SetAppState, sessionId: string): void {
  functionStore.delete(sessionId)
  setAppState(prevState => {
    prevState.sessionHooks.delete(sessionId)
    return prevState
  })
}

export function addSessionHook(..._args: unknown[]): void {}

export function getSessionHookCallback(..._args: unknown[]): undefined {
  return undefined
}

export function getSessionHooks(..._args: unknown[]): Map<string, never[]> {
  return new Map()
}

export type OldMatchedHook = { hook: FunctionHook; hookSource?: string }

export function isInternalHook(matched: { hook: { type: string; internal?: boolean } }): boolean {
  return matched.hook.type === 'callback' && matched.hook.internal === true
}

export async function getMatchingHooks(
  appState: AppState | undefined,
  sessionId: string,
  hookEvent: string,
  _hookInput: unknown,
  _tools?: Tools,
): Promise<OldMatchedHook[]> {
  if (appState === undefined) return []
  const groups = getSessionFunctionHooks(appState, sessionId, hookEvent).get(hookEvent) ?? []
  return groups.flatMap(group => group.hooks.map(hook => ({ hook })))
}

export function hasHookForEvent(hookEvent: string, appState: AppState | undefined, sessionId: string): boolean {
  if (appState === undefined) return false
  return (getSessionFunctionHooks(appState, sessionId, hookEvent).get(hookEvent)?.length ?? 0) > 0
}

export function captureHooksConfigSnapshot(): void {
  captureHooksSnapshot()
}

export function updateHooksConfigSnapshot(): void {
  refreshHooksSnapshot()
}

export function resetHooksConfigSnapshot(): void {
  resetHooksSnapshot()
}

export function getHooksConfigFromSnapshot(): HooksSettings | null {
  const map: HooksSettings = {}
  for (const { event, entry } of hooksSnapshot().hooks) (map[event] ??= []).push(entry)
  return map
}

export function shouldAllowManagedHooksOnly(): boolean {
  return managedHooksOnly()
}

export function shouldDisableAllHooksIncludingManaged(): boolean {
  return hooksDisabled()
}

export function getHookDisplayText(hook: { type?: string; name?: string; run?: string; question?: string; crewmate?: string; id?: string; [key: string]: unknown }): string {
  if (typeof hook.name === 'string' && hook.name !== '') return hook.name
  if (typeof hook.run === 'string') return hook.run
  if (typeof hook.question === 'string') return hook.question
  if (typeof hook.crewmate === 'string') return hook.crewmate
  if (typeof hook.id === 'string' && hook.id !== '') return hook.id
  return hook.type ?? 'hook'
}

export function retireOnceHookFromSettings(..._args: unknown[]): null {
  return null
}

export function registerFrontmatterHooks(
  setAppState: SetAppState,
  sessionId: string,
  hooks: HooksSettings,
  sourceName: string,
  isAgent?: boolean,
): void {
  if (isAgent === true) {
    addSessionHooks(setAppState, { sessionId, crewmateId: sessionId }, hooks, { kind: 'agent', type: sourceName.replace(/^agent:/, '') })
    return
  }
  addSessionHooks(setAppState, { sessionId }, hooks, { kind: 'skill', name: sourceName.replace(/^skill:/, ''), root: sourceName })
}
