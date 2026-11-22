import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { AppState } from '../../state/AppState.js'
import type { SetAppState } from '../messageQueueManager.js'
import type { HooksSettings } from '../settings/types.js'
import { logForDebugging } from '../debug.js'
import { HOOK_EVENTS, type HookEvent } from './contract.js'
import type { HookSource, LayeredHook } from './hooksConfigSnapshot.js'
import { notBuilt } from '../../pi/holes.js'

export type HookScope = { sessionId: string; crewmateId?: string; cwd?: string }

function hookScopeKey(scope: HookScope): string {
  return scope.crewmateId ?? scope.sessionId
}

type SessionHookSource = Extract<HookSource, { kind: 'skill' | 'agent' }>

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
  return notBuilt('src/utils/hooks/sessionHooks.ts:43')
}

export function removeSessionHooks(setAppState: SetAppState, scope: HookScope, source?: SessionHookSource): void {
  return notBuilt('src/utils/hooks/sessionHooks.ts:65')
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
  return notBuilt('src/utils/hooks/sessionHooks.ts:95')
}

export function liveSkillRootsOf(commands: ReadonlyArray<{ name: string; skillRoot?: string }>): Set<string> {
  const roots = new Set<string>()
  for (const command of commands) if (command.skillRoot !== undefined) roots.add(command.skillRoot)
  return roots
}
