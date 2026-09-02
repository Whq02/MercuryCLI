// ============================================================================
//  src/utils/config/derived.ts — derived reads over the global config:
//  updater posture, identity, memory-file paths, and small preference
//  accessors. No io of its own — everything routes through getGlobalConfig/
//  saveGlobalConfig.
//
//  config.ts is the compatibility barrel over this family; submodules never
//  import the barrel.
// ============================================================================
import { randomBytes } from 'crypto'
import { join } from 'path'
import { getOriginalCwd } from '../../bootstrap/state.js'
import { getAutoMemEntrypoint } from '../../memdir/paths.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import {
  getMercuryHome,
  isEnvDefinedFalsy,
  isEnvTruthy,
} from '../envUtils.js'
import type { MemoryType } from '../memory/types.js'
import { getManagedFilePath } from '../settings/managedPath.js'

import { getGlobalConfig, saveGlobalConfig } from './globalConfig.js'

/**
 * Effective remoteControlAtStartup: the operator's explicit config value
 * when present (either direction), else OFF — Remote Control never starts
 * itself without an explicit opt-in.
 */
export function getRemoteControlAtStartup(): boolean {
  const explicit = getGlobalConfig().remoteControlAtStartup
  if (explicit !== undefined) return explicit

  return false
}

/** The stored verdict for a manually entered API key (keyed truncated). */
export function getCustomApiKeyStatus(
  truncatedApiKey: string,
): 'approved' | 'rejected' | 'new' {
  const config = getGlobalConfig()
  if (config.customApiKeyResponses?.approved?.includes(truncatedApiKey)) {
    return 'approved'
  }
  if (config.customApiKeyResponses?.rejected?.includes(truncatedApiKey)) {
    return 'rejected'
  }
  return 'new'
}

export function isAutoUpdaterDisabled(): boolean {
  return getAutoUpdaterDisabledReason() !== null
}

export type AutoUpdaterDisabledReason =
  | { type: 'development' }
  | { type: 'env'; envVar: string }
  | { type: 'config' }
  | { type: 'standalone' }


/**
 * The launcher/binary name to show the USER in copy-pasteable commands.
 * Mercury launches as `mercury` (the ~/.local/bin launcher), NOT a `claude`
 * binary — so resume/exit hints, MCP/CLI help, and remediation messages must
 * say `mercury …` (otherwise the command the user is told to run does not
 * exist). Single source of truth for the binary-name long-tail; interpolate it
 * instead of hardcoding. NOTE: this is for USER-FACING command text only —
 * provider-side contract spellings (the KEEP ledger's API-behavior env
 * class, the provider UA leaf) are boundary contracts decoded at their
 * adapters (canonical env names are `MERCURY_*` at the flag
 * registry; retired spellings resolve only through its bounded alias).
 */
export function binaryName(): string {
  return 'mercury'
}

/**
 * Whether fullscreen drag-selection auto-copies to the clipboard on mouse-up.
 *
 * Default ON (operator directive: cmd+c never reaches the pty on
 * macOS, so the muscle-memory copy is delivered by the selection ALREADY
 * being on the clipboard at drag-release — iTerm2 semantics). Explicit user
 * config (`copyOnSelect: false` in /config) opts out; plain ctrl+c with a
 * selection active still copies either way (ScrollKeybindingHandler's
 * chord-exact guard), and ctrl+c with no selection keeps the interrupt/exit
 * grammar. Every copy path raises the one "Copied to clipboard" receipt.
 */
export function isCopyOnSelectEnabled(): boolean {
  return getGlobalConfig().copyOnSelect ?? true
}

/**
 * The Mercury "substrate" convenience umbrella: turns on the SAFE,
 * behavior-additive subset of the Mercury substrate capabilities in a single
 * flag, so a user doesn't have to set N env vars.
 *
 * WIRED LIVE for Mercury: this ships ON for the Mercury build —
 * opt out with `MERCURY_SUBSTRATE=0` (or `false`/`no`/`off` — the shared
 * `isEnvDefinedFalsy` falsy set). Any other value, or unset, is ON.
 * The explicit opt-out is byte-identical to before.
 *
 * ADDITIVE-SAFE only — it OR's into the individual gates for: invocation trace
 * (passive JSONL, never logs raw args), cache-aware compaction (only the
 * suppress-only breaker rides the profile — it can merely stop a doomed retry;
 * the advance-trigger that summarizes early needs the explicit
 * MERCURY_CTX_COMPACTION opt-in so a Mercury session keeps the native, late
 * compaction point by default), and the persistent deck pane (UI,
 * fullscreen-only). The individual flags (MERCURY_TRACE / MERCURY_CTX_COMPACTION /
 * MERCURY_DECK_PANE) keep working independently and as
 * explicit overrides.
 *
 * It deliberately does NOT cover the risky / autonomous / operator-policy pieces
 * — those stay individually opt-in: MERCURY_KILL, MERCURY_COORDINATION_MCP, the
 * `mercury daemon` and MERCURY_MCP_MAX_RISK tightening.
 */
export function isMercurySubstrateProfileOn(): boolean {
  if (isEnvDefinedFalsy(flagEnv('MERCURY_SUBSTRATE'))) return false
  return true
}

export function formatAutoUpdaterDisabledReason(
  reason: AutoUpdaterDisabledReason,
): string {
  switch (reason.type) {
    case 'development':
      return 'development build'
    case 'env':
      return `${reason.envVar} set`
    case 'config':
      return 'config'
    case 'standalone':
      return 'Mercury source build'
  }
}

export function getAutoUpdaterDisabledReason(): AutoUpdaterDisabledReason | null {
  // Mercury is standalone: updates ride the private channel (mercury
  // update); an auto-updater must never run over it.
  return { type: 'standalone' }
}

/** The stable anonymous machine id, minted on first read. */
export function getOrCreateUserID(): string {
  const config = getGlobalConfig()
  if (config.userID) {
    return config.userID
  }

  const userID = randomBytes(32).toString('hex')
  saveGlobalConfig(current => ({ ...current, userID }))
  return userID
}

/** Stamp firstStartTime once; the updater re-checks under the save lock so a
 *  racing instance's earlier stamp survives. */
export function recordFirstStartTime(): void {
  const config = getGlobalConfig()
  if (!config.firstStartTime) {
    const firstStartTime = new Date().toISOString()
    saveGlobalConfig(current => ({
      ...current,
      firstStartTime: current.firstStartTime ?? firstStartTime,
    }))
  }
}

/** The on-disk file for each memory type, resolved for this session. */
export function getMemoryPath(memoryType: MemoryType): string {
  const cwd = getOriginalCwd()

  switch (memoryType) {
    case 'User':
      return join(getMercuryHome(), 'MERCURY.md')
    case 'Local':
      return join(cwd, 'MERCURY.local.md')
    case 'Project':
      return join(cwd, 'MERCURY.md')
    case 'Managed':
      return join(getManagedFilePath(), 'MERCURY.md')
    case 'AutoMem':
      return getAutoMemEntrypoint()
  }
  // 'TeamMem' exists only at the TYPE level (memory/types.ts widens the
  // union for fork surfaces; the runtime value list never contains it), so
  // the switch above is runtime-exhaustive and this line only satisfies the
  // type-level arm.
  return ''
}

export function getManagedRulesDir(): string {
  return join(getManagedFilePath(), '.mercury', 'rules')
}

export function getUserRulesDir(): string {
  return join(getMercuryHome(), 'rules')
}
