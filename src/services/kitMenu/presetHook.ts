// ============================================================================
//  services/kitMenu/presetHook — "SAVE AS PRESET…", the manager's action
//  HOOK (the operator's L24(4) "the boot-menu screen's toggles saved under a
//  name"). VOCABULARY LAW: "pack" is reserved for extensions — a saved kit
//  snapshot is a PRESET, here and on every surface.
//
//  What the screen hands over: the record's deltas for its workspace (the
//  menu's current truth) + the enumerated roster's names. THE DEFAULT HOOK
//  IS THE STORE DOOR: a save lands the deltas in the global preset store
//  under the prompted name and answers the store's own counted receipt.
//  The roster names ride the snapshot for the record (a resolver can tell
//  a member that was ON by absence from one that never existed) — the
//  STORE deliberately keeps deltas only, the ruled preset shape; the
//  resolve doors answer honestly against whatever roster a repo has.
//  bindKitPresetHook remains a proof's recording seam.
// ============================================================================
import { saveKitPreset } from '../mcp/presetStore.js'
import type { KitDeltasShape } from './menuStore.js'

export interface KitPresetSnapshot {
  workspaceDir: string
  /** The record's deltas at the moment of saving (absent = on). */
  deltas: KitDeltasShape
  /** The enumerated roster, in the runner's resolved spellings. */
  members: { mcp: string[]; skills: string[]; extensions: string[] }
}

export type KitPresetReceipt = { ok: true; receipt: string } | { ok: false; reason: string }

export interface KitPresetHook {
  save(name: string, snapshot: KitPresetSnapshot): KitPresetReceipt
}

/** The name grammar's OWNER is the store (services/mcp/presetStore.ts —
 *  the daemon's refusals and the screen's prompt must speak ONE law);
 *  re-exported here so the screen's imports stay put. */
export { PRESET_NAME_MAX, PRESET_NAME_PATTERN, presetNameProblem } from '../mcp/presetStore.js'

/** THE DEFAULT: the store door itself — the save lands in the global
 *  preset store and the receipt is the store's (counted; 'updated' when a
 *  name is re-saved; typed refusals for a bad name or the cap). The
 *  snapshot's members are deliberately unused here: the ruled preset shape
 *  is deltas-only. */
export const STORE_PRESET_HOOK: KitPresetHook = {
  save: (name, snapshot) => saveKitPreset(name, snapshot.deltas),
}

let bound: KitPresetHook = STORE_PRESET_HOOK

/** The hook the screen calls (the binding's current owner). */
export function kitPresetHook(): KitPresetHook {
  return bound
}

/** A proof's recording seam (the lane's re-bind door, kept). */
export function bindKitPresetHook(next: KitPresetHook): void {
  bound = next
}

export function _resetKitPresetHookForTesting(): void {
  bound = STORE_PRESET_HOOK
}
