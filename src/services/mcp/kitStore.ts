// ============================================================================
//  src/services/mcp/kitStore.ts — THE MENU STORE: the "MCPs & Skills" boot
//  menu's record — the NEXT session's default kit, PER REPO (ledger L24(3),
//  L24(5), O-2) — read and written by EXPLICIT workspace.
//
//  The store IS the per-project slice of the one global config, three halves:
//    · MCPs        — the landed disabledMcpServers / enabledMcpServers pair,
//                    reused as-is and RENDERED through the disabled semantics
//                    (services/mcp/disabledRecord.ts), never the raw lists;
//    · skills      — `skillStates` (absent = on · 'invocable' = the /name
//                    door only · 'off' = absent from the born session);
//    · extensions  — `extensionStates` (the master rows: 'off' = nothing the
//                    extension contributes loads; absent = on).
//  DELTAS, never rosters: an empty record is today's behaviour (everything
//  on), a newly installed member is on with no migration, and the screen
//  never nags. The SESSION's kit (daemon/sessionKit.ts) is the opposite —
//  a closed snapshot stamped at birth from these deltas — so a live session
//  never drifts when this store changes (L24(3)'s live-session law).
//
//  KEYED BY WORKSPACE, NEVER BY THE PROCESS: getProjectPathForConfig is
//  memoized to the boot cwd — right for a runner (the key must not move when
//  the session cd's around), wrong for the daemon deriving a kit for a
//  coordinator birth in another repo, and wrong for the boot face after the
//  projects picker's ground move (nothing resets the memo). Every door here
//  takes the workspace and answers THAT repo's slice.
//
//  Vocabulary law: a saved snapshot of this store is a PRESET — "pack" is the extensions estate's word.
// ============================================================================
import { getProjectConfigForWorkspace, saveProjectConfigForWorkspace } from '../../utils/config.js'
import type { ProjectConfig } from '../../utils/config/schema.js'
import { disabledMcpServerNamesIn, withMcpServerEnabled } from './disabledRecord.js'

/** A skill's menu state once moved off 'on' (absent in the store = on). */
export type SkillMenuState = 'off' | 'invocable'

/** The tri-state a dial or a menu row speaks; 'on' is the store's absence. */
export type SkillKitState = 'on' | SkillMenuState

/**
 * THE MENU'S DELTAS for one workspace — what a birth subtracts from the
 * roster the runner resolves. Rendered (the MCP half through the disabled
 * semantics), copied (never a live view into the config), and complete: a
 * slice with no kit fields reads as the empty deltas — everything on.
 */
export interface KitDeltasV1 {
  /** MCP servers the menu turned off (the disabled record, as names). */
  mcpOff: string[]
  /** Skills moved off 'on', by resolved name. */
  skillStates: Record<string, SkillMenuState>
  /** Extensions whose master row is off, by manifest name. */
  extensionsOff: string[]
}

/** The empty deltas — the never-nags default: everything on. */
export function emptyKitDeltas(): KitDeltasV1 {
  return { mcpOff: [], skillStates: {}, extensionsOff: [] }
}

/** The deltas of one slice (pure; the workspace door below feeds it). */
export function kitDeltasOf(slice: ProjectConfig): KitDeltasV1 {
  const skillStates: Record<string, SkillMenuState> = {}
  for (const [name, state] of Object.entries(slice.skillStates ?? {})) {
    if (state === 'off' || state === 'invocable') skillStates[name] = state
  }
  const extensionsOff: string[] = []
  for (const [name, state] of Object.entries(slice.extensionStates ?? {})) {
    if (state === 'off' && !extensionsOff.includes(name)) extensionsOff.push(name)
  }
  return { mcpOff: disabledMcpServerNamesIn(slice), skillStates, extensionsOff }
}

/** The menu's deltas for THIS workspace's repo (the §0.3 workspace-keyed
 *  read): the daemon's derivation road and the boot face's own. */
export function kitDeltasForWorkspace(workspaceDir: string): KitDeltasV1 {
  return kitDeltasOf(getProjectConfigForWorkspace(workspaceDir))
}

/** Identity-preserving updater: the slice with the skill's menu state set.
 *  'on' DELETES the key (absent = on — an all-on list is never written
 *  out); setting the state a skill already has returns the input by
 *  identity so the store's change detection skips the write. */
export function withSkillState(current: ProjectConfig, name: string, state: SkillKitState): ProjectConfig {
  const states = current.skillStates ?? {}
  const standing: SkillKitState = states[name] ?? 'on'
  if (standing === state) return current
  if (state === 'on') {
    const { [name]: _dropped, ...rest } = states
    void _dropped
    return Object.keys(rest).length === 0 ? omitKey(current, 'skillStates') : { ...current, skillStates: rest }
  }
  return { ...current, skillStates: { ...states, [name]: state } }
}

/** Identity-preserving updater: the extension's master row. On DELETES the
 *  key (absent = on); off writes 'off'. */
export function withExtensionState(current: ProjectConfig, name: string, on: boolean): ProjectConfig {
  const states = current.extensionStates ?? {}
  const standingOn = states[name] !== 'off'
  if (standingOn === on) return current
  if (on) {
    const { [name]: _dropped, ...rest } = states
    void _dropped
    return Object.keys(rest).length === 0 ? omitKey(current, 'extensionStates') : { ...current, extensionStates: rest }
  }
  return { ...current, extensionStates: { ...states, [name]: 'off' } }
}

function omitKey(current: ProjectConfig, key: 'skillStates' | 'extensionStates'): ProjectConfig {
  const { [key]: _dropped, ...rest } = current
  void _dropped
  return rest as ProjectConfig
}

// ── the menu's pens (write-through per toggle, the boot menu's grammar) ─────

/** The menu's MCP toggle for a workspace — the landed disabled record's
 *  own pen, keyed by workspace. */
export function setMcpServerEnabledForWorkspace(workspaceDir: string, name: string, enabled: boolean): void {
  saveProjectConfigForWorkspace(workspaceDir, current => withMcpServerEnabled(current, name, enabled))
}

/** The menu's skill tri-state for a workspace. */
export function setSkillStateForWorkspace(workspaceDir: string, name: string, state: SkillKitState): void {
  saveProjectConfigForWorkspace(workspaceDir, current => withSkillState(current, name, state))
}

/** The menu's extension master row for a workspace. */
export function setExtensionStateForWorkspace(workspaceDir: string, name: string, on: boolean): void {
  saveProjectConfigForWorkspace(workspaceDir, current => withExtensionState(current, name, on))
}
