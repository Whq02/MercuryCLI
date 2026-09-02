import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import type { GlobalConfig } from '../../utils/config/schema.js'
import type { KitDeltasV1 } from './kitStore.js'

type SchemaPresetValue = NonNullable<GlobalConfig['kitPresets']>[string]
const _schemaPresetValueIsKitDeltasV1: SchemaPresetValue extends KitDeltasV1
  ? KitDeltasV1 extends SchemaPresetValue
    ? true
    : never
  : never = true
void _schemaPresetValueIsKitDeltasV1

export const PRESET_NAME_MAX = 40
export const PRESET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 -]{0,39}$/

export function presetNameProblem(name: string): string | null {
  const trimmed = name.trim()
  if (trimmed === '') return 'type a name first'
  if (!PRESET_NAME_PATTERN.test(trimmed)) return 'a preset name is letters, digits, hyphens and spaces — 1 to 40 characters'
  return null
}

export const KIT_PRESET_CAP = 200
export const PRESET_LIST_CAP = 2000

export type KitPresetReceipt = { ok: true; receipt: string } | { ok: false; reason: string }
export type KitPresetResolve = { ok: true; deltas: KitDeltasV1 } | { ok: false; reason: string }

export function presetDeltaCount(deltas: KitDeltasV1): number {
  return deltas.mcpOff.length + Object.keys(deltas.skillStates).length + deltas.extensionsOff.length
}

function rawPresetsOf(config: GlobalConfig): Record<string, unknown> {
  const raw = config.kitPresets
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
}

function narrowPresetEntry(raw: unknown): { ok: true; deltas: KitDeltasV1 } | { ok: false; problem: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, problem: 'not an object' }
  const entry = raw as Record<string, unknown>
  const names = (field: 'mcpOff' | 'extensionsOff'): string[] | string => {
    const list = entry[field]
    if (!Array.isArray(list)) return `${field} is not an array`
    if (list.length > PRESET_LIST_CAP) return `${field} lists ${list.length} names (cap ${PRESET_LIST_CAP})`
    const out: string[] = []
    for (const item of list) {
      if (typeof item !== 'string') return `${field} carries a non-string entry`
      if (!out.includes(item)) out.push(item)
    }
    return out
  }
  const mcpOff = names('mcpOff')
  if (typeof mcpOff === 'string') return { ok: false, problem: mcpOff }
  const extensionsOff = names('extensionsOff')
  if (typeof extensionsOff === 'string') return { ok: false, problem: extensionsOff }
  if (typeof entry.skillStates !== 'object' || entry.skillStates === null || Array.isArray(entry.skillStates)) {
    return { ok: false, problem: 'skillStates is not an object' }
  }
  const skillEntries = Object.entries(entry.skillStates as Record<string, unknown>)
  if (skillEntries.length > PRESET_LIST_CAP) return { ok: false, problem: `skillStates names ${skillEntries.length} skills (cap ${PRESET_LIST_CAP})` }
  const skillStates: Record<string, 'off' | 'invocable'> = {}
  for (const [name, state] of skillEntries) {
    if (state !== 'off' && state !== 'invocable') return { ok: false, problem: `skillStates[${JSON.stringify(name)}] is not 'off' or 'invocable'` }
    skillStates[name] = state
  }
  return { ok: true, deltas: { mcpOff, skillStates, extensionsOff } }
}

export function listKitPresets(): string[] {
  return Object.keys(rawPresetsOf(getGlobalConfig())).sort((a, b) => a.localeCompare(b))
}

function rosterWordsOf(names: string[]): string {
  if (names.length === 0) return "none saved yet — 'p' on the MCPs & Skills menu saves the current record under a name"
  const shown = names.slice(0, 8).map(n => `'${n}'`).join(' · ')
  return `saved presets: ${shown}${names.length > 8 ? ` (+${names.length - 8} more)` : ''}`
}

export function kitPresetDeltas(name: string): KitPresetResolve {
  const raw = rawPresetsOf(getGlobalConfig())
  if (!Object.prototype.hasOwnProperty.call(raw, name)) {
    return { ok: false, reason: `unknown preset '${name.slice(0, PRESET_NAME_MAX)}' — ${rosterWordsOf(Object.keys(raw).sort((a, b) => a.localeCompare(b)))}` }
  }
  const entry = narrowPresetEntry(raw[name])
  if (!entry.ok) return { ok: false, reason: `preset '${name}' is damaged in the config (${entry.problem}) — save it again from the menu` }
  return { ok: true, deltas: entry.deltas }
}

export function saveKitPreset(name: string, deltas: KitDeltasV1): KitPresetReceipt {
  const problem = presetNameProblem(name)
  if (problem !== null) return { ok: false, reason: problem }
  const trimmed = name.trim()
  const canonical = narrowPresetEntry(deltas)
  if (!canonical.ok) return { ok: false, reason: `the snapshot is not the deltas shape (${canonical.problem})` }
  const count = presetDeltaCount(canonical.deltas)
  const countWord = `${count} delta${count === 1 ? '' : 's'}`
  let receipt: KitPresetReceipt = { ok: true, receipt: `preset '${trimmed}' saved (${countWord})` }
  saveGlobalConfig(current => {
    const raw = rawPresetsOf(current)
    const standing = Object.prototype.hasOwnProperty.call(raw, trimmed) ? narrowPresetEntry(raw[trimmed]) : null
    if (standing === null && Object.keys(raw).length >= KIT_PRESET_CAP) {
      receipt = { ok: false, reason: `the store holds ${Object.keys(raw).length} presets (cap ${KIT_PRESET_CAP}) — delete one first` }
      return current
    }
    if (standing !== null && standing.ok && JSON.stringify(standing.deltas) === JSON.stringify(canonical.deltas)) {
      receipt = { ok: true, receipt: `preset '${trimmed}' already saved — unchanged (${countWord})` }
      return current
    }
    if (standing !== null) {
      const wasWord = standing.ok ? `${presetDeltaCount(standing.deltas)} delta${presetDeltaCount(standing.deltas) === 1 ? '' : 's'}` : 'damaged'
      receipt = { ok: true, receipt: `preset '${trimmed}' updated (was ${wasWord}, now ${countWord})` }
    }
    return {
      ...current,
      kitPresets: { ...raw, [trimmed]: JSON.parse(JSON.stringify(canonical.deltas)) as KitDeltasV1 } as Record<string, KitDeltasV1>,
    }
  })
  return receipt
}

export function deleteKitPreset(name: string): KitPresetReceipt {
  let receipt: KitPresetReceipt = { ok: true, receipt: `preset '${name}' deleted` }
  saveGlobalConfig(current => {
    const raw = rawPresetsOf(current)
    if (!Object.prototype.hasOwnProperty.call(raw, name)) {
      receipt = { ok: false, reason: `unknown preset '${name.slice(0, PRESET_NAME_MAX)}' — ${rosterWordsOf(Object.keys(raw).sort((a, b) => a.localeCompare(b)))}` }
      return current
    }
    const { [name]: _dropped, ...rest } = raw
    void _dropped
    if (Object.keys(rest).length === 0) {
      const { kitPresets: _all, ...bare } = current
      void _all
      return bare as GlobalConfig
    }
    return { ...current, kitPresets: rest as Record<string, KitDeltasV1> }
  })
  return receipt
}
