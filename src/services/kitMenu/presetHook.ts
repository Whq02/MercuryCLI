import { saveKitPreset } from '../mcp/presetStore.js'
import type { KitDeltasShape } from './menuStore.js'

export interface KitPresetSnapshot {
  workspaceDir: string
  deltas: KitDeltasShape
  members: { mcp: string[]; skills: string[]; extensions: string[] }
}

export type KitPresetReceipt = { ok: true; receipt: string } | { ok: false; reason: string }

export interface KitPresetHook {
  save(name: string, snapshot: KitPresetSnapshot): KitPresetReceipt
}

export { PRESET_NAME_MAX, PRESET_NAME_PATTERN, presetNameProblem } from '../mcp/presetStore.js'

export const STORE_PRESET_HOOK: KitPresetHook = {
  save: (name, snapshot) => saveKitPreset(name, snapshot.deltas),
}

let bound: KitPresetHook = STORE_PRESET_HOOK

export function kitPresetHook(): KitPresetHook {
  return bound
}

export function bindKitPresetHook(next: KitPresetHook): void {
  bound = next
}

export function _resetKitPresetHookForTesting(): void {
  bound = STORE_PRESET_HOOK
}
