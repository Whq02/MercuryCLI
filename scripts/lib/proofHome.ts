// scripts/lib/proofHome.ts — the ONE config home for a proof process
//
//
// A proof launched on its own (`bun run scripts/ui/render-tui.ts …`) used to
// fall back to the foreign ~/.claude home — a directory that belongs to a
// different program — and only "worked" because that directory happened to
// be onboarded and trusted; every boot then wrote sessions and drafts into
// it. The pooled gate hands each suite a seeded scratch home; a proof given
// no home now makes its own the same way.
//
//   MERCURY_CONFIG_DIR set   → that home, as-is (the gate unit's scratch, a
//                              proof's own mkdtemp, an operator's deliberate
//                              pin); seeded absent-only like every home
//   unset                    → a fresh `mercury-proof-home-*` under the OS
//                              temp dir, seeded for the cwd(s) the proof
//                              boots in, exported into
//                              process.env.MERCURY_CONFIG_DIR so every child
//                              this process spawns agrees, removed at exit
//                              unless the proof keeps its fixtures
//
// Once per process: the env pin IS the memo — a later call (a re-entered
// child script, a second module) answers the first call's home and never
// makes a second one. Seeding stays the ONE seeder's (firstRunSeed.ts):
// absent-only, NFC-normalised, trust keyed by the boot cwd.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedFirstRun } from './firstRunSeed.ts'

export interface ProofHomeOptions {
  /** Keep a helper-made home after exit — pass the proof's own debug keep
   *  flag (JOURNEY_KEEP_FIXTURE and the like). An inherited pin is never
   *  removed regardless. */
  keep?: boolean
}

/** The proof's config home: the inherited pin, or a fresh seeded scratch. */
export function resolveProofHome(trustedCwds: readonly string[], options: ProofHomeOptions = {}): string {
  const pinned = process.env.MERCURY_CONFIG_DIR
  if (pinned) {
    const home = pinned.normalize('NFC')
    seedFirstRun(home, [...trustedCwds])
    return home
  }
  const home = mkdtempSync(join(tmpdir(), 'mercury-proof-home-')).normalize('NFC')
  seedFirstRun(home, [...trustedCwds])
  process.env.MERCURY_CONFIG_DIR = home
  if (!options.keep) {
    process.on('exit', () => {
      try {
        rmSync(home, { recursive: true, force: true })
      } catch {
        /* best effort — a leaked scratch home is only temp-dir clutter */
      }
    })
  }
  return home
}
