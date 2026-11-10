import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, realpathSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { flagEnv } from '../substrate/flagRegistry.js'
import { registerCleanup } from './cleanupRegistry.js'
import { getMercuryHome } from './envUtils.js'
import { getMercuryTempDir, getScratchpadDir, scratchpadDirFor } from './permissions/filesystem.js'

export { scratchpadDirFor }

const SCRATCHPAD_SEGMENT = 'scratchpad'
const OWNERS_SEGMENT = 'scratchpad-owners'

export interface ScratchpadOwner {
  home: string
  dir: string
  pid: number
  procStart?: string
}

export function scratchpadOwnersDir(): string {
  return join(getMercuryTempDir(), OWNERS_SEGMENT)
}

export function scratchpadOwnerRecord(scratchpadDir: string): string {
  return join(scratchpadOwnersDir(), `${createHash('sha256').update(scratchpadDir).digest('hex').slice(0, 24)}.json`)
}

function scratchpadSegments(dir: string): [string, string] | null {
  const root = getMercuryTempDir()
  if (!isAbsolute(dir)) return null
  const parts = relative(root, dir).split(sep)
  if (parts.length !== 3 || parts[2] !== SCRATCHPAD_SEGMENT || parts[0] === OWNERS_SEGMENT) return null
  if (parts.some(part => part === '' || part === '.' || part === '..') || join(root, parts[0]!, parts[1]!, SCRATCHPAD_SEGMENT) !== dir) return null
  return [parts[0]!, parts[1]!]
}

export function hasSessionScratchpadPath(dir: string): boolean {
  return scratchpadSegments(dir) !== null
}

export function isSessionScratchpad(dir: string): boolean {
  const segments = scratchpadSegments(dir)
  if (segments === null) return false
  try {
    const real = realpathSync.native(dir)
    const expected = join(realpathSync.native(getMercuryTempDir()), segments[0], segments[1], SCRATCHPAD_SEGMENT)
    return process.platform === 'win32' ? real.toLowerCase() === expected.toLowerCase() : real === expected
  } catch {
    return false
  }
}

let ownerRecordedFor: string | null = null
let ownProcStart: string | undefined

function writeOwnerRecord(scratchpadDir: string): void {
  const owner: ScratchpadOwner = { home: getMercuryHome(), dir: scratchpadDir, pid: process.pid, ...(ownProcStart ? { procStart: ownProcStart } : {}) }
  try {
    mkdirSync(scratchpadOwnersDir(), { recursive: true })
    writeFileSync(scratchpadOwnerRecord(scratchpadDir), JSON.stringify(owner))
  } catch {
    return
  }
}

function recordOwner(): void {
  const scratchpadDir = getScratchpadDir()
  if (ownerRecordedFor === scratchpadDir) return
  ownerRecordedFor = scratchpadDir
  writeOwnerRecord(scratchpadDir)
  if (ownProcStart !== undefined) return
  void import('../daemon/ownerWatch.js')
    .then(({ getProcessStartInstantAsync }) => getProcessStartInstantAsync(process.pid))
    .then(procStart => {
      if (!procStart) return
      ownProcStart = procStart
      if (ownerRecordedFor !== null && existsSync(ownerRecordedFor)) writeOwnerRecord(ownerRecordedFor)
    })
    .catch(() => {})
}

export function ensureScratchpadDir(agentId?: string): string {
  const dir = getScratchpadDir(agentId)
  try {
    const made = mkdirSync(dir, { recursive: true })
    if (made !== undefined && getScratchpadDir().startsWith(made)) ownerRecordedFor = null
  } catch {
    return dir
  }
  recordOwner()
  return dir
}

export function scratchpadPromptLine(dir: string, owner: 'session' | 'crewmate' = 'session'): string {
  return `Scratchpad directory: ${dir} — this ${owner}'s own place for temporary files (helper scripts, intermediate results, captures); use it instead of a system temp directory or the project tree. It lies outside the project, so nothing in it reaches git status, and it is swept when the session ends.`
}

type ScratchpadSweep = { swept: true; dir: string } | { swept: false; dir: string; refusal: string }

function removeEmptyDirectory(dir: string): void {
  try {
    rmdirSync(dir)
  } catch {
    return
  }
}

function removeEmptyAncestors(scratchpadDir: string): void {
  if (!hasSessionScratchpadPath(scratchpadDir)) return
  const sessionDir = dirname(scratchpadDir)
  const projectDir = dirname(sessionDir)
  removeEmptyDirectory(sessionDir)
  removeEmptyDirectory(projectDir)
}

export function forgetSweptScratchpad(dir: string): void {
  if (ownerRecordedFor === dir) ownerRecordedFor = null
  try {
    rmSync(scratchpadOwnerRecord(dir), { force: true })
  } catch {
    return
  }
  removeEmptyDirectory(scratchpadOwnersDir())
  removeEmptyAncestors(dir)
}

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
  } catch (error) {
    return { swept: false, dir, refusal: `the sweep failed: ${error instanceof Error ? error.message : String(error)}` }
  }
  forgetSweptScratchpad(dir)
  return { swept: true, dir }
}

export function sweepOwnScratchpad(): ScratchpadSweep {
  return sweepScratchpadDir(getScratchpadDir())
}

function directoriesIn(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => join(dir, entry.name))
  } catch {
    return []
  }
}

function removeOwnEmptyTempDirectories(): void {
  const scratchpadDir = getScratchpadDir()
  for (const dir of directoriesIn(dirname(scratchpadDir))) removeEmptyDirectory(dir)
  if (existsSync(scratchpadDir)) removeEmptyAncestors(scratchpadDir)
  else forgetSweptScratchpad(scratchpadDir)
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
  process.once('exit', removeOwnEmptyTempDirectories)
  return true
}

export function _resetScratchpadSweepForTesting(): void {
  armed = false
}
