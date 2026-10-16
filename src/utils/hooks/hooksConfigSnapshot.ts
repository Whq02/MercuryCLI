import { clearRegisteredHooks } from '../../bootstrap/state.js'
import { isPathTrusted, untrustedWorkspaceHeadless } from '../config.js'
import { logForDebugging } from '../debug.js'
import { resolveProjectConfigPath } from '../projectConfig.js'
import { getEnabledSettingSources, type SettingSource } from '../settings/constants.js'
import { getSettingsForSource, parseSettingsFile } from '../settings/settings.js'
import { resetSettingsCache } from '../settings/settingsCache.js'
import { isRestrictedToExtensionsOnly } from '../settings/extensionOnlyPolicy.js'
import type { HookEntry, HooksSettings } from '../settings/types.js'
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

function readLayers(): Array<{ layer: HookLayer; map: HooksSettings | undefined; disabled: boolean; managedOnly: boolean }> {
  return getEnabledSettingSources().map(source => {
    const events = getSettingsForSource(source)?.events
    return {
      layer: LAYER_OF_SOURCE[source],
      map: events?.hooks,
      disabled: events?.disabled === true,
      managedOnly: events?.managedOnly === true,
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
}

function computeSnapshot(): HooksSnapshot {
  const layers = readLayers()
  const managed = layers.find(l => l.layer === 'managed')
  const disabledByManaged = managed?.disabled === true
  const managedOnly = managed?.managedOnly === true
  const disabledBelow = layers.some(l => l.layer !== 'managed' && l.disabled)
  const extensionsOnly = isRestrictedToExtensionsOnly('hooks')
  const untrustedCheckout = untrustedWorkspaceHeadless()
  if (disabledByManaged) return { hooks: [], disabled: true, managedOnly: false, extensionsOnly, untrustedCheckout, skippedForTrust: 0 }
  const keepOnlyManaged = managedOnly || disabledBelow || extensionsOnly
  if (untrustedCheckout && !keepOnlyManaged) {
    logForDebugging('hooks: untrusted workspace on a non-interactive road — checkout hooks are not loaded (boot interactively once here to trust this directory)')
  }
  const hooks: LayeredHook[] = []
  let skippedForTrust = 0
  for (const { layer, map } of layers) {
    if (keepOnlyManaged && layer !== 'managed') continue
    if (untrustedCheckout && CHECKOUT_LAYERS.has(layer)) {
      skippedForTrust += entriesOf(map, layer).length
      continue
    }
    hooks.push(...entriesOf(map, layer))
  }
  return { hooks, disabled: false, managedOnly: keepOnlyManaged, extensionsOnly, untrustedCheckout, skippedForTrust }
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
  for (const { layer, file } of WORKSPACE_FILES) {
    const path = resolveProjectConfigPath(cwd, file)
    if (path === null) continue
    hooks.push(...entriesOf(parseSettingsFile(path).settings?.events?.hooks, layer))
  }
  return hooks
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
