// ============================================================================
//  TABULA gates — the flag + path seams for the realm-scoped note ledger.
//
//  TABULA is the operator's persistent notepad: per-project (realm dirs ARE
//  project dirs), stored under the Mercury config home — NEVER inside the repo
//  tree (private by construction: a second launch account has a different
//  MERCURY_CONFIG_DIR, so its notes are structurally separate; collaborators
//  never see them in git).
//
//  Gate shapes (the registry-enforced conventions):
//   • MERCURY_TABULA         — default-ON;  '=0' is the ONLY off-switch.
//   • MERCURY_TABULA_MINERVA — default-OFF, explicit '=1' opt-in (it bills one
//     Sonnet-5 call per boot — billing consent is the boot-menu row).
//   • MERCURY_TABULA_DIR     — store-root override (the hermetic seam; render
//     scenarios + proofs pin it so a live operator store is never touched).
//  All three are read LIVE on every call (authority-toggle honesty: a gate
//  that latches env at import lies after /authority or boot-env application).
// ============================================================================

import { join } from 'node:path'
import { getMercuryHome, isEnvTruthy } from '../envUtils.js'
import { sanitizePath } from '../sessionStoragePortable.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

/** Master gate: the notepad substrate (store, commands, board, rail card). */
export function isTabulaEnabled(): boolean {
  if (flagEnv('MERCURY_TABULA') === '0') return false
  return true
}

/** MINERVA — the Sonnet-5 boot curator. Default-OFF (billed); rides the
 *  master gate so a tabula kill silences the curator too. */
export function isMinervaEnabled(): boolean {
  if (!isTabulaEnabled()) return false
  return isEnvTruthy(flagEnv('MERCURY_TABULA_MINERVA'))
}

/** The store root: `<configHome>/tabula`, overridable for hermetic tests. */
export function tabulaRoot(): string {
  const override = flagEnv('MERCURY_TABULA_DIR')
  if (override && override.trim().length > 0) return override
  return join(getMercuryHome(), 'tabula')
}

/** Per-project store dir — the SAME cwd→slug convention the transcript
 *  projects dir uses (sessionStoragePortable.sanitizePath), so a realm's
 *  notes sit beside its sessions conceptually and survive `/clear`. */
export function tabulaProjectDir(projectPath: string): string {
  return join(tabulaRoot(), sanitizePath(projectPath.normalize('NFC')))
}
