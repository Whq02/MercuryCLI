// ============================================================================
//  services/kitMenu/menuStore — THE MANAGER'S WRITE DOOR over the menu store
//  (the operator's L24(3): "that basically makes them apply to be off for
//  the next session"; L24(5)'s screen; O-2: per repo).
//
//  The record is the kit store's (src/services/mcp/kitStore.ts — the
//  per-project slice of the one global config, read and written by EXPLICIT
//  workspace): DELTAS, never rosters —
//    · mcpOff        — the landed disabledMcpServers record, RENDERED through
//                      the disabled semantics (services/mcp/disabledRecord.ts),
//                      never the raw lists
//    · skillStates   — absent = on · 'invocable' = the /name door only · 'off'
//    · extensionsOff — the master rows (off = nothing the extension
//                      contributes loads)
//  An empty record is today's behaviour (everything on); a newly added
//  member is on with no menu edit; the screen never nags.
//
//  Write-through per toggle (the landed boot-menu grammar: the visible
//  state IS the saved state; no Save button) through the record's own
//  workspace-keyed pens — 'on' DELETES the deviation, an unchanged state
//  writes nothing (the pens return the slice by identity) — and the receipt
//  names the row and its word. A LIVE session is never touched: the record
//  reaches a session at its BIRTH only (the carried kit, then the daemon's
//  derivation), and the born session owns its snapshot from then on
//  (L24(3)'s live-session law).
// ============================================================================
import {
  kitDeltasForWorkspace,
  setExtensionStateForWorkspace,
  setMcpServerEnabledForWorkspace,
  setSkillStateForWorkspace,
  type KitDeltasV1,
} from '../mcp/kitStore.js'
import { kitStateKey, type KitRow, type KitRowState, type KitStates } from './kitTypes.js'

/** The record's own shape — ONE type, never a local re-spelling (the
 *  identity is the pin: the screen's map is a rendering of KitDeltasV1). */
export type KitDeltasShape = KitDeltasV1

export type KitWriteReceipt = { ok: true; receipt: string } | { ok: false; reason: string }

export interface KitMenuStore {
  /** The recorded deviations for a workspace (absent = on) — a rendering
   *  of the record, never a live view into it. */
  read(workspaceDir: string): KitStates
  /** Write-through: ONE toggle → the record; the receipt names the row and
   *  the word it now wears. Setting the state a row already has writes
   *  nothing and says so. */
  write(workspaceDir: string, row: KitRow, next: KitRowState): KitWriteReceipt
}

/** The record's deltas rendered to the screen's state keys — the SAME keys
 *  kitStateKey mints, so the screen's map IS the record's rendering. */
export function statesFromDeltas(deltas: KitDeltasShape): KitStates {
  const states = new Map<string, KitRowState>()
  for (const name of deltas.mcpOff) states.set(`mcp:${name}`, 'off')
  for (const [name, state] of Object.entries(deltas.skillStates)) states.set(`skill:${name}`, state)
  for (const name of deltas.extensionsOff) states.set(`extension:${name}`, 'off')
  return states
}

/** The inverse rendering: the screen's keys back to the record's shape (a
 *  preset snapshots the record; statesFromDeltas ∘ deltasFromStates is the
 *  identity on the screen's map, pinned). */
export function deltasFromStates(states: KitStates): KitDeltasShape {
  const out: KitDeltasShape = { mcpOff: [], skillStates: {}, extensionsOff: [] }
  for (const [key, state] of states) {
    if (key.startsWith('mcp:')) {
      if (state === 'off') out.mcpOff.push(key.slice('mcp:'.length))
    } else if (key.startsWith('skill:')) {
      if (state === 'off' || state === 'invocable') out.skillStates[key.slice('skill:'.length)] = state
    } else if (key.startsWith('extension:')) {
      if (state === 'off') out.extensionsOff.push(key.slice('extension:'.length))
    }
  }
  return out
}

/** The row's word on a receipt (the label the operator sees). */
export function rowLabelOf(row: KitRow): string {
  switch (row.kind) {
    case 'mcp':
    case 'skill':
      return row.name
    case 'extension':
      return `${row.name} (extension)`
    case 'empty':
    case 'note':
      return row.text
  }
}

export function receiptFor(row: KitRow, next: KitRowState, changed: boolean): string {
  return changed ? `${rowLabelOf(row)} → ${next}` : `${rowLabelOf(row)} already ${next}`
}

/** A row's standing state in a rendering (absent = on). */
export function standingStateOf(states: KitStates, row: KitRow): KitRowState {
  const key = kitStateKey(row)
  return key === null ? 'on' : (states.get(key) ?? 'on')
}

/** THE RECORD store: the door over the kit store's workspace-keyed pens. */
export class RecordKitMenuStore implements KitMenuStore {
  read(workspaceDir: string): KitStates {
    return statesFromDeltas(kitDeltasForWorkspace(workspaceDir))
  }

  write(workspaceDir: string, row: KitRow, next: KitRowState): KitWriteReceipt {
    if (kitStateKey(row) === null) return { ok: false, reason: 'not a toggle' }
    const standing = standingStateOf(this.read(workspaceDir), row)
    const changed = standing !== next
    try {
      switch (row.kind) {
        case 'mcp':
          setMcpServerEnabledForWorkspace(workspaceDir, row.name, next !== 'off')
          break
        case 'skill':
          setSkillStateForWorkspace(workspaceDir, row.name, next)
          break
        case 'extension':
          setExtensionStateForWorkspace(workspaceDir, row.name, next !== 'off')
          break
        case 'empty':
        case 'note':
          return { ok: false, reason: 'not a toggle' }
      }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
    // The visible state IS the saved state: the record answers, not the intent.
    const after = standingStateOf(this.read(workspaceDir), row)
    if (after !== next) return { ok: false, reason: `the record still reads ${after}` }
    return { ok: true, receipt: receiptFor(row, next, changed) }
  }
}

/** The manager's store — the record's own door. */
export const kitMenuStore: KitMenuStore = new RecordKitMenuStore()
