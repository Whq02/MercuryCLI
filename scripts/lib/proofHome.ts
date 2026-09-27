import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedFirstRun } from './firstRunSeed.ts'

export interface ProofHomeOptions {
  keep?: boolean
}

export function resolveProofHome(trustedCwds: readonly string[], options: ProofHomeOptions = {}): string {
  process.env.MERCURY_CREDENTIAL_STORE ??= 'file'
  process.env.MERCURY_LOCAL_PROBE_TARGETS ??= 'none'
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
      }
    })
  }
  return home
}
