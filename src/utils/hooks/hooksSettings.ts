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

/**
 * Hook identity/equality, enumeration across sources, source display
 * strings, and the matcher priority sort for the hooks UI.
 */

/** Contract data for the settings/extension boundary. */
export type HookSource =
  | 'userSettings'
  | 'projectSettings'
  | 'localSettings'
  | 'policySettings'
  | 'extensionHook'
  | 'sessionHook'
  | 'builtinHook'

/** The hooks UI grouping: plain objects (event → matcher → rows); EVERY
 *  hook event is present as a key (empty object when it has no hooks). */
export type HooksByEventAndMatcher = Record<HookEvent, Record<string, IndividualHookConfig[]>>

export type IndividualHookConfig = {
  event: HookEvent
  config: HookCommand
  /** The group's matcher as declared (absent stays absent — no '' coercion). */
  matcher?: string
  source: HookSource
  extensionName?: string
}

/**
 * Equality compares content, never timeout. The `if` guard is part of
 * identity (an absent one equals the empty string): the same command
 * guarded by two different conditions is two distinct hooks.
 * Function hooks are never equal — they carry no stable comparable
 * identifier.
 */
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

/** The custom status message when declared, else the hook's content or a fixed word. */
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
      // A function hook with a registration id names itself in the
      // verbose/transcript hook rows ("goal-…", "structured-output-…")
      // instead of the opaque literal.
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

/**
 * The once:true retirement (FC-108). The hooks schema and the bundled
 * update-config skill both promise a one-shot hook is REMOVED after its
 * run, but nothing ever consumed the field — the entry fired on every
 * matching event forever and its settings file was never touched. After
 * the engine settles a once hook's run it calls here: the entry is
 * deleted from the FIRST editable source whose file carries it
 * (most-local first), exactly one entry per call.
 *
 * The write base is the RAW file, never the parsed view (the settings
 * write law): kept sibling entries are copied from the file's own JSON so
 * their unknown keys survive the event array's replacement. Matching is
 * isHookEqual's content identity PLUS the once flag itself — an identical
 * twin entry not marked once is never touched. Matcher grouping is not
 * part of entry identity; an emptied group is pruned, and an emptied
 * event key is dropped from the file.
 */
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
      continue // unreadable file: never a place this helper edits
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

/**
 * One entry per individual hook across the editable sources plus the
 * current session.
 *
 * The gate here is the RAW policy managed-only flag, deliberately not the
 * derived predicate: when non-managed settings disable all hooks, execution
 * is managed-only while this enumeration still lists the user/project/local
 * hooks. Routing this through the derived predicate silently empties the
 * hooks UI for that configuration.
 *
 * Sources are de-duplicated by resolved settings-file path (running from a
 * home directory can make two sources resolve to the same file); a source's
 * path is recorded as seen before its hooks are examined, so a source with
 * no hooks still consumes its path.
 */
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

  // The session id is read from bootstrap state, not passed in. Function
  // hooks are excluded (they cannot be represented in the settings shape).
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
      // Sources without an explicit case (policySettings) fall through to
      // the raw source token.
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
      // Sources without an explicit case (policySettings) fall through to
      // the raw source token.
      return source
  }
}

// The rule-save DISPLAY order — local, then project, then user (index 0
// highest) — which is the REVERSE of canonical settings precedence. This is
// a separate, deliberately-ordered constant; substituting the precedence
// order inverts the hooks UI.
const RULE_SAVE_DISPLAY_ORDER: readonly HookSource[] = ['localSettings', 'projectSettings', 'userSettings']

const PINNED_LAST_PRIORITY = 1000

/**
 * The priority key of one hook row: the three-name display list gives an
 * index; extensionHook/builtinHook map to the pinned-last sentinel; any other
 * source (sessionHook, policySettings, …) contributes NO usable priority —
 * an undefined key, so the arithmetic below degenerates to NaN and the sort
 * leaves such matchers in place (a session-hook-only matcher never sorts
 * first).
 */
function rowPriority(row: IndividualHookConfig): number | undefined {
  if (row.source === 'extensionHook' || row.source === 'builtinHook') return PINNED_LAST_PRIORITY
  const index = RULE_SAVE_DISPLAY_ORDER.indexOf(row.source)
  return index === -1 ? undefined : index
}

function matcherPriority(hooks: IndividualHookConfig[]): number {
  // Math.min over the mapped keys: an undefined key coerces to NaN (the
  // degenerate comparison the original had); no hooks ⇒ Infinity.
  return Math.min(...hooks.map(row => rowPriority(row) as number))
}

/**
 * Order matchers by the highest-priority source contributing any hook under
 * each; ties break alphabetically by locale comparison. Sources outside the
 * three-entry list have no priority number and their comparison degenerates
 * (the sort leaves them in place); a matcher with no hooks compares as an
 * empty set.
 */
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
      // NaN (a source with no priority) leaves the pair in place.
      if (Number.isNaN(difference)) return 0
      return difference
    }
    return a.localeCompare(b)
  })
}
