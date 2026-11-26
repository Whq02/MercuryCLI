import { mkdtempSync } from 'node:fs'
import { removeScratch } from './removeScratch.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { seedFirstRun } from './firstRunSeed.ts'
import { keepProofScratch } from './proofScratch.cjs'

export const RECORDER_TERM_PROGRAM = 'kitty'
const RECORDER_TERM_OVERRIDES = [
  'TERM_PROGRAM_VERSION',
  '__CFBundleIdentifier',
  'CURSOR_TRACE_ID',
  'VSCODE_GIT_ASKPASS_MAIN',
  'VisualStudioVersion',
  'TERMINAL_EMULATOR',
] as const

export function pinRecorderTerminal(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  for (const key of RECORDER_TERM_OVERRIDES) delete env[key]
  env.TERM_PROGRAM = RECORDER_TERM_PROGRAM
  return env
}

interface ProofHomeOptions {
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
  if (options.keep) keepProofScratch(home)
  if (!options.keep) {
    process.on('exit', () => {
      try {
        removeScratch(home)
      } catch {
      }
    })
  }
  return home
}
