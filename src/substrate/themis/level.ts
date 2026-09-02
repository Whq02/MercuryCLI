import { flagEnv } from '../flagRegistry.js'
/* ============================================================================
   THEMIS — the deterministic control plane (paper-triad Slice A).

   Methodology adapted from "A Deterministic Control Plane for LLM Coding
   Agents" (Madatha, arXiv:2606.26924 — ref impl Rel(AI)Build). No code
   vendored; TS re-implementation against Mercury's own seams. The paper's
   thesis IS the module contract: every enforcement here is deterministic
   (hash, regex, state machine, set arithmetic) — an LLM may produce
   candidates, it never checks them ("a non-deterministic component cannot
   serve as a trustworthy control for another non-deterministic component").

   This file owns the ONE enforcement level the whole plane keys off:

     enforce (THE DEFAULT — operator ruling) — blocklist hits are
             denied at the universal execution gate
             (services/tools/toolExecution.ts, the capability-kill seam) with
             a typed refusal, never a prompt. Measured imperceptible on real
             tool rounds (scripts/themis/bench-gate-overhead.ts: 292ns/call
             typical, +0.01ms on a 10.2ms real Bash round), which is what
             graduated it from the workflow-lane posture to the default.
     warn    — every signal (blocklist hit, lockfile mismatch, drift) writes
             an audit row and surfaces, but NOTHING is denied. The one-line
             de-escalation for an operator whose legitimate commands match
             the blocklist shapes (git config --global writes, npx -y, …).
     off     (explicit 'off' or '0' only) — byte-identical: no checks run,
             no files are written, `.mercury/themis/` is never created.

   Unset or unrecognized values resolve to the DEFAULT: a typo'd level must
   never silently disarm the trust plane (fail-safe over fail-open). The env
   is read LIVE per call (the authority-toggles invariant: a toggle is only
   honest if the gate re-reads env). Registered in flagRegistry as a
   `default-on` gate whose value carries the level — themisLevel() is the
   ONE reader ('off'/'0' disarm; flagEnabled() is not consulted).
   ============================================================================ */


export type ThemisLevel = 'off' | 'warn' | 'enforce'

/** The ruled default: see the header + the bench for the why. */
export const THEMIS_DEFAULT_LEVEL: ThemisLevel = 'enforce'

export function themisLevel(): ThemisLevel {
  const raw = flagEnv('MERCURY_THEMIS')
  if (raw === 'warn') return 'warn'
  if (raw === 'enforce') return 'enforce'
  // The explicit opt-out spellings — the only path to a dormant plane.
  if (raw === 'off' || raw === '0') return 'off'
  // Unset or junk ⇒ the default (junk-to-off would be a silent disarm).
  return THEMIS_DEFAULT_LEVEL
}

/** True when any THEMIS machinery may run (write audit rows, verify, check). */
export function themisActive(): boolean {
  return themisLevel() !== 'off'
}
