import { mkdirSync, rmSync } from 'node:fs'
import { basename } from 'node:path'
import { flagEnv } from '../substrate/flagRegistry.js'
import { registerCleanup } from './cleanupRegistry.js'
import { getMercuryTempDir, getScratchpadDir, scratchpadDirFor } from './permissions/filesystem.js'

export { scratchpadDirFor }

export const SCRATCHPAD_SEGMENT = 'scratchpad'

export function ensureScratchpadDir(agentId?: string): string {
  const dir = getScratchpadDir(agentId)
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    return dir
  }
  return dir
}

export function scratchpadPromptLine(dir: string, owner: 'session' | 'agent' = 'session'): string {
  return `Scratchpad directory: ${dir} — this ${owner}'s own place for temporary files (helper scripts, intermediate results, captures); use it instead of a system temp directory or the project tree. It lies outside the project, so nothing in it reaches git status, and it is swept when the session ends.`
}

export type ScratchpadSweep = { swept: true; dir: string } | { swept: false; dir: string; refusal: string }

export function sweepScratchpadDir(dir: string): ScratchpadSweep {
  const root = getMercuryTempDir()
  if (!dir.startsWith(root) || dir.length <= root.length) {
    return { swept: false, dir, refusal: `${dir} is outside the temp root ${root} — nothing swept` }
  }
  if (basename(dir) !== SCRATCHPAD_SEGMENT) {
    return { swept: false, dir, refusal: `${dir} is not a scratchpad directory — nothing swept` }
  }
  try {
    rmSync(dir, { recursive: true, force: true })
    return { swept: true, dir }
  } catch (error) {
    return { swept: false, dir, refusal: `the sweep failed: ${error instanceof Error ? error.message : String(error)}` }
  }
}

export function sweepOwnScratchpad(): ScratchpadSweep {
  return sweepScratchpadDir(getScratchpadDir())
}

let armed = false

export function scratchpadSweptByDaemon(): boolean {
  return flagEnv('MERCURY_CONCOURSE_WORKER') === '1'
}

export function armScratchpadSweep(): boolean {
  if (armed || scratchpadSweptByDaemon()) return false
  armed = true
  registerCleanup(async () => {
    sweepOwnScratchpad()
  })
  return true
}

export function _resetScratchpadSweepForTesting(): void {
  armed = false
}
