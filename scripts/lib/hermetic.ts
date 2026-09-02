// ============================================================================
//  scripts/lib/hermetic.ts — the ONE prover preamble (ambient-state law).
//
//  A proof must never touch the operator's real home: the config-home
//  stores are file-backed and cross-process watched, so a proof that
//  resolves the real home writes fixture rows straight into the operator's
//  LIVE surfaces (the phantom consent-card incident — three provers swept
//  the env AFTER pinning their scratch home, deleting their own pin, which
//  nets to the real home).
//
//  Import this module FIRST — before any src/ import — so its body runs ahead
//  of every module that could read the environment:
//    1. SWEEP: every home spelling an ambient shell could carry is cleared
//       (both the MERCURY_* and the legacy forms).
//    2. PIN: a fresh per-run scratch home is minted and pinned LAST, so no
//       later line can undo it. Everything downstream — getMercuryHome, the
//       store paths, operatorPrincipal's seed — derives from the scratch
//       home; the operator's real identity is unreachable by construction.
// ============================================================================

import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

for (const name of ['MERCURY_CONFIG_DIR', 'MERCURY_HOME']) {
  delete process.env[name]
}

/** The per-run scratch home this proof lives in. Hand it to child processes
 *  that must SHARE the proof's home; give a child its own mkdtemp when the
 *  leg needs a foreign filesystem view. */
export const proofHome: string = mkdtempSync(join(tmpdir(), 'proof-home-'))
process.env.MERCURY_CONFIG_DIR = proofHome
// A proof never touches the operator's OS keychain: the file-backed
// credential store rides beside the scratch home (the one rule every
// keychain spawn honours). Absent-only, so a proof of the keychain backend
// itself may pin its own value first.
process.env.MERCURY_CREDENTIAL_STORE ??= 'file'
