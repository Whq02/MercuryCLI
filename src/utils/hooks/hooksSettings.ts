import type { AppState } from '../../state/AppState.js'
import { getSessionId } from '../../bootstrap/state.js'
import type { HookEntry } from '../settings/types.js'
import { getRelativeSettingsFilePathForSource, getSettingsFilePathForSource } from '../settings/settings.js'
import { toTildePath } from '../path.js'
import { hookEntryName, hookKindOf } from '../../schemas/hooks.js'
import { HOOK_EVENTS, type HookEvent } from './contract.js'
import { HOOK_LAYERS, type HookLayer, type HookSource } from './hooksConfigSnapshot.js'
import { dedupeHooks, hooksFor, type MatchedHook } from './matching.js'

export type HookRow = MatchedHook & { match: string }

export function listHooks(appState: AppState, sessionId: string = getSessionId()): HookRow[] {
  const rows: HookRow[] = []
  for (const event of HOOK_EVENTS) {
    for (const hook of dedupeHooks(hooksFor(event, { sessionId }, appState))) {
      rows.push({ ...hook, match: hook.entry.match ?? '' })
    }
  }
  return rows
}

const LAYER_WORDS: Readonly<Record<HookLayer, string>> = {
  user: 'User',
  project: 'Project',
  local: 'Local',
  flag: 'Flag',
  managed: 'Managed',
}

export function hookLayerWords(layer: HookLayer): string {
  return LAYER_WORDS[layer]
}

export function hookSourceShortWords(source: HookSource): string {
  switch (source.kind) {
    case 'settings':
      return LAYER_WORDS[source.layer]
    case 'extension':
      return 'Extension'
    case 'skill':
      return 'Skill'
    case 'agent':
      return 'Agent'
  }
}

function layerSourceWords(layer: HookLayer): string {
  switch (layer) {
    case 'user': {
      const path = getSettingsFilePathForSource('userSettings')
      return `User settings (${path ? toTildePath(path) : 'unavailable'})`
    }
    case 'project':
      return `Project settings (${getRelativeSettingsFilePathForSource('projectSettings')})`
    case 'local':
      return `Local settings (${getRelativeSettingsFilePathForSource('localSettings')})`
    case 'flag':
      return 'Flag settings (--settings)'
    case 'managed':
      return 'Managed settings'
  }
}

export function hookSourceWords(source: HookSource): string {
  switch (source.kind) {
    case 'settings':
      return layerSourceWords(source.layer)
    case 'extension':
      return `Extension ${source.name}`
    case 'skill':
      return `Skill ${source.name}`
    case 'agent':
      return `Agent ${source.type}`
  }
}

export function hookSourceRank(source: HookSource): number {
  if (source.kind === 'settings') return HOOK_LAYERS.indexOf(source.layer)
  return HOOK_LAYERS.length + ['extension', 'skill', 'agent'].indexOf(source.kind)
}

export function hookRowName(row: HookRow): string {
  return hookEntryName(row.entry)
}

export function hookRowKind(row: HookRow): string {
  return hookKindOf(row.entry)
}
