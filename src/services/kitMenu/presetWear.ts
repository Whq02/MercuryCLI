import { isKitExtensionName, isKitSkillName, validateSessionKit, type SessionKitV1 } from '../../daemon/sessionKit.js'
import { kitPresetDeltas, presetDeltaCount } from '../mcp/presetStore.js'
import { peekWornPresetKit, setNextSessionFacts } from '../switchboard/bootBirthFacts.js'
import type { KitDeltasShape } from './menuStore.js'
import { statesFromDeltas } from './menuStore.js'
import { resolvedKitOf } from './resolvedKit.js'
import { kitStateKey, type KitRow } from './kitTypes.js'

export type PresetWearResolution =
  | {
      ok: true
      kit: SessionKitV1
      unmatched: string[]
      keptOff: string[]
    }
  | { ok: false; reason: string }

function unmatchedWordOf(stateKey: string): string {
  if (stateKey.startsWith('mcp:')) return `${stateKey.slice('mcp:'.length)} (MCP)`
  if (stateKey.startsWith('skill:')) return `${stateKey.slice('skill:'.length)} (skill)`
  if (stateKey.startsWith('extension:')) return `${stateKey.slice('extension:'.length)} (extension)`
  return stateKey
}

export function resolvePresetWear(rows: readonly KitRow[], deltas: KitDeltasShape): PresetWearResolution {
  const states = statesFromDeltas(deltas)
  const known = new Set<string>()
  for (const row of rows) {
    const key = kitStateKey(row)
    if (key !== null) known.add(key)
  }
  const unmatchedKeys = [...states.keys()].filter(key => !known.has(key))
  const kit = resolvedKitOf(rows, states)
  const unmatched: string[] = []
  const keptOff: string[] = []
  const carrySkillsOff: string[] = []
  const carryExtensionsOff: string[] = []
  for (const key of unmatchedKeys) {
    const state = states.get(key)
    if (key.startsWith('skill:') && state === 'off' && isKitSkillName(key.slice('skill:'.length))) {
      carrySkillsOff.push(key.slice('skill:'.length))
      keptOff.push(unmatchedWordOf(key))
    } else if (key.startsWith('extension:') && state === 'off' && isKitExtensionName(key.slice('extension:'.length))) {
      carryExtensionsOff.push(key.slice('extension:'.length))
      keptOff.push(unmatchedWordOf(key))
    } else {
      unmatched.push(unmatchedWordOf(key))
    }
  }
  if (carrySkillsOff.length > 0) kit.skillsOff = [...(kit.skillsOff ?? []), ...carrySkillsOff]
  if (carryExtensionsOff.length > 0) {
    kit.extensions = { ...(kit.extensions ?? {}) }
    for (const name of carryExtensionsOff) kit.extensions[name] = 'off'
  }
  const verdict = validateSessionKit(kit)
  if (!verdict.ok) return { ok: false, reason: verdict.reason }
  return { ok: true, kit: verdict.kit, unmatched, keptOff }
}

export type PresetWearReceipt = { ok: true; receipt: string } | { ok: false; reason: string }

export function wearPresetForNextSession(name: string, rows: readonly KitRow[]): PresetWearReceipt {
  const resolved = kitPresetDeltas(name)
  if (!resolved.ok) return { ok: false, reason: resolved.reason }
  const wear = resolvePresetWear(rows, resolved.deltas)
  if (!wear.ok) return { ok: false, reason: `preset '${name}' not worn — ${wear.reason}` }
  setNextSessionFacts({ presetKit: { name, kit: wear.kit } })
  const count = presetDeltaCount(resolved.deltas)
  const kept =
    wear.keptOff.length > 0
      ? ` · ${wear.keptOff.length} off delta${wear.keptOff.length === 1 ? '' : 's'} name${wear.keptOff.length === 1 ? 's' : ''} members this repo lacks (${wear.keptOff.join(', ')}) — kept off by name`
      : ''
  const bite =
    wear.unmatched.length > 0
      ? ` · ${wear.unmatched.length} of its ${count} delta${count === 1 ? '' : 's'} name${wear.unmatched.length === 1 ? 's' : ''} members this repo lacks (${wear.unmatched.join(', ')}) — they don't bite`
      : ''
  return { ok: true, receipt: `next session wears preset '${name}' — one-shot: the menu's default resumes after${kept}${bite}` }
}

export function disarmWornPreset(): PresetWearReceipt {
  const worn = peekWornPresetKit()
  if (worn === null) return { ok: false, reason: 'no preset is armed — the menu\'s default stands' }
  setNextSessionFacts({ presetKit: null })
  return { ok: true, receipt: `preset '${worn.name}' disarmed — the menu's default stands` }
}
