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

function ruleMapKey(behavior: PermissionBehavior): 'alwaysAllowRules' | 'alwaysDenyRules' | 'alwaysAskRules' {
  if (behavior === 'allow') return 'alwaysAllowRules'
  if (behavior === 'deny') return 'alwaysDenyRules'
  return 'alwaysAskRules'
}

function settingsBehaviorKey(behavior: PermissionBehavior): 'allow' | 'deny' | 'ask' {
  if (behavior === 'allow') return 'allow'
  if (behavior === 'deny') return 'deny'
  return 'ask'
}

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

function ruleString(value: PermissionRuleValue): string {
  return permissionRuleValueToString(value)
}

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
      return context
  }
  return next as unknown as ToolPermissionContext
}

export function applyPermissionUpdates(
  context: ToolPermissionContext,
  updates: PermissionUpdate[],
): ToolPermissionContext {
  return updates.reduce(applyPermissionUpdate, context)
}

export type PersistVerdict = { error: Error | null }
const LANDED: PersistVerdict = { error: null }

function rawPermissionArray(base: Record<string, unknown>, key: string): string[] {
  const permissions = base.permissions
  if (typeof permissions !== 'object' || permissions === null) return []
  const raw = (permissions as Record<string, unknown>)[key]
  return Array.isArray(raw) ? raw.filter((entry): entry is string => typeof entry === 'string') : []
}

export function persistPermissionUpdate(update: PermissionUpdate): PersistVerdict {
  if (!supportsPersistence(update.destination)) return LANDED
  const source = update.destination

  switch (update.type) {
    case 'addRules': {
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
      const behaviorKey = settingsBehaviorKey(update.behavior)
      const toRemove = new Set(update.rules.map(ruleString))
      return writePartial(source, base => ({
        permissions: {
          [behaviorKey]: rawPermissionArray(base, behaviorKey).filter(entry => {
            try {
              return !toRemove.has(permissionRuleValueToString(permissionRuleValueFromString(entry)))
            } catch {
              return true
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

export function persistPermissionUpdates(updates: PermissionUpdate[]): PersistVerdict {
  let first: Error | null = null
  for (const update of updates) {
    const { error } = persistPermissionUpdate(update)
    if (error !== null && first === null) first = error
  }
  return { error: first }
}

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

export function hasRules(updates?: PermissionUpdate[]): boolean {
  return extractRules(updates).length > 0
}

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
    anchored = posix.startsWith('/') ? `/${posix}` : posix
  }
  const content = `${anchored}/**`
  return {
    type: 'addRules',
    rules: [{ toolName: 'Read', ruleContent: content }],
    behavior: 'allow',
    destination,
  } as PermissionUpdate
}

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
    anchored = posix.startsWith('/') ? `/${posix}` : posix
  }
  return {
    type: 'addRules',
    rules: [{ toolName: 'Edit', ruleContent: `${anchored}/**` }],
    behavior: 'allow',
    destination,
  } as PermissionUpdate
}


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
  const verdict = updateSettingsForSource(source, partial as never)
  if (verdict.error !== null) {
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
