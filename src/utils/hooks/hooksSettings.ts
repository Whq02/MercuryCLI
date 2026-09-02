import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import type { HookEvent } from 'src/entrypoints/agentSdkTypes.js'
import type { AppState } from '../../state/AppState.js'
import { getSessionId } from '../../bootstrap/state.js'
import type { HookCommand } from '../settings/types.js'
import {
  getRelativeSettingsFilePathForSource,
  getSettingsFilePathForSource,
  getSettingsForSource,
  updateSettingsForSource,
} from '../settings/settings.js'
import { stripBOM } from '../jsonRead.js'
import { DEFAULT_HOOK_SHELL } from '../shell/shellProvider.js'
import { toTildePath } from '../path.js'
import { getSessionHooks, type SessionHook } from './sessionHooks.js'


export type HookSource =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'policySettings'
  | 'extensionHook'
  | 'sessionHook'
  | 'builtinHook'

export type HooksByEventAndMatcher = Record<HookEvent, Record<string, IndividualHookConfig[]>>

export type IndividualHookConfig = {
  event: HookEvent
  config: HookCommand
  matcher?: string
  source: HookSource
  extensionName?: string
}

export function isHookEqual(a: SessionHook, b: SessionHook): boolean {
  if (a.type !== b.type) return false
  const conditionalOf = (hook: SessionHook): string =>
    'if' in hook && typeof hook.if === 'string' ? hook.if : ''
  switch (a.type) {
    case 'command': {
      if (b.type !== 'command') return false
      const shellOf = (hook: typeof a): string => hook.shell ?? DEFAULT_HOOK_SHELL
      return a.command === b.command && shellOf(a) === shellOf(b) && conditionalOf(a) === conditionalOf(b)
    }
    case 'prompt':
      return b.type === 'prompt' && a.prompt === b.prompt && conditionalOf(a) === conditionalOf(b)
    case 'agent':
      return b.type === 'agent' && a.prompt === b.prompt && conditionalOf(a) === conditionalOf(b)
    case 'http':
      return b.type === 'http' && a.url === b.url && conditionalOf(a) === conditionalOf(b)
    default:
      return false
  }
}

export function getHookDisplayText(hook: SessionHook | { type: string; [key: string]: unknown }): string {
  if ('statusMessage' in hook && typeof hook.statusMessage === 'string' && hook.statusMessage.length > 0) {
    return hook.statusMessage
  }
  switch (hook.type) {
    case 'command':
      return (hook as { command: string }).command
    case 'prompt':
    case 'agent':
      return (hook as { prompt: string }).prompt
    case 'http':
      return (hook as { url: string }).url
    case 'callback':
      return 'callback'
    default: {
      const id = 'id' in hook ? hook.id : undefined
      return typeof id === 'string' && id.length > 0 ? id : 'function'
    }
  }
}

const EDITABLE_SOURCES: readonly ['userSettings', 'projectSettings', 'localSettings'] = [
  'userSettings',
  'projectSettings',
  'localSettings',
]

export function retireOnceHookFromSettings(event: HookEvent, fired: HookCommand): HookSource | null {
  const isPlainObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
  for (const source of ['localSettings', 'projectSettings', 'userSettings'] as const) {
    let groups: unknown
    try {
      const path = getSettingsFilePathForSource(source)
      if (path === undefined || !existsSync(path)) continue
      const raw = JSON.parse(stripBOM(readFileSync(path, 'utf-8'))) as unknown
      if (!isPlainObject(raw) || !isPlainObject(raw.hooks)) continue
      groups = raw.hooks[event]
    } catch {
      continue
    }
    if (!Array.isArray(groups)) continue
    for (let g = 0; g < groups.length; g++) {
      const group = groups[g] as unknown
      if (!isPlainObject(group) || !Array.isArray(group.hooks)) continue
      const at = group.hooks.findIndex(
        entry =>
          isPlainObject(entry) &&
          entry.once === true &&
          isHookEqual(entry as never, fired as never),
      )
      if (at === -1) continue
      const keptEntries = group.hooks.filter((_, i) => i !== at)
      const keptGroups = groups
        .map((row, i) => (i === g ? { ...group, hooks: keptEntries } : row))
        .filter(row => !(isPlainObject(row) && Array.isArray(row.hooks) && row.hooks.length === 0))
      const { error } = updateSettingsForSource(source, {
        hooks: { [event]: keptGroups.length > 0 ? keptGroups : undefined },
      } as never)
      return error ? null : source
    }
  }
  return null
}

export function getAllHooks(appState: AppState): IndividualHookConfig[] {
  const rows: IndividualHookConfig[] = []
  const managedOnlyRaw = getSettingsForSource('policySettings')?.allowManagedHooksOnly === true

  if (!managedOnlyRaw) {
    const seenPaths = new Set<string>()
    for (const source of EDITABLE_SOURCES) {
      const filePath = getSettingsFilePathForSource(source)
      if (filePath) {
        const resolved = resolve(filePath)
        if (seenPaths.has(resolved)) continue
        seenPaths.add(resolved)
      }
      const hooks = getSettingsForSource(source)?.hooks
      if (!hooks) continue
      for (const [event, matchers] of Object.entries(hooks) as [HookEvent, Array<{ matcher?: string; hooks: HookCommand[] }>][]) {
        for (const matcherGroup of matchers ?? []) {
          for (const config of matcherGroup.hooks ?? []) {
            rows.push({ event, config, matcher: matcherGroup.matcher, source })
          }
        }
      }
    }
  }

  const sessionHooks = getSessionHooks(appState, getSessionId())
  for (const [event, matchers] of sessionHooks) {
    for (const matcherGroup of matchers) {
      for (const config of matcherGroup.hooks) {
        rows.push({ event, config, matcher: matcherGroup.matcher, source: 'sessionHook' })
      }
    }
  }
  return rows
}

export function getHooksForEvent(appState: AppState, event: HookEvent): IndividualHookConfig[] {
  return getAllHooks(appState).filter(row => row.event === event)
}

export function hookSourceDescriptionDisplayString(source: HookSource): string {
  switch (source) {
    case 'userSettings': {
      const path = getSettingsFilePathForSource('userSettings')
      return `User settings (${path ? toTildePath(path) : 'unavailable'})`
    }
    case 'projectSettings':
      return `Project settings (${getRelativeSettingsFilePathForSource('projectSettings')})`
    case 'localSettings':
      return `Local settings (${getRelativeSettingsFilePathForSource('localSettings')})`
    case 'policySettings':
      return 'Managed policy settings'
    case 'extensionHook':
      return 'Extension hooks (each approved extension\'s mercury-extension.json)'
    case 'sessionHook':
      return 'Session hooks (in-memory, temporary for this session)'
    case 'builtinHook':
      return 'Built-in hooks (registered internally by Mercury)'
  }
}

export function hookSourceHeaderDisplayString(source: HookSource): string {
  switch (source) {
    case 'userSettings':
      return 'User Settings'
    case 'projectSettings':
      return 'Project Settings'
    case 'localSettings':
      return 'Local Settings'
    case 'extensionHook':
      return 'Extension Hooks'
    case 'sessionHook':
      return 'Session Hooks'
    case 'builtinHook':
      return 'Built-in Hooks'
    default:
      return source
  }
}

export function hookSourceInlineDisplayString(source: HookSource): string {
  switch (source) {
    case 'userSettings':
      return 'User'
    case 'projectSettings':
      return 'Project'
    case 'localSettings':
      return 'Local'
    case 'extensionHook':
      return 'Extension'
    case 'sessionHook':
      return 'Session'
    case 'builtinHook':
      return 'Built-in'
    default:
      return source
  }
}

const RULE_SAVE_DISPLAY_ORDER: readonly HookSource[] = ['localSettings', 'projectSettings', 'userSettings']

const PINNED_LAST_PRIORITY = 1000

function rowPriority(row: IndividualHookConfig): number | undefined {
  if (row.source === 'extensionHook' || row.source === 'builtinHook') return PINNED_LAST_PRIORITY
  const index = RULE_SAVE_DISPLAY_ORDER.indexOf(row.source)
  return index === -1 ? undefined : index
}

function matcherPriority(hooks: IndividualHookConfig[]): number {
  return Math.min(...hooks.map(row => rowPriority(row) as number))
}

export function sortMatchersByPriority(
  matchers: string[],
  hooksByEventAndMatcher: HooksByEventAndMatcher,
  event: HookEvent,
): string[] {
  return [...matchers].sort((a, b) => {
    const priorityA = matcherPriority(hooksByEventAndMatcher[event]?.[a] ?? [])
    const priorityB = matcherPriority(hooksByEventAndMatcher[event]?.[b] ?? [])
    if (priorityA !== priorityB) {
      const difference = priorityA - priorityB
      if (Number.isNaN(difference)) return 0
      return difference
    }
    return a.localeCompare(b)
  })
}
