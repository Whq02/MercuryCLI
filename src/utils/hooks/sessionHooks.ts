import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { HookEvent, HookInput } from 'src/entrypoints/agentSdkTypes.js'
import type { AppState } from '../../state/AppState.js'
import type { Message } from '../../types/message.js'
import type { HookCommand } from '../settings/types.js'
import type { SetAppState } from '../messageQueueManager.js'
import { logForDebugging } from '../debug.js'
import { isHookEqual } from './hooksSettings.js'
import type { AggregatedHookResult } from './types.js'

/**
 * The in-memory, session-scoped hook registry. Ephemeral and never
 * persisted to settings.
 *
 * Container choice is behavioural: the registry is a mutable map and every
 * mutator mutates in place, returning the SAME state object so the store's
 * identity check skips listener notification. Under concurrent workflows,
 * many agents registering hooks in one synchronous tick would otherwise
 * each pay a copy of a growing structure and each fire every listener;
 * session hooks are only sampled from state snapshots in the query loop,
 * never read reactively, so skipping notification is correct.
 */

export type FunctionHookContext = {
  /** The raw event payload — for tool-use events it carries the pending tool name/input. */
  hookInput?: HookInput
}

/**
 * True passes; false blocks with the registration-time error message; a
 * STRING blocks with that string as the re-prompt, so one hook can teach a
 * different, specific lesson per violation.
 */
export type FunctionHookCallback = (
  messages: Message[],
  signal?: AbortSignal,
  context?: FunctionHookContext,
) => Promise<boolean | string> | boolean | string

export type FunctionHook = {
  type: 'function'
  id?: string
  /** Milliseconds (unlike settings hooks' seconds). */
  timeout?: number
  callback: FunctionHookCallback
  /** The blocking re-prompt when the callback returns false. */
  errorMessage: string
  /**
   * The blocking re-prompt is delivered to the model but suppressed from
   * the front-end transcript — for keep-working stop hooks that must nudge
   * without visible churn.
   */
  silent?: boolean
}

export type SessionHook = HookCommand | FunctionHook

type SessionHookEntry = {
  hook: SessionHook
  onHookSuccess?: (hook: SessionHook, result: AggregatedHookResult) => void
}

type SessionHookGroup = {
  matcher: string
  skillRoot?: string
  hooks: SessionHookEntry[]
}

/** One session's registry: hooks grouped per event by matcher. */
export type SessionStore = {
  hooks: Partial<Record<HookEvent, SessionHookGroup[]>>
}

/** The store field on app state: session id → that session's registry. */
export type SessionHooksState = Map<string, SessionStore>

/** The settings-shaped projection handed to the matcher. */
export type SessionDerivedHookMatcher = {
  matcher: string
  hooks: HookCommand[]
  skillRoot?: string
}

function ensureSession(state: AppState, sessionId: string): SessionStore {
  let entry = state.sessionHooks.get(sessionId)
  if (!entry) {
    entry = { hooks: {} }
    state.sessionHooks.set(sessionId, entry)
  }
  return entry
}

function ensureGroup(
  session: SessionStore,
  event: HookEvent,
  matcher: string,
  skillRoot: string | undefined,
): SessionHookGroup {
  const groups = (session.hooks[event] ??= [])
  let group = groups.find(g => g.matcher === matcher && g.skillRoot === skillRoot)
  if (!group) {
    group = { matcher, ...(skillRoot !== undefined ? { skillRoot } : {}), hooks: [] }
    groups.push(group)
  }
  return group
}

/** Remove a function-hook id from every matcher group for an event, dropping emptied groups. */
function removeFunctionHookInPlace(session: SessionStore, event: HookEvent, hookId: string): void {
  const groups = session.hooks[event]
  if (!groups) return
  for (const group of groups) {
    group.hooks = group.hooks.filter(entry => !(entry.hook.type === 'function' && entry.hook.id === hookId))
  }
  const surviving = groups.filter(group => group.hooks.length > 0)
  if (surviving.length !== groups.length) session.hooks[event] = surviving
}

export function addSessionHook(
  setAppState: SetAppState,
  sessionId: string,
  event: HookEvent,
  matcher: string,
  hook: HookCommand,
  onHookSuccess?: (hook: SessionHook, result: AggregatedHookResult) => void,
  skillRoot?: string,
): void {
  setAppState(prevState => {
    const session = ensureSession(prevState, sessionId)
    const group = ensureGroup(session, event, matcher, skillRoot)
    group.hooks.push({ hook, ...(onHookSuccess ? { onHookSuccess } : {}) })
    logForDebugging(`session hook added: ${event} (session ${sessionId})`)
    return prevState
  })
}

/**
 * Register a session function hook, returning its id. An EXPLICIT id makes
 * re-registration an idempotent replace (every existing function hook with
 * that id is removed from every matcher group for the event first, emptied
 * groups dropped) — the structured-output enforcement hook re-registers
 * every turn. An auto-generated id never de-duplicates.
 */
export function addFunctionHook(
  setAppState: SetAppState,
  sessionId: string,
  event: HookEvent,
  matcher: string,
  callback: FunctionHookCallback,
  errorMessage: string,
  options?: { timeout?: number; silent?: boolean; id?: string },
): string {
  const id = options?.id ?? `function-hook-${Math.random()}`
  const hook: FunctionHook = {
    type: 'function',
    id,
    // `||` on purpose: a declared timeout of 0 still takes the default.
    timeout: options?.timeout || 5000,
    callback,
    errorMessage,
    silent: options?.silent,
  }
  setAppState(prevState => {
    const session = ensureSession(prevState, sessionId)
    if (options?.id !== undefined) removeFunctionHookInPlace(session, event, options.id)
    const group = ensureGroup(session, event, matcher, undefined)
    group.hooks.push({ hook })
    logForDebugging(`session function hook added: ${event} (session ${sessionId})`)
    return prevState
  })
  return id
}

export function removeFunctionHook(
  setAppState: SetAppState,
  sessionId: string,
  event: HookEvent,
  hookId: string,
): void {
  setAppState(prevState => {
    const session = prevState.sessionHooks.get(sessionId)
    if (!session) return prevState
    removeFunctionHookInPlace(session, event, hookId)
    if ((session.hooks[event]?.length ?? 0) === 0) delete session.hooks[event]
    logForDebugging(`session function hook removed: ${event} (session ${sessionId})`)
    return prevState
  })
}

/** Remove a settings-shaped session hook by content equality. */
export function removeSessionHook(
  setAppState: SetAppState,
  sessionId: string,
  event: HookEvent,
  hook: HookCommand,
): void {
  setAppState(prevState => {
    const session = prevState.sessionHooks.get(sessionId)
    if (!session) return prevState
    const groups = session.hooks[event]
    if (!groups) return prevState
    for (const group of groups) {
      group.hooks = group.hooks.filter(entry => entry.hook.type === 'function' || !isHookEqual(entry.hook, hook))
    }
    const surviving = groups.filter(group => group.hooks.length > 0)
    session.hooks[event] = surviving
    if (surviving.length === 0) delete session.hooks[event]
    logForDebugging(`session hook removed: ${event} (session ${sessionId})`)
    return prevState
  })
}

/**
 * Unregister every hook a skill's frontmatter declared once the skill left
 * the table (FN-015 rank 62): a skill-rooted group whose root is not in
 * `liveSkillRoots` leaves the session, across every event; groups without
 * a skill root (the runner's own function hooks, the settings-shaped
 * session hooks) are never touched. Returns the roots removed. Before this
 * door existed the registration was for good — a blocking PreToolUse hook
 * from a removed skill kept refusing tool calls, a command hook kept
 * spawning a shell per matching call, and only ending the session cleared
 * it.
 */
export function pruneSkillSessionHooks(
  setAppState: SetAppState,
  sessionId: string,
  liveSkillRoots: ReadonlySet<string>,
): string[] {
  const removed = new Set<string>()
  setAppState(prevState => {
    const session = prevState.sessionHooks.get(sessionId)
    if (!session) return prevState
    for (const event of Object.keys(session.hooks) as HookEvent[]) {
      const groups = session.hooks[event]
      if (!groups) continue
      const surviving = groups.filter(group => {
        if (group.skillRoot === undefined || liveSkillRoots.has(group.skillRoot)) return true
        removed.add(group.skillRoot)
        return false
      })
      if (surviving.length === groups.length) continue
      if (surviving.length === 0) delete session.hooks[event]
      else session.hooks[event] = surviving
    }
    if (removed.size > 0) {
      logForDebugging(`session hooks of ${removed.size} de-applied skill(s) removed (session ${sessionId}): ${[...removed].join(', ')}`)
    }
    return prevState
  })
  return [...removed]
}

/** The skill roots a fresh command table still carries — the live set the
 *  prune door is handed after every rescan or dial. */
export function liveSkillRootsOf(commands: ReadonlyArray<{ name: string; skillRoot?: string }>): Set<string> {
  const roots = new Set<string>()
  for (const command of commands) if (command.skillRoot !== undefined) roots.add(command.skillRoot)
  return roots
}

/** A skill-rooted group is live only while its SKILL.md still exists: the
 *  file-removal road is honoured at READ time, before any watcher prunes
 *  the registry (FN-015 rank 62). Groups without a root are always live. */
function isGroupLive(group: SessionHookGroup): boolean {
  return group.skillRoot === undefined || existsSync(join(group.skillRoot, 'SKILL.md'))
}

function eventsOf(session: SessionStore, event: HookEvent | undefined): HookEvent[] {
  if (event !== undefined) return [event]
  return Object.keys(session.hooks) as HookEvent[]
}

/**
 * Settings-shaped session hooks projected into plain matcher records
 * (skill root preserved); function hooks are filtered out because they
 * cannot be represented in that shape.
 */
export function getSessionHooks(
  appState: AppState,
  sessionId: string,
  event?: HookEvent,
): Map<HookEvent, SessionDerivedHookMatcher[]> {
  const result = new Map<HookEvent, SessionDerivedHookMatcher[]>()
  const session = appState.sessionHooks.get(sessionId)
  if (!session) return result
  for (const key of eventsOf(session, event)) {
    const groups = session.hooks[key]
    if (!groups) continue
    result.set(
      key,
      groups.filter(isGroupLive).map(group => ({
        matcher: group.matcher,
        ...(group.skillRoot !== undefined ? { skillRoot: group.skillRoot } : {}),
        hooks: group.hooks.map(entry => entry.hook).filter((hook): hook is HookCommand => hook.type !== 'function'),
      })),
    )
  }
  return result
}

/** Function hooks only; groups with none are omitted entirely. */
export function getSessionFunctionHooks(
  appState: AppState,
  sessionId: string,
  event?: HookEvent,
): Map<HookEvent, Array<{ matcher: string; hooks: FunctionHook[]; skillRoot?: string }>> {
  const result = new Map<HookEvent, Array<{ matcher: string; hooks: FunctionHook[]; skillRoot?: string }>>()
  const session = appState.sessionHooks.get(sessionId)
  if (!session) return result
  for (const key of eventsOf(session, event)) {
    const groups = session.hooks[key]
    if (!groups) continue
    const projected = groups
      .filter(isGroupLive)
      .map(group => ({
        matcher: group.matcher,
        ...(group.skillRoot !== undefined ? { skillRoot: group.skillRoot } : {}),
        hooks: group.hooks
          .map(entry => entry.hook)
          .filter((hook): hook is FunctionHook => hook.type === 'function'),
      }))
      .filter(group => group.hooks.length > 0)
    if (projected.length > 0) result.set(key, projected)
  }
  return result
}

/**
 * The full stored entry (including the success callback) for an
 * event/matcher/hook triple. An empty requested matcher is a wildcard
 * across groups; the hook is found by content equality.
 */
export function getSessionHookCallback(
  appState: AppState,
  sessionId: string,
  event: HookEvent,
  matcher: string,
  hook: SessionHook,
): SessionHookEntry | undefined {
  const groups = appState.sessionHooks.get(sessionId)?.hooks[event]
  if (!groups) return undefined
  for (const group of groups) {
    if (matcher !== '' && group.matcher !== matcher) continue
    for (const entry of group.hooks) {
      if (entry.hook.type === 'function' || hook.type === 'function') continue
      if (isHookEqual(entry.hook, hook)) return entry
    }
  }
  return undefined
}

export function clearSessionHooks(setAppState: SetAppState, sessionId: string): void {
  setAppState(prevState => {
    prevState.sessionHooks.delete(sessionId)
    return prevState
  })
}
