import {
  kitDeltasForWorkspace,
  setExtensionStateForWorkspace,
  setMcpServerEnabledForWorkspace,
  setSkillStateForWorkspace,
  type KitDeltasV1,
} from '../mcp/kitStore.js'
import { kitStateKey, type KitRow, type KitRowState, type KitStates } from './kitTypes.js'

export type KitDeltasShape = KitDeltasV1

export type KitWriteReceipt = { ok: true; receipt: string } | { ok: false; reason: string }

export interface KitMenuStore {
  read(workspaceDir: string): KitStates
  write(workspaceDir: string, row: KitRow, next: KitRowState): KitWriteReceipt
}

export function statesFromDeltas(deltas: KitDeltasShape): KitStates {
  const states = new Map<string, KitRowState>()
  for (const name of deltas.mcpOff) states.set(`mcp:${name}`, 'off')
  for (const [name, state] of Object.entries(deltas.skillStates)) states.set(`skill:${name}`, state)
  for (const name of deltas.extensionsOff) states.set(`extension:${name}`, 'off')
  return states
}

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

export function standingStateOf(states: KitStates, row: KitRow): KitRowState {
  const key = kitStateKey(row)
  return key === null ? 'on' : (states.get(key) ?? 'on')
}

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
    const after = standingStateOf(this.read(workspaceDir), row)
    if (after !== next) return { ok: false, reason: `the record still reads ${after}` }
    return { ok: true, receipt: receiptFor(row, next, changed) }
  }
}

export const kitMenuStore: KitMenuStore = new RecordKitMenuStore()
