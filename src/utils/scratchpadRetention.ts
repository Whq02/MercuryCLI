import { existsSync } from 'node:fs'
import { lstat, readdir, readFile, rm, rmdir } from 'node:fs/promises'
import { join } from 'node:path'
import { getMercuryHome } from './envUtils.js'
import {
  forgetSweptScratchpad,
  isSessionScratchpad,
  scratchpadDirFor,
  scratchpadOwnerRecord,
  scratchpadOwnersDir,
  type ScratchpadOwner,
} from './scratchpad.js'

export const SCRATCHPAD_WALK_ENTRIES = 20_000

async function recordedOwners(): Promise<{ owners: ScratchpadOwner[]; stale: string[] }> {
  const home = getMercuryHome()
  const owners: ScratchpadOwner[] = []
  const stale: string[] = []
  let names: string[]
  try {
    names = await readdir(scratchpadOwnersDir())
  } catch {
    return { owners, stale }
  }
  for (const name of names) {
    const path = join(scratchpadOwnersDir(), name)
    let record: Partial<ScratchpadOwner> | null
    try {
      record = JSON.parse(await readFile(path, 'utf8')) as Partial<ScratchpadOwner> | null
    } catch {
      continue
    }
    if (record === null || typeof record !== 'object') continue
    if (typeof record.dir !== 'string' || typeof record.pid !== 'number' || !isSessionScratchpad(record.dir) || scratchpadOwnerRecord(record.dir) !== path) continue
    if (!existsSync(record.dir)) stale.push(path)
    else if (record.home === home) owners.push({ home, dir: record.dir, pid: record.pid, ...(typeof record.procStart === 'string' ? { procStart: record.procStart } : {}) })
  }
  return { owners, stale }
}

async function workerOwners(): Promise<ScratchpadOwner[]> {
  try {
    const { readSessionWorkersSnapshot } = await import('../daemon/concourseWorkers.js')
    const snapshot = readSessionWorkersSnapshot()
    if (snapshot.state !== 'known') return []
    const home = getMercuryHome()
    return Object.values(snapshot.workers)
      .filter(worker => typeof worker.sessionId === 'string' && typeof worker.workspaceId === 'string')
      .map(worker => ({
        home,
        dir: scratchpadDirFor(worker.worktreePath ?? worker.workspaceId, worker.sessionId),
        pid: typeof worker.pid === 'number' ? worker.pid : 0,
        ...(typeof worker.procStart === 'string' ? { procStart: worker.procStart } : {}),
      }))
      .filter(owner => isSessionScratchpad(owner.dir) && existsSync(owner.dir))
  } catch {
    return []
  }
}

export async function readScratchpadCensus(): Promise<{ idle: string[]; staleOwnerRecords: string[] }> {
  const recorded = await recordedOwners()
  const owners = [...recorded.owners, ...(await workerOwners())]
  if (owners.length === 0) return { idle: [], staleOwnerRecords: recorded.stale }
  const { getProcessStartTokensAsync } = await import('../daemon/ownerWatch.js')
  const { tokenBinding } = await import('../daemon/processSweep.js')
  const tokens = await getProcessStartTokensAsync(owners.filter(owner => owner.pid > 1).map(owner => ({ pid: owner.pid, ...(owner.procStart ? { procStart: owner.procStart } : {}) })))
  const held = new Set<string>()
  for (const owner of owners) {
    if (owner.pid <= 1) continue
    const token = tokens.get(owner.pid)
    const gone = token === '' || (typeof token === 'string' && tokenBinding(owner.procStart, token) === 'stranger')
    if (!gone) held.add(owner.dir)
  }
  return { idle: [...new Set(owners.map(owner => owner.dir))].filter(dir => !held.has(dir)), staleOwnerRecords: recorded.stale }
}

export async function idleScratchpads(): Promise<string[]> {
  return (await readScratchpadCensus()).idle
}

export async function forgetStaleOwnerRecords(paths: readonly string[]): Promise<void> {
  for (const path of paths) await rm(path, { force: true }).catch(() => {})
  await rmdir(scratchpadOwnersDir()).catch(() => {})
}

interface ScratchpadFootprint {
  bytes: number
  entries: number
  newestMs: number
  whole: boolean
}

export async function scratchpadFootprint(dir: string, entryBudget: number, stopAt: (seen: ScratchpadFootprint) => boolean = () => false): Promise<ScratchpadFootprint> {
  const seen: ScratchpadFootprint = { bytes: 0, entries: 0, newestMs: 0, whole: false }
  try {
    const top = await lstat(dir)
    if (!top.isDirectory()) return seen
    seen.newestMs = top.mtimeMs
  } catch {
    return seen
  }
  const pending = [dir]
  while (pending.length > 0) {
    const folder = pending.pop()!
    let entries
    try {
      entries = await readdir(folder, { withFileTypes: true })
    } catch {
      return seen
    }
    for (const entry of entries) {
      if (seen.entries >= entryBudget || stopAt(seen)) return seen
      const path = join(folder, entry.name)
      let info
      try {
        info = await lstat(path)
      } catch {
        return seen
      }
      seen.entries++
      seen.newestMs = Math.max(seen.newestMs, info.mtimeMs)
      if (entry.isDirectory()) pending.push(path)
      else seen.bytes += info.size
    }
  }
  seen.whole = !stopAt(seen)
  return seen
}

async function removeIdleScratchpad(dir: string): Promise<boolean> {
  if (!isSessionScratchpad(dir)) return false
  try {
    await rm(dir, { recursive: true, force: true })
  } catch {
    return false
  }
  forgetSweptScratchpad(dir)
  return true
}

export async function sweepIdleScratchpads(): Promise<{ swept: string[]; kept: string[] }> {
  const census = await readScratchpadCensus()
  const swept: string[] = []
  const kept: string[] = []
  for (const dir of census.idle) ((await removeIdleScratchpad(dir)) ? swept : kept).push(dir)
  await forgetStaleOwnerRecords(census.staleOwnerRecords)
  return { swept, kept }
}
