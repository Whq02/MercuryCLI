/**
 * Applies permission updates to the in-memory context and persists them to
 * settings sources. The context is treated as immutable — each application
 * produces a new value.
 */
import type { ToolPermissionContext } from '../../Tool.js'
import { logForDebugging } from '../debug.js'
import type {
  AdditionalWorkingDirectory,
  PermissionBehavior,
  PermissionRuleValue,
  PermissionUpdate,
  PermissionUpdateDestination,
  WorkingDirectorySource,
} from '../../types/permissions.js'
import { getSettingsForSource, updateSettingsForSource } from '../settings/settings.js'
import type { EditableSettingSource } from '../settings/constants.js'
import { permissionRuleValueFromString, permissionRuleValueToString } from './permissionRuleParser.js'

export type {
  AdditionalWorkingDirectory,
  WorkingDirectorySource,
} from '../../types/permissions.js'

/** The rule-map key a behaviour writes to. */
function ruleMapKey(behavior: PermissionBehavior): 'alwaysAllowRules' | 'alwaysDenyRules' | 'alwaysAskRules' {
  if (behavior === 'allow') return 'alwaysAllowRules'
  if (behavior === 'deny') return 'alwaysDenyRules'
  return 'alwaysAskRules'
}

/** The settings-array key a behaviour writes to. */
function settingsBehaviorKey(behavior: PermissionBehavior): 'allow' | 'deny' | 'ask' {
  if (behavior === 'allow') return 'allow'
  if (behavior === 'deny') return 'deny'
  return 'ask'
}

/** Only the three settings sources are persistable. */
export function supportsPersistence(
  destination: PermissionUpdateDestination,
): destination is EditableSettingSource {
  return (
    destination === 'userSettings' ||
    destination === 'projectSettings' ||
    destination === 'localSettings'
  )
}

type MutableContext = {
  alwaysAllowRules: Record<string, string[]>
  alwaysDenyRules: Record<string, string[]>
  alwaysAskRules: Record<string, string[]>
  additionalWorkingDirectories: Map<string, AdditionalWorkingDirectory>
  mode: ToolPermissionContext['mode']
}

/** Serialize a rule value to its stored string. */
function ruleString(value: PermissionRuleValue): string {
  return permissionRuleValueToString(value)
}

/** Apply one update to the context, returning a new context value. */
export function applyPermissionUpdate(
  context: ToolPermissionContext,
  update: PermissionUpdate,
): ToolPermissionContext {
  const next = structuredCloneContext(context)
  switch (update.type) {
    case 'addRules': {
      const key = ruleMapKey(update.behavior)
      const existing = next[key][update.destination] ?? []
      next[key][update.destination] = [...existing, ...update.rules.map(ruleString)]
      logUpdate('addRules', update.destination, update.behavior, update.rules.map(ruleString))
      break
    }
    case 'replaceRules': {
      const key = ruleMapKey(update.behavior)
      next[key][update.destination] = update.rules.map(ruleString)
      logUpdate('replaceRules', update.destination, update.behavior, update.rules.map(ruleString))
      break
    }
    case 'removeRules': {
      const key = ruleMapKey(update.behavior)
      // In-memory removal compares EXACT serialized strings (no re-normalise).
      const toRemove = new Set(update.rules.map(ruleString))
      const existing = next[key][update.destination] ?? []
      next[key][update.destination] = existing.filter(entry => !toRemove.has(entry))
      logUpdate('removeRules', update.destination, update.behavior, [...toRemove])
      break
    }
    case 'setMode':
      next.mode = update.mode
      logForDebugging(`permission update setMode → ${update.mode} (${update.destination})`)
      break
    case 'addDirectories':
      for (const dir of update.directories) {
        next.additionalWorkingDirectories.set(dir, {
          path: dir,
          source: update.destination as WorkingDirectorySource,
        })
      }
      logDirs('addDirectories', update.destination, update.directories)
      break
    case 'removeDirectories':
      for (const dir of update.directories) next.additionalWorkingDirectories.delete(dir)
      logDirs('removeDirectories', update.destination, update.directories)
      break
    default:
      // An unknown update type is a no-op that returns the context unchanged.
      return context
  }
  return next as unknown as ToolPermissionContext
}

/** Fold a list of updates left to right. */
export function applyPermissionUpdates(
  context: ToolPermissionContext,
  updates: PermissionUpdate[],
): ToolPermissionContext {
  return updates.reduce(applyPermissionUpdate, context)
}

/** The persist verdict: `error` names a settings write that was REFUSED
 *  (a file mid-edit, a refused atomic publish) — the update then applies
 *  for this session only. Null when the write landed or nothing needed
 *  writing (release-hardening audit rank 17: the verdict used to be
 *  discarded, so a "don't ask again" grant vanished on the next launch
 *  with nothing said). */
export type PersistVerdict = { error: Error | null }
const LANDED: PersistVerdict = { error: null }

/** The raw file's own array for a permissions sub-key: string entries kept
 *  VERBATIM (a rule the loader filtered as invalid stays in the file as
 *  its only evidence), non-strings dropped from the rewrite. */
function rawPermissionArray(base: Record<string, unknown>, key: string): string[] {
  const permissions = base.permissions
  if (typeof permissions !== 'object' || permissions === null) return []
  const raw = (permissions as Record<string, unknown>)[key]
  return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : []
}

/** Persist one update to its settings source (skipping session/cliArg
 *  silently). Every ARRAY rewrite is computed from the fresh raw file
 *  inside the settings writer's own locked read-merge-publish
 *  (release-hardening audit rank 41): computing it from the cached view
 *  republished a stale, filtered snapshot wholesale — a peer session's
 *  just-granted rule vanished, a hand-edited rule reverted, and any rule
 *  the loader had filtered as invalid was erased with its only evidence. */
export function persistPermissionUpdate(update: PermissionUpdate): PersistVerdict {
  if (!supportsPersistence(update.destination)) return LANDED
  const source = update.destination

  switch (update.type) {
    case 'addRules': {
      // addRules persistence goes through the loader's oversize-guarded path;
      // here it appends to the behaviour array (deduplicated against the
      // file's own entries).
      const behaviorKey = settingsBehaviorKey(update.behavior)
      const additions = update.rules.map(ruleString)
      return writePartial(source, base => {
        const existing = rawPermissionArray(base, behaviorKey)
        for (const rule of additions) if (!existing.includes(rule)) existing.push(rule)
        return { permissions: { [behaviorKey]: existing } } as never
      })
    }
    case 'replaceRules': {
      const behaviorKey = settingsBehaviorKey(update.behavior)
      return writePartial(source, { permissions: { [behaviorKey]: update.rules.map(ruleString) } })
    }
    case 'removeRules': {
      // Normalise every existing raw entry through parse→serialize before
      // comparing; the write is unconditional.
      const behaviorKey = settingsBehaviorKey(update.behavior)
      const toRemove = new Set(update.rules.map(ruleString))
      return writePartial(source, base => ({
        permissions: {
          [behaviorKey]: rawPermissionArray(base, behaviorKey).filter(entry => {
            try {
              return !toRemove.has(permissionRuleValueToString(permissionRuleValueFromString(entry)))
            } catch {
              return true // an unparseable raw entry is never silently removed
            }
          }),
        },
      }) as never)
    }
    case 'setMode':
      return writePartial(source, { permissions: { defaultMode: update.mode } })
    case 'addDirectories': {
      return writePartial(source, base => {
        const existing = rawPermissionArray(base, 'additionalDirectories')
        for (const dir of update.directories) if (!existing.includes(dir)) existing.push(dir)
        return { permissions: { additionalDirectories: existing } } as never
      })
    }
    case 'removeDirectories': {
      const remove = new Set(update.directories)
      return writePartial(source, base => ({
        permissions: { additionalDirectories: rawPermissionArray(base, 'additionalDirectories').filter(dir => !remove.has(dir)) },
      }) as never)
    }
    default:
      return LANDED
  }
}

/** Persist a list of updates; the verdict carries the FIRST refused write
 *  (every update is still attempted). */
export function persistPermissionUpdates(updates: PermissionUpdate[]): PersistVerdict {
  let first: Error | null = null
  for (const update of updates) {
    const { error } = persistPermissionUpdate(update)
    if (error !== null && first === null) first = error
  }
  return { error: first }
}

/** Extract every rule value from `addRules` updates (others contribute nothing). */
export function extractRules(updates?: PermissionUpdate[]): PermissionRuleValue[] {
  if (!updates) return []
  const rules: PermissionRuleValue[] = []
  for (const update of updates) {
    if (update.type === 'addRules') {
      for (const rule of update.rules) rules.push(rule as PermissionRuleValue)
    }
  }
  return rules
}

/** Whether any update carries rules. */
export function hasRules(updates?: PermissionUpdate[]): boolean {
  return extractRules(updates).length > 0
}

/**
 * A read-rule suggestion for a directory: an addRules allow update on the
 * file-read tool for that subtree. `/` (and a bare drive root) returns no
 * suggestion (too broad).
 *
 * The rule grammar anchors an absolute path with a doubled leading slash;
 * on Windows the ONLY absolute spelling the matcher anchors at a drive is
 * `//<letter>/rest` (filesystem.ts rootForPattern). A drive-letter path was
 * written as `C:/proj/**`, which the matcher read as a RELATIVE pattern —
 * the product's own "allow this directory" grant never matched anything,
 * and every path-scoped allow/deny/ask an operator wrote by hand in that
 * spelling was inert (TASK-014 w4-f10-01).
 */
export function createReadRuleSuggestion(
  dirPath: string,
  destination: PermissionUpdateDestination = 'session',
): PermissionUpdate | undefined {
  const posix = dirPath.replace(/\\/g, '/')
  if (posix === '/') return undefined
  const drive = /^([A-Za-z]):\/(.*)$/.exec(posix)
  let anchored: string
  if (drive) {
    const rest = (drive[2] as string).replace(/\/+$/, '')
    if (rest === '') return undefined
    anchored = `//${(drive[1] as string).toUpperCase()}/${rest}`
  } else {
    // Absolute paths get an extra leading slash (the root-anchored form).
    anchored = posix.startsWith('/') ? `/${posix}` : posix
  }
  const content = `${anchored}/**`
  return {
    type: 'addRules',
    // The literal Read tool name is contract data (persisted into settings).
    rules: [{ toolName: 'Read', ruleContent: content }],
    behavior: 'allow',
    destination,
  } as PermissionUpdate
}

/**
 * The write-side sibling of createReadRuleSuggestion: an edit-family allow
 * rule anchored on one directory. The Bash card's "allow access to <dir>"
 * option used to bundle setMode(implement) — one keystroke aimed at one
 * directory turned off the ask for every write in the cwd for the session,
 * unnamed on the card (FC-022). One Edit rule grants exactly what the label
 * names: the family matcher applies it to every edit-type path check
 * (Edit · Write · NotebookEdit), scoped to the directory.
 */
export function createEditRuleSuggestion(
  dirPath: string,
  destination: PermissionUpdateDestination = 'session',
): PermissionUpdate | undefined {
  const posix = dirPath.replace(/\\/g, '/')
  if (posix === '/') return undefined
  const drive = /^([A-Za-z]):\/(.*)$/.exec(posix)
  let anchored: string
  if (drive) {
    const rest = (drive[2] as string).replace(/\/+$/, '')
    if (rest === '') return undefined
    anchored = `//${(drive[1] as string).toUpperCase()}/${rest}`
  } else {
    // Absolute paths get an extra leading slash (the root-anchored form).
    anchored = posix.startsWith('/') ? `/${posix}` : posix
  }
  return {
    type: 'addRules',
    rules: [{ toolName: 'Edit', ruleContent: `${anchored}/**` }],
    behavior: 'allow',
    destination,
  } as PermissionUpdate
}

// ── internals ────────────────────────────────────────────────────────────────

function structuredCloneContext(context: ToolPermissionContext): MutableContext {
  const c = context as unknown as MutableContext
  return {
    ...(context as object),
    alwaysAllowRules: cloneRuleMap(c.alwaysAllowRules),
    alwaysDenyRules: cloneRuleMap(c.alwaysDenyRules),
    alwaysAskRules: cloneRuleMap(c.alwaysAskRules),
    additionalWorkingDirectories: new Map(c.additionalWorkingDirectories),
    mode: c.mode,
  } as MutableContext
}

function cloneRuleMap(map: Record<string, string[]> | undefined): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [key, value] of Object.entries(map ?? {})) out[key] = [...value]
  return out
}

function writePartial(
  source: EditableSettingSource,
  partial: Record<string, unknown> | ((rawBase: Record<string, unknown>) => Record<string, unknown>),
): PersistVerdict {
  // The settings updater deep-merges, replacing arrays wholesale and leaving
  // every other key untouched — that is what makes "overwrite this one array"
  // the observable effect. An updater partial computes the array from the
  // fresh raw file inside the writer's locked round.
  const verdict = updateSettingsForSource(source, partial as never)
  if (verdict.error !== null) {
    // The one owner says so: the rule is live for this session and gone on
    // the next launch unless the file is repaired.
    logForDebugging(
      `permission update not saved to ${source}: ${verdict.error.message} — it applies for this session only`,
      { level: 'error' },
    )
  }
  return verdict
}

function logUpdate(
  type: string,
  destination: string,
  behavior: string,
  rules: string[],
): void {
  logForDebugging(
    `permission update ${type} · ${destination} · ${behavior} · ${rules.length} rule(s): ${rules.join(', ')}`,
  )
}

function logDirs(type: string, destination: string, dirs: string[]): void {
  const noun = dirs.length === 1 ? 'directory' : 'directories'
  logForDebugging(`permission update ${type} · ${destination} · ${dirs.length} ${noun}: ${dirs.join(', ')}`)
}
