import { closeSync, existsSync, openSync, readSync, readdirSync, rmdirSync, unlinkSync, type Dirent } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { getSessionId } from '../../../bootstrap/state.js'
import { flagEnv } from '../../../substrate/flagRegistry.js'
import { logForDebugging } from '../../../utils/debug.js'
import { getMercuryHome } from '../../../utils/envUtils.js'
import { isProcessRunning } from '../../../utils/genericProcessUtils.js'

export const PREFIX_LEDGER_FILE = 'prefix-ledger.json'
export const PREFIX_RECORD_RETENTION_DAYS_DEFAULT = 30
const DAY_MS = 24 * 60 * 60 * 1000
const RECORD_HEAD_BYTES = 4096
const STAGING_FILE = /^prefix-ledger\.json\.(\d+)\.tmp$/
const REGISTRY_FILE = /^(\d+)\.json$/

export function sessionSegment(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_.:-]+/g, '-') || 'session'
}

export function sessionRecordsRoot(home: string = getMercuryHome()): string {
  return join(home, 'sessions')
}

export function prefixLedgerPath(sessionId: string = String(getSessionId()), home: string = getMercuryHome()): string {
  return join(sessionRecordsRoot(home), sessionSegment(sessionId), PREFIX_LEDGER_FILE)
}

export function prefixRecordRetentionDays(): number {
  const raw = flagEnv('MERCURY_PREFIX_RECORD_RETENTION_DAYS')
  if (raw === undefined || !/^\d+$/.test(raw.trim())) return PREFIX_RECORD_RETENTION_DAYS_DEFAULT
  const parsed = Number(raw.trim())
  return parsed >= 1 ? parsed : PREFIX_RECORD_RETENTION_DAYS_DEFAULT
}

export interface PrefixRecordRemoval {
  record: boolean
  folder: boolean
}

function isMissing(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 'ENOENT'
}

function removePrefixRecordIn(folder: string): PrefixRecordRemoval {
  const removal: PrefixRecordRemoval = { record: false, folder: false }
  const path = join(folder, PREFIX_LEDGER_FILE)
  try {
    unlinkSync(path)
    removal.record = true
  } catch (error) {
    if (!isMissing(error)) logForDebugging(`preserved thinking: the prefix record beside the session could not be removed (${String(error)})`, { level: 'warn' })
  }
  try {
    for (const name of readdirSync(folder)) {
      const staged = STAGING_FILE.exec(name)
      if (staged === null || isProcessRunning(Number(staged[1]))) continue
      try {
        unlinkSync(join(folder, name))
      } catch {
      }
    }
    rmdirSync(folder)
    removal.folder = true
  } catch {
  }
  return removal
}

export function removePrefixRecord(sessionId: string, home: string = getMercuryHome()): PrefixRecordRemoval {
  return removePrefixRecordIn(join(sessionRecordsRoot(home), sessionSegment(sessionId)))
}

function recordTranscriptStamp(path: string): string | null {
  let fd: number | null = null
  try {
    fd = openSync(path, 'r')
    const buffer = Buffer.alloc(RECORD_HEAD_BYTES)
    const length = readSync(fd, buffer, 0, RECORD_HEAD_BYTES, 0)
    const match = /"transcript":"((?:[^"\\]|\\.)*)"/.exec(buffer.subarray(0, length).toString('utf8'))
    return match === null ? null : (JSON.parse(`"${match[1]}"`) as string)
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

export interface PrefixRecordSweepOptions {
  home?: string
  liveSessionIds?: Iterable<string>
  now?: number
}

export interface PrefixRecordSweepReceipt {
  seen: number
  kept: number
  live: number
  expired: string[]
  orphaned: string[]
}

export async function sweepPrefixRecords(options: PrefixRecordSweepOptions = {}): Promise<PrefixRecordSweepReceipt> {
  const root = sessionRecordsRoot(options.home ?? getMercuryHome())
  const receipt: PrefixRecordSweepReceipt = { seen: 0, kept: 0, live: 0, expired: [], orphaned: [] }
  let entries: Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return receipt
  }
  const live = new Set<string>()
  try {
    live.add(sessionSegment(String(getSessionId())))
  } catch {
  }
  for (const id of options.liveSessionIds ?? []) live.add(sessionSegment(id))
  for (const entry of entries) {
    const registered = REGISTRY_FILE.exec(entry.name)
    if (registered === null || !entry.isFile()) continue
    const pid = Number(registered[1])
    if (pid !== process.pid && !isProcessRunning(pid)) continue
    try {
      const record = JSON.parse(await readFile(join(root, entry.name), 'utf8')) as { sessionId?: unknown } | null
      if (typeof record?.sessionId === 'string') live.add(sessionSegment(record.sessionId))
    } catch {
    }
  }
  const now = options.now ?? Date.now()
  const retentionDays = prefixRecordRetentionDays()
  const retentionMs = retentionDays * DAY_MS
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const folder = join(root, entry.name)
    const path = join(folder, PREFIX_LEDGER_FILE)
    let age: number
    try {
      age = now - (await stat(path)).mtimeMs
    } catch {
      continue
    }
    receipt.seen++
    if (live.has(entry.name)) {
      receipt.live++
      receipt.kept++
      continue
    }
    if (age > retentionMs) {
      removePrefixRecordIn(folder)
      receipt.expired.push(entry.name)
      continue
    }
    const stamp = recordTranscriptStamp(path)
    if (stamp !== null && !existsSync(stamp)) {
      removePrefixRecordIn(folder)
      receipt.orphaned.push(entry.name)
      continue
    }
    receipt.kept++
  }
  if (receipt.expired.length > 0 || receipt.orphaned.length > 0) {
    logForDebugging(`preserved thinking: the boot sweep removed ${receipt.expired.length} prefix record(s) older than ${retentionDays} days and ${receipt.orphaned.length} whose transcript is gone; ${receipt.kept} kept, ${receipt.live} of them live`)
  }
  return receipt
}
