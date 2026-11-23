import { clearRegisteredHooks } from '../../boot/process-state/processState.js'
import { isPathTrusted, untrustedWorkspaceHeadless } from '../../platform/settings/config.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { resolveProjectConfigPath } from '../../platform/settings/projectConfig.js'
import { getLaunchSettingSources, isCheckoutSourceHeldForTrust, type SettingSource } from '../../platform/settings/settingSources.js'
import { getSettingsFilePathForSource, getSettingsForSource, loadManagedFileSettings, parseSettingsFile } from '../../platform/settings/settings.js'
import { resetSettingsCache } from '../../platform/settings/settingsCache.js'
import { isRestrictedToExtensionsOnly } from '../../platform/settings/extensionOnlyPolicy.js'
import type { HookEntry, HooksSettings } from '../../platform/settings/settingsSchema.js'
import { HOOK_EVENTS, type HookEvent } from './contract.js'

export const HOOK_LAYERS = ['user', 'project', 'local', 'flag', 'managed'] as const
export type HookLayer = (typeof HOOK_LAYERS)[number]

const LAYER_OF_SOURCE: Readonly<Record<SettingSource, HookLayer>> = {
  userSettings: 'user',
  projectSettings: 'project',
  localSettings: 'local',
  flagSettings: 'flag',
  policySettings: 'managed',
}

export type HookSource =
  | { kind: 'settings'; layer: HookLayer }
  | { kind: 'extension'; name: string; id: string; root: string }
  | { kind: 'skill'; name: string; root: string }
  | { kind: 'agent'; type: string }

export type LayeredHook = { event: HookEvent; entry: HookEntry; source: HookSource }

const CHECKOUT_LAYERS: ReadonlySet<HookLayer> = new Set(['project', 'local'])

function entriesOf(map: HooksSettings | undefined, layer: HookLayer): LayeredHook[] {
  if (map === undefined) return []
  const out: LayeredHook[] = []
  for (const event of HOOK_EVENTS) {
    for (const entry of map[event] ?? []) out.push({ event, entry, source: { kind: 'settings', layer } })
  }
  return out
}

export type HookSettingsReadError = { path: string; error: string }

function readErrorOf(errors: ReadonlyArray<{ file?: string; path: string; message: string }>, fallbackPath: string): HookSettingsReadError | undefined {
  const first = errors.find(e => e.path === '') ?? errors[0]
  if (first === undefined) return undefined
  return {
    path: first.file ?? fallbackPath,
    error: first.message.replace(/^settings file unreadable:\s*/, ''),
  }
}

function readLayers(): Array<{ layer: HookLayer; map: HooksSettings | undefined; disabled: boolean; managedOnly: boolean; readError?: HookSettingsReadError }> {
  return getLaunchSettingSources().map(source => {
    const settings = getSettingsForSource(source)
    const events = settings?.events
    const held = isCheckoutSourceHeldForTrust(source)
    let readError: HookSettingsReadError | undefined
    if (settings === null) {
      if (source === 'policySettings') {
        readError = readErrorOf(loadManagedFileSettings().errors, getSettingsFilePathForSource(source) ?? 'managed-settings.json')
      } else {
        const filePath = getSettingsFilePathForSource(source)
        if (filePath !== undefined) readError = readErrorOf(parseSettingsFile(filePath).errors, filePath)
      }
    }
    return {
      layer: LAYER_OF_SOURCE[source],
      map: events?.hooks,
      disabled: events?.disabled === true && !held,
      managedOnly: events?.managedOnly === true && !held,
      ...(readError !== undefined ? { readError } : {}),
    }
  })
}

type HooksSnapshot = {
  hooks: LayeredHook[]
  disabled: boolean
  managedOnly: boolean
  extensionsOnly: boolean
  untrustedCheckout: boolean
  skippedForTrust: number
  unreadErrors: HookSettingsReadError[]
  workspaceUnread: Record<string, HookSettingsReadError[]>
}

function computeSnapshot(): HooksSnapshot {
  const layers = readLayers()
  const managed = layers.find(l => l.layer === 'managed')
  const disabledByManaged = managed?.disabled === true
  const managedOnly = managed?.managedOnly === true
  const disabledBelow = layers.some(l => l.layer !== 'managed' && l.disabled)
  const extensionsOnly = isRestrictedToExtensionsOnly('hooks')
  const untrustedCheckout = untrustedWorkspaceHeadless()
  if (disabledByManaged) return { hooks: [], disabled: true, managedOnly: false, extensionsOnly, untrustedCheckout, skippedForTrust: 0, unreadErrors: [], workspaceUnread: {} }
  const keepOnlyManaged = managedOnly || disabledBelow || extensionsOnly
  if (untrustedCheckout && !keepOnlyManaged) {
    logForDebugging('hooks: untrusted workspace on a non-interactive road — checkout hooks are not loaded (boot interactively once here to trust this directory)')
  }
  const hooks: LayeredHook[] = []
  const unreadErrors: HookSettingsReadError[] = []
  let skippedForTrust = 0
  for (const { layer, map, readError } of layers) {
    if (keepOnlyManaged && layer !== 'managed') continue
    if (untrustedCheckout && CHECKOUT_LAYERS.has(layer)) {
      skippedForTrust += entriesOf(map, layer).length
      continue
    }
    if (readError !== undefined && !unreadErrors.some(e => e.path === readError.path)) {
      unreadErrors.push(readError)
    }
    hooks.push(...entriesOf(map, layer))
  }
  return { hooks, disabled: false, managedOnly: keepOnlyManaged, extensionsOnly, untrustedCheckout, skippedForTrust, unreadErrors, workspaceUnread: {} }
}

let snapshot: HooksSnapshot | undefined

export function captureHooksSnapshot(): void {
  snapshot = computeSnapshot()
}

export function refreshHooksSnapshot(): void {
  resetSettingsCache()
  captureHooksSnapshot()
}

export function hooksSnapshot(): HooksSnapshot {
  if (snapshot === undefined) captureHooksSnapshot()
  return snapshot as HooksSnapshot
}

export function settingsHooksFor(event: HookEvent, cwd?: string): LayeredHook[] {
  if (cwd !== undefined) return workspaceHooks(cwd).filter(hook => hook.event === event)
  return hooksSnapshot().hooks.filter(hook => hook.event === event)
}

const WORKSPACE_FILES: ReadonlyArray<{ layer: HookLayer; file: string }> = [
  { layer: 'project', file: 'settings.json' },
  { layer: 'local', file: 'settings.local.json' },
]

function workspaceHooks(cwd: string): LayeredHook[] {
  const own = hooksSnapshot()
  if (own.disabled) return []
  const hooks = own.hooks.filter(hook => hook.source.kind === 'settings' && !CHECKOUT_LAYERS.has(hook.source.layer))
  if (own.managedOnly || !isPathTrusted(cwd)) return hooks
  const wsUnread: HookSettingsReadError[] = []
  for (const { layer, file } of WORKSPACE_FILES) {
    const path = resolveProjectConfigPath(cwd, file)
    if (path === null) continue
    const parsed = parseSettingsFile(path)
    if (parsed.settings === null) {
      const readError = readErrorOf(parsed.errors, path)
      if (readError !== undefined) wsUnread.push(readError)
    }
    hooks.push(...entriesOf(parsed.settings?.events?.hooks, layer))
  }
  if (wsUnread.length > 0) own.workspaceUnread[cwd] = wsUnread
  else delete own.workspaceUnread[cwd]
  return hooks
}

export function hooksSettingsUnreadErrors(cwd?: string): HookSettingsReadError[] {
  const current = hooksSnapshot()
  const out = [...current.unreadErrors]
  if (cwd !== undefined) {
    for (const item of current.workspaceUnread[cwd] ?? []) {
      if (!out.some(e => e.path === item.path)) out.push(item)
    }
  }
  return out
}
export function hooksDisabled(): boolean {
  return hooksSnapshot().disabled
}

export function hooksSkippedForTrustLine(): string | null {
  const snapshot = hooksSnapshot()
  if (snapshot.skippedForTrust === 0) return null
  const count = snapshot.skippedForTrust
  return `hooks: this folder is not trusted, so ${count === 1 ? 'its 1 project or local hook was' : `its ${count} project and local hooks were`} not loaded — start Mercury here once and accept the trust card, and they run`
}

export function managedHooksOnly(): boolean {
  return hooksSnapshot().managedOnly
}

export function resetHooksSnapshot(): void {
  snapshot = undefined
  clearRegisteredHooks()
}
