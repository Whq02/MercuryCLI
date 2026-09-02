// ============================================================================
//  src/utils/config/trust.ts — the trust-dialog ledger.
//
//  Trust is a per-directory grant persisted in the project records of the
//  global config (hasTrustDialogAccepted, keyed by normalized path), plus one
//  session-only arm for the home-directory case. A grant on a directory
//  covers every descendant: the read side walks ancestors, so trusting a
//  repo root trusts its worktrees and subfolders without extra records.
//
//  config.ts is the compatibility barrel over this family; submodules never
//  import the barrel.
// ============================================================================
import { homedir } from 'os'
import { resolve } from 'path'
import { getIsNonInteractiveSession, getSessionTrustAccepted, setSessionTrustAccepted } from '../../bootstrap/state.js'
import { getCwd } from '../../utils/cwd.js'
import { logForDebugging } from '../debug.js'
import { normalizePathForConfigKey } from '../path.js'

import { DEFAULT_PROJECT_CONFIG } from './schema.js'
import { getGlobalConfig, saveGlobalConfig } from './globalConfig.js'
import { getProjectPathForConfig, saveCurrentProjectConfig } from './projectConfig.js'

// Session latch for the cwd trust verdict — see checkHasTrustDialogAccepted.
let _trustAccepted = false

export function resetTrustDialogAcceptedCacheForTesting(): void {
  _trustAccepted = false
}

/**
 * Whether trust is already granted for this session's cwd (true = the trust
 * dialog need not be shown). Composes the session arm, the project record,
 * and the ancestor walk — see computeTrustDialogAccepted.
 *
 * Trust only ever transitions false→true within a session (never the
 * reverse), so a true verdict latches. A false verdict is NOT cached: it is
 * recomputed on every call so a mid-session acceptance is picked up
 * immediately. (A plain memoize would wrongly freeze the false.)
 */
export function checkHasTrustDialogAccepted(): boolean {
  return (_trustAccepted ||= computeTrustDialogAccepted())
}

/**
 * True when a NON-INTERACTIVE session runs in a workspace holding no trust
 * record (FC-144). The headless road has no trust dialog, and "embedded
 * implies trusted" proved false for a plain `mercury -p` in a fresh
 * checkout: its SessionStart hooks, apiKeyHelper and .mcp.json servers all
 * spawned on arrival. Under this predicate, checkout-delivered EXECUTABLES
 * (project/local settings hooks, a checkout apiKeyHelper, .mcp.json
 * servers) do not run; config from OUTSIDE the checkout (the config home,
 * the CLI flag, managed policy) still applies, so an operator's own
 * automation is untouched. One trusted interactive boot in the directory
 * (or an ancestor) clears it for every later headless run there.
 */
export function untrustedWorkspaceHeadless(): boolean {
  try {
    if (!getIsNonInteractiveSession()) return false
    return !checkHasTrustDialogAccepted()
  } catch {
    // Unbootstrapped state (module-level test imports): behave as before.
    return false
  }
}

function computeTrustDialogAccepted(): boolean {
  // Session arm: running from the home directory shows the dialog but keeps
  // the acceptance in memory only (persisting a trust grant on $HOME would
  // trust everything, forever). The in-memory flag lets trust-gated features
  // work for the rest of the session.
  if (getSessionTrustAccepted()) {
    return true
  }

  const config = getGlobalConfig()

  // The project record: the path saveCurrentProjectConfig persists under
  // (git root when there is one, else the boot cwd) — where an acceptance
  // for this project would have been written.
  const projectPath = getProjectPathForConfig()
  const projectConfig = config.projects?.[projectPath]
  if (projectConfig?.hasTrustDialogAccepted) {
    return true
  }

  // The ancestor walk: any grant on the cwd or one of its parents covers us.
  // Paths are normalized to keep the JSON key comparison platform-stable.
  let currentPath = normalizePathForConfigKey(getCwd())

  while (true) {
    const pathConfig = config.projects?.[currentPath]
    if (pathConfig?.hasTrustDialogAccepted) {
      return true
    }

    const parentPath = normalizePathForConfigKey(resolve(currentPath, '..'))
    // Filesystem root: resolve(root, '..') === root.
    if (parentPath === currentPath) {
      break
    }
    currentPath = parentPath
  }

  return false
}

/**
 * Trust verdict for an ARBITRARY directory (not the session cwd). Same
 * ancestor walk as the cwd check, but with no session arm and no memoized
 * project path — use when the target differs from cwd (e.g. an installer
 * operating on a user-typed path).
 */
export function isPathTrusted(dir: string): boolean {
  const config = getGlobalConfig()
  let currentPath = normalizePathForConfigKey(resolve(dir))
  while (true) {
    if (config.projects?.[currentPath]?.hasTrustDialogAccepted) return true
    const parentPath = normalizePathForConfigKey(resolve(currentPath, '..'))
    if (parentPath === currentPath) return false
    currentPath = parentPath
  }
}

/**
 * Persist a trust grant for an ARBITRARY directory (idempotent). Pins
 * hasTrustDialogAccepted:true on exactly the normalized path — no ancestor
 * writes (descendants are covered by the read-side walk). Writes the global
 * config keyed by `dir` directly, because saveCurrentProjectConfig always
 * keys on the session's own project path.
 */
export function setPathTrusted(dir: string): void {
  const absolutePath = normalizePathForConfigKey(resolve(dir))
  // THE HOME ROOT NEVER PERSISTS (TASK-017 supplement, S1): a durable grant
  // on $HOME would trust everything forever — the ledger's own law, which
  // TrustDialog honors with its session-only arm. Its caller then wrapped
  // the dialog in an unconditional setPathTrusted(getCwd()), overwriting
  // the promise with a durable record the ancestor walk spread over every
  // folder under the profile (on Windows a fresh terminal OPENS in
  // %USERPROFILE%, so one accidental home boot silenced the trust card for
  // good). The refusal lives at the ONE write door so no caller can
  // re-mint it: a home grant becomes the session latch it was promised as.
  if (absolutePath === normalizePathForConfigKey(homedir())) {
    setSessionTrustAccepted(true)
    return
  }
  saveGlobalConfig(current => {
    // Already trusted ⇒ same-reference return ⇒ the save layer skips the write.
    if (current.projects?.[absolutePath]?.hasTrustDialogAccepted) {
      return current
    }
    return {
      ...current,
      projects: {
        ...current.projects,
        [absolutePath]: {
          ...(current.projects?.[absolutePath] ?? DEFAULT_PROJECT_CONFIG),
          hasTrustDialogAccepted: true,
        },
      },
    }
  })
}

/**
 * Project-scope-aware trust check: defer to the cwd trust-dialog ledger via
 * checkHasTrustDialogAccepted. (No implicit-trust env arm exists — Mercury
 * never runs as a hosted sandbox, and asking is always the safer default.)
 */
export function isProjectScopeTrustAccepted(): boolean {
  return checkHasTrustDialogAccepted()
}

// ──: the permission-posture record ────────────────────────────────────
// When standing consent arms bypass (env row + settings-suppressed dialog),
// nothing durable said so — the field audit had to CROSS-REFERENCE the env
// emission, the settings suppression, and the never-shown trust dialog across
// three files to reconstruct the real posture. The boot decision now writes
// ONE composition record into the project config; a fresh config read alone
// answers "what permission posture does this project run under".

export type PermissionPostureRecord = NonNullable<
  import('./schema.js').ProjectConfig['permissionPosture']
>

/**
 * Record the boot-time permission-posture composition. Called at the ONE
 * dialog decision (interactiveHelpers): whether bypass is armed, what armed
 * it, and whether the consent dialog was shown or suppressed by standing
 * consent. Same-content re-records skip the write;
 * a posture CHANGE (yesterday bypass, today standard) re-stamps honestly.
 * Never throws — posture recording must never block boot.
 */
export function recordPermissionPosture(input: {
  bypassArmed: boolean
  /** The registered skip-permissions env row is truthy this boot. */
  envArmed: boolean
  /** The merged CLI/env flag armed it (classified env-first). */
  flagArmed: boolean
  /** hasSkipDangerousModePermissionPrompt() suppressed the consent dialog. */
  dialogSuppressed: boolean
}): void {
  try {
    const record: PermissionPostureRecord = input.bypassArmed
      ? {
          mode: 'bypass',
          armedBy: input.envArmed
            ? 'env-standing-consent'
            : input.flagArmed
              ? 'cli-flag'
              : 'session-choice',
          consentDialog: input.dialogSuppressed
            ? 'suppressed-by-standing-consent'
            : 'shown-accepted',
          trustDialogAccepted: checkHasTrustDialogAccepted(),
          recordedAtMs: Date.now(),
        }
      : {
          mode: 'standard',
          consentDialog: 'not-required',
          trustDialogAccepted: checkHasTrustDialogAccepted(),
          recordedAtMs: Date.now(),
        }
    saveCurrentProjectConfig(current => {
      const prev = current.permissionPosture
      if (
        prev &&
        prev.mode === record.mode &&
        prev.armedBy === record.armedBy &&
        prev.consentDialog === record.consentDialog &&
        prev.trustDialogAccepted === record.trustDialogAccepted
      ) {
        return current // identical posture ⇒ no rewrite (same-ref skip)
      }
      return { ...current, permissionPosture: record }
    })
  } catch (e) {
    logForDebugging(`[trust] permission-posture record failed (boot continues): ${e}`)
  }
}
