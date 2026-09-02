// ============================================================================
//  src/services/mcp/presetStore.ts — THE PRESET STORE (ledger L24(4) + the
//  operator's both-doors ruling): named snapshots of the
//  MCPs & Skills menu — a preset is a NAMED KitDeltasV1 (deviations-only,
//  the kit's own grammar; a preset of an all-on menu is EMPTY deltas,
//  lawful), worn at BOTH birth doors: the operator's own New Session (the
//  screen's wear door, one-shot) and the coordinator's launch (the admit's
//  preset derivation).
//
//  GLOBAL BY DESIGN (the ruled store home): presets live as the one global
//  config's `kitPresets` map — a "writing kit" saved in one repo is
//  offerable in every repo (the operator's own travel case), the
//  coordinator's closed roster is the same everywhere, and the daemon reads
//  presets through the ONE landed reader (getGlobalConfig, its freshness
//  watcher bounding a foreign write's staleness to its poll) with zero new
//  fs machinery. The cost, carried honestly: the member names inside a
//  preset are per-repo spellings, so a delta naming a member some repo
//  lacks simply does not bite there (absent = on stands) — and the RESOLVE
//  RECEIPT names it (the screen's wear receipt from the live roster; the
//  daemon's presetNote from its config census).
//
//  THE STORE NEVER RESOLVES: it keeps and answers deltas. Resolution — the
//  deltas against a roster — belongs to the wear door (services/kitMenu/
//  presetWear.ts) and the daemon's derivation (daemon/sessionKit.ts), each
//  running the wire's own validation before anything is stamped. The store
//  never touches the menu record (the per-project slices), any live
//  session, or the next-session facts: saving and deleting presets is
//  bookkeeping on the global map alone, pinned.
//
//  Vocabulary law: "pack" is the extensions estate's word — a saved kit
//  snapshot is a PRESET, here and on every surface.
// ============================================================================
import { getGlobalConfig, saveGlobalConfig } from '../../utils/config.js'
import type { GlobalConfig } from '../../utils/config/schema.js'
import type { KitDeltasV1 } from './kitStore.js'

// The schema's structural spelling IS KitDeltasV1 — pinned by type identity
// (assignable both ways); a drift in either spelling refuses to compile.
type SchemaPresetValue = NonNullable<GlobalConfig['kitPresets']>[string]
const _schemaPresetValueIsKitDeltasV1: SchemaPresetValue extends KitDeltasV1
  ? KitDeltasV1 extends SchemaPresetValue
    ? true
    : never
  : never = true
void _schemaPresetValueIsKitDeltasV1

/** A preset name: letters, digits, hyphens and spaces, 1–40 characters
 *  (the kit screen's prompt speaks this grammar's problems in words —
 *  presetHook.ts re-exports these; THIS module is the owner). */
export const PRESET_NAME_MAX = 40
export const PRESET_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 -]{0,39}$/

/** The name's problem in words, or null when it is a name. */
export function presetNameProblem(name: string): string | null {
  const trimmed = name.trim()
  if (trimmed === '') return 'type a name first'
  if (!PRESET_NAME_PATTERN.test(trimmed)) return 'a preset name is letters, digits, hyphens and spaces — 1 to 40 characters'
  return null
}

/** A hostile store must never grow without bound: the map caps at 200
 *  presets (a NEW name past the cap refuses typed; updates always land). */
export const KIT_PRESET_CAP = 200
/** Per-list bound inside one preset's deltas — spelled locally because this
 *  module must not import the daemon (daemon/sessionKit.ts imports THIS
 *  package); prove-kit-presets pins it equal to sessionKit's KIT_LIST_CAP. */
export const PRESET_LIST_CAP = 2000

export type KitPresetReceipt = { ok: true; receipt: string } | { ok: false; reason: string }
export type KitPresetResolve = { ok: true; deltas: KitDeltasV1 } | { ok: false; reason: string }

/** The deltas' size in plain words ("3 deltas"): the receipts count what a
 *  preset actually deviates. */
export function presetDeltaCount(deltas: KitDeltasV1): number {
  return deltas.mcpOff.length + Object.keys(deltas.skillStates).length + deltas.extensionsOff.length
}

/** The store's map, raw (absent field = none saved — never healed). */
function rawPresetsOf(config: GlobalConfig): Record<string, unknown> {
  const raw = config.kitPresets
  return typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
}

/** The tolerant STRUCTURAL narrowing of one stored entry (an operator can
 *  hand-edit config.json): the exact deltas shape — copied, deduped,
 *  bounded — or the damage in words. Name grammars are NOT judged here:
 *  a delta's member names are matched against rosters downstream (an
 *  unmatched name simply does not bite), and the daemon's derivation runs
 *  the wire's own validateKitDeltas before any stamp. */
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

/** The saved names, sorted — THE ROSTER (both doors' refusals name it; the
 *  presets layer lists it). Every key present in the map is listed, a
 *  damaged value included: a name the operator can see is a name whose
 *  resolve can say what is wrong — an invisible entry would be a silent
 *  hole in the roster. */
export function listKitPresets(): string[] {
  return Object.keys(rawPresetsOf(getGlobalConfig())).sort((a, b) => a.localeCompare(b))
}

/** The roster named for a refusal, bounded (the launch_session precedent). */
function rosterWordsOf(names: string[]): string {
  if (names.length === 0) return "none saved yet — 'p' on the MCPs & Skills menu saves the current record under a name"
  const shown = names.slice(0, 8).map(n => `'${n}'`).join(' · ')
  return `saved presets: ${shown}${names.length > 8 ? ` (+${names.length - 8} more)` : ''}`
}

/** THE RESOLVE DOOR — the one road from a name to deltas: an unknown name
 *  refuses TYPED naming the roster (the closed-roster law — never a silent
 *  fall to the menu default); a damaged entry refuses TYPED naming the
 *  damage. The answer is a COPY, never a live view into the config. */
export function kitPresetDeltas(name: string): KitPresetResolve {
  const raw = rawPresetsOf(getGlobalConfig())
  if (!Object.prototype.hasOwnProperty.call(raw, name)) {
    return { ok: false, reason: `unknown preset '${name.slice(0, PRESET_NAME_MAX)}' — ${rosterWordsOf(Object.keys(raw).sort((a, b) => a.localeCompare(b)))}` }
  }
  const entry = narrowPresetEntry(raw[name])
  if (!entry.ok) return { ok: false, reason: `preset '${name}' is damaged in the config (${entry.problem}) — save it again from the menu` }
  return { ok: true, deltas: entry.deltas }
}

/** THE SAVE PEN: the named snapshot written whole (a COPY in canonical
 *  shape). An existing name UPDATES — said on the receipt, never silent;
 *  a byte-identical save writes nothing and says so; a NEW name past the
 *  cap refuses typed. Touches ONLY the global kitPresets map — never the
 *  menu record, never a live session, never the next-session facts. */
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
      // A damaged sibling entry is PRESERVED as it stands (visible on the
      // roster; its own resolve says the damage) — the pen writes only its
      // named entry, in canonical shape; hence the cast over the raw map.
      kitPresets: { ...raw, [trimmed]: JSON.parse(JSON.stringify(canonical.deltas)) as KitDeltasV1 } as Record<string, KitDeltasV1>,
    }
  })
  return receipt
}

/** THE DELETE PEN: an unknown name refuses typed; deleting the LAST preset
 *  drops the field whole (absent = none saved — the omit-on-empty law). */
export function deleteKitPreset(name: string): KitPresetReceipt {
  let receipt: KitPresetReceipt = { ok: true, receipt: `preset '${name}' deleted` }
  saveGlobalConfig(current => {
    const raw = rawPresetsOf(current)
    if (!Object.prototype.hasOwnProperty.call(raw, name)) {
      // The refusal's roster reads the UPDATER's own view — never a second
      // config read under the save lock.
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
