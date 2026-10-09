import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AppState } from '../../state/AppState.js'
import type { SetAppState } from '../messageQueueManager.js'
import type { HooksSettings } from '../settings/types.js'
import { logForDebugging } from '../debug.js'
import { HOOK_EVENTS, type HookEvent } from './contract.js'
import type { HookSource, LayeredHook } from './hooksConfigSnapshot.js'

export type HookScope = { sessionId: string; crewmateId?: string; cwd?: string }

export function hookScopeKey(scope: HookScope): string {
  return scope.crewmateId ?? scope.sessionId
}

export type SessionHookSource = Extract<HookSource, { kind: 'skill' | 'agent' }>

type SessionHookSet = { source: SessionHookSource; hooks: LayeredHook[] }

type SessionStore = { sets: SessionHookSet[] }

export type SessionHooksState = Map<string, SessionStore>

function ensureStore(state: AppState, key: string): SessionStore {
  let store = state.sessionHooks.get(key)
  if (store === undefined) {
    store = { sets: [] }
    state.sessionHooks.set(key, store)
  }
  return store
}

function sourceLabel(source: SessionHookSource): string {
  return source.kind === 'skill' ? `skill:${source.name}` : `agent:${source.type}`
}

function sameSource(a: SessionHookSource, b: SessionHookSource): boolean {
  if (a.kind === 'skill' && b.kind === 'skill') return a.root === b.root
  if (a.kind === 'agent' && b.kind === 'agent') return a.type === b.type
  return false
}

export function addSessionHooks(
  setAppState: SetAppState,
  scope: HookScope,
  map: HooksSettings,
  source: SessionHookSource,
): number {
  const hooks: LayeredHook[] = []
  for (const event of HOOK_EVENTS) {
    for (const entry of map[event] ?? []) hooks.push({ event, entry, source })
  }
  if (hooks.length === 0) return 0
  const key = hookScopeKey(scope)
  setAppState(prevState => {
    const store = ensureStore(prevState, key)
    store.sets = store.sets.filter(set => !sameSource(set.source, source))
    store.sets.push({ source, hooks })
    logForDebugging(`session hooks added: ${hooks.length} from ${sourceLabel(source)} (${key})`)
    return prevState
  })
  return hooks.length
}

export function removeSessionHooks(setAppState: SetAppState, scope: HookScope, source?: SessionHookSource): void {
  const key = hookScopeKey(scope)
  setAppState(prevState => {
    if (source === undefined) {
      prevState.sessionHooks.delete(key)
      return prevState
    }
    const store = prevState.sessionHooks.get(key)
    if (store === undefined) return prevState
    store.sets = store.sets.filter(set => !sameSource(set.source, source))
    if (store.sets.length === 0) prevState.sessionHooks.delete(key)
    return prevState
  })
}

function setIsLive(set: SessionHookSet): boolean {
  return set.source.kind !== 'skill' || existsSync(join(set.source.root, 'SKILL.md'))
}

export function sessionHooksFor(appState: AppState, scope: HookScope, event?: HookEvent): LayeredHook[] {
  const store = appState.sessionHooks.get(hookScopeKey(scope))
  if (store === undefined) return []
  const out: LayeredHook[] = []
  for (const set of store.sets) {
    if (!setIsLive(set)) continue
    for (const hook of set.hooks) if (event === undefined || hook.event === event) out.push(hook)
  }
  return out
}

export function pruneSkillSessionHooks(setAppState: SetAppState, sessionId: string, liveSkillRoots: ReadonlySet<string>): string[] {
  const removed = new Set<string>()
  setAppState(prevState => {
    const store = prevState.sessionHooks.get(sessionId)
    if (store === undefined) return prevState
    store.sets = store.sets.filter(set => {
      if (set.source.kind !== 'skill' || liveSkillRoots.has(set.source.root)) return true
      removed.add(set.source.root)
      return false
    })
    if (store.sets.length === 0) prevState.sessionHooks.delete(sessionId)
    if (removed.size > 0) {
      logForDebugging(`session hooks of ${removed.size} de-applied skill(s) removed (${sessionId}): ${[...removed].join(', ')}`)
    }
    return prevState
  })
  return [...removed]
}

export function liveSkillRootsOf(commands: ReadonlyArray<{ name: string; skillRoot?: string }>): Set<string> {
  const roots = new Set<string>()
  for (const command of commands) if (command.skillRoot !== undefined) roots.add(command.skillRoot)
  return roots
}
