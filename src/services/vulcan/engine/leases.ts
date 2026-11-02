import { lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { getSessionId, onSessionSwitch } from '../../../bootstrap/state.js'
import { registerCleanup } from '../../../utils/cleanupRegistry.js'
import { logForDebugging } from '../../../utils/debug.js'
import { procStartToken } from '../../../utils/genericProcessUtils.js'
import { MERCURY_PROJECT_DIR } from '../../../utils/projectConfig.js'
import { holderAlive } from '../../../substrate/pidLock.js'
import { getProcessStartTokenAsync } from '../../../daemon/ownerWatch.js'
import { selectedTreeChanges, type ProofTreeFacts } from './proofDrift.js'

export interface LeaseHolder {
  sessionId: string
  agentId: string
  pid: number
  procStart?: string
}

export interface ProjectLease {
  path: string
  holder: LeaseHolder
  acquiredAt: string
}

export interface LeaseHolderSummary {
  holder: LeaseHolder
  count: number
  under: string
}

export interface ProjectLeaseListing {
  total: number
  holders: LeaseHolderSummary[]
  leases?: ProjectLease[]
}

export type ProjectLeaseTakeResult =
  | { ok: true; held: number; under: string; leases: ProjectLease[] }
  | { ok: false; conflict: ProjectLease; message: string }

export type ProjectLeaseReleaseResult = { ok: true; released: number; paths: string[] }

export const LEASE_DETAIL_LIMIT = 100

const LEASE_FILENAME = 'project-leases.sqlite'
const LEASE_STORAGE_NAMES = [LEASE_FILENAME, `${LEASE_FILENAME}-journal`, `${LEASE_FILENAME}-wal`, `${LEASE_FILENAME}-shm`]
const owned = new Map<string, { root: string; holder: LeaseHolder }>()
const ended = new Set<string>()
const agentLifetimes = new Map<string, { ended: boolean }>()
let closing = false
let hooksInstalled = false
let sessionRevision = 0

function holderKey(root: string, holder: LeaseHolder): string {
  return JSON.stringify([root, holder.sessionId, holder.agentId])
}

function agentKey(holder: LeaseHolder): string {
  return JSON.stringify([holder.sessionId, holder.agentId, holder.pid])
}

export function beginAgentProjectLeases(agentId: string, signal: AbortSignal): () => Promise<void> {
  const holder = projectLeaseHolder(agentId)
  const key = agentKey(holder)
  const lifetime = { ended: false }
  agentLifetimes.set(key, lifetime)
  let ending: Promise<void> | undefined
  const end = (): Promise<void> => {
    signal.removeEventListener('abort', onAbort)
    if (agentLifetimes.get(key) !== lifetime) return Promise.resolve()
    lifetime.ended = true
    ending ??= Promise.all([...owned.values()]
      .filter(entry => sameHolder(entry.holder, holder))
      .map(entry => transaction(entry.root, db => { deleteHolderRows(db, holder) }).catch(error => {
        logForDebugging(`project lease cleanup could not release agent ${agentId}: ${String(error)}`)
      }))).then(() => undefined)
    return ending
  }
  const onAbort = (): void => { void end() }
  if (signal.aborted) onAbort()
  else signal.addEventListener('abort', onAbort, { once: true })
  return end
}
export function projectLeaseHolder(agentId?: string): LeaseHolder {
  return { sessionId: getSessionId(), agentId: agentId ?? 'main', pid: process.pid, procStart: procStartToken(process.pid) }
}

function validateHolder(holder: LeaseHolder): void {
  if (!holder.sessionId || !holder.agentId || !Number.isInteger(holder.pid) || holder.pid <= 1) throw new Error('a lease needs a trusted session, agent and process holder')
}

function sameHolder(a: LeaseHolder, b: LeaseHolder): boolean {
  return a.sessionId === b.sessionId && a.agentId === b.agentId && a.pid === b.pid && (!a.procStart || !b.procStart || a.procStart === b.procStart)
}

function within(root: string, file: string): boolean {
  const rel = path.relative(root, file)
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
}

function caseInsensitiveProject(root: string): boolean {
  if (process.platform === 'win32') return true
  const alternate = root.replace(/[A-Za-z]/g, letter => letter === letter.toLowerCase() ? letter.toUpperCase() : letter.toLowerCase())
  if (alternate === root) return false
  try {
    const original = statSync(root)
    const other = statSync(alternate)
    return original.dev === other.dev && original.ino === other.ino
  } catch {
    return false
  }
}

function canonicalProjectLeasePath(projectRoot: string, input: string): string {
  const root = realpathSync(projectRoot)
  if (typeof input !== 'string' || !input.trim() || input.includes('\0') || /[*?\[\]{}]/.test(input)) throw new Error('lease paths name project files or directories, not globs')
  const value = input.replace(/^res:\/\//, '').replace(/\\/g, '/')
  const wantsDirectory = value.length > 1 && value.endsWith('/')
  if (value.split('/').includes('..') || (/^[A-Za-z]:/.test(value) && process.platform !== 'win32')) throw new Error(`lease path is outside the project: ${input}`)
  const absolute = path.resolve(root, value)
  if (!within(root, absolute) || absolute === root) throw new Error(`lease path is outside the project: ${input}`)
  let current = root
  for (const part of path.relative(root, absolute).split(path.sep)) {
    current = path.join(current, part)
    try {
      lstatSync(current)
      current = realpathSync(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      try {
        if (lstatSync(current).isSymbolicLink()) throw new Error(`lease path has a dangling symlink: ${input}`)
      } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code !== 'ENOENT') throw missing
      }
    }
    if (!within(root, current)) throw new Error(`lease path escapes the project through a symlink: ${input}`)
  }
  let directory = wantsDirectory
  try {
    const target = lstatSync(current)
    if (target.isDirectory()) directory = true
    else if (wantsDirectory) throw new Error(`lease path names a file, not a directory: ${input}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const relative = path.relative(root, current).split(path.sep).join('/')
  const rel = (caseInsensitiveProject(root) ? relative.toLowerCase() : relative) + (directory ? '/' : '')
  if (LEASE_STORAGE_NAMES.some(name => rel === `${MERCURY_PROJECT_DIR}/${name}`)) throw new Error(`${input} is the lease store itself and cannot be leased`)
  if (rel === `${MERCURY_PROJECT_DIR}/`) throw new Error(`${input} holds the lease store and cannot be leased`)
  return rel
}

function isDirectoryLease(lease: string): boolean {
  return lease.endsWith('/')
}

function coveringDirectories(lease: string): string[] {
  const parts = (isDirectoryLease(lease) ? lease.slice(0, -1) : lease).split('/')
  const dirs: string[] = []
  for (let i = 1; i < parts.length; i++) dirs.push(`${parts.slice(0, i).join('/')}/`)
  return dirs
}

function directoryUpperBound(directory: string): string {
  return `${directory.slice(0, -1)}0`
}

function commonDirectory(first: string, last: string): string {
  let i = 0
  while (i < first.length && i < last.length && first[i] === last[i]) i++
  const shared = first.slice(0, i)
  const cut = isDirectoryLease(first) && first === last ? shared.length : shared.lastIndexOf('/') + 1
  return shared.slice(0, cut)
}

function leaseFile(projectRoot: string): string {
  const root = realpathSync(projectRoot)
  const dir = path.join(root, MERCURY_PROJECT_DIR)
  try {
    const st = lstatSync(dir)
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error('project .mercury must be a real directory')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    mkdirSync(dir, { mode: 0o700, recursive: true })
    const made = lstatSync(dir)
    if (made.isSymbolicLink() || !made.isDirectory()) throw new Error('project lease directory was redirected')
  }
  const file = path.join(dir, LEASE_FILENAME)
  for (const name of LEASE_STORAGE_NAMES) {
    const candidate = path.join(dir, name)
    try {
      const st = lstatSync(candidate)
      if (st.isSymbolicLink() || !st.isFile() || st.nlink > 1) throw new Error('project lease storage must be a regular file with one link')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return file
}

type SqlValue = string | number | null
type LeaseRow = Record<string, unknown>
type LeaseStatement = {
  all(...values: SqlValue[]): LeaseRow[]
  get(...values: SqlValue[]): LeaseRow | null | undefined
  run(...values: SqlValue[]): unknown
}
type LeaseDatabase = {
  exec(sql: string): unknown
  prepare(sql: string): LeaseStatement
  close(): unknown
}

type HolderRow = { session: string; agent: string; pid: number; proc_start: string | null }

const HOLDER_COLUMNS: Record<string, string> = { session: 'TEXT', agent: 'TEXT', pid: 'INTEGER', proc_start: 'TEXT' }
const READABLE_HOLDER = "json_valid(record) AND json_type(record, '$.holder.sessionId') = 'text' AND json_extract(record, '$.holder.sessionId') <> '' AND json_type(record, '$.holder.agentId') = 'text' AND json_extract(record, '$.holder.agentId') <> '' AND json_type(record, '$.holder.pid') = 'integer' AND json_extract(record, '$.holder.pid') > 1"

function migrate(db: LeaseDatabase): void {
  db.exec('BEGIN IMMEDIATE')
  try {
    db.exec('CREATE TABLE IF NOT EXISTS leases (path TEXT PRIMARY KEY, record TEXT NOT NULL)')
    const present = new Set(db.prepare('PRAGMA table_info(leases)').all().map(row => String(row.name)))
    for (const [column, type] of Object.entries(HOLDER_COLUMNS)) if (!present.has(column)) db.exec(`ALTER TABLE leases ADD COLUMN ${column} ${type}`)
    db.exec('CREATE INDEX IF NOT EXISTS leases_holder_path ON leases (session, agent, pid, proc_start, path)')
    db.exec(`UPDATE leases SET session = json_extract(record, '$.holder.sessionId'), agent = json_extract(record, '$.holder.agentId'), pid = json_extract(record, '$.holder.pid'), proc_start = json_extract(record, '$.holder.procStart') WHERE session IS NULL AND ${READABLE_HOLDER}`)
    db.exec('DELETE FROM leases WHERE session IS NULL')
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function holderOf(row: HolderRow): LeaseHolder {
  return { sessionId: row.session, agentId: row.agent, pid: row.pid, ...(row.proc_start ? { procStart: row.proc_start } : {}) }
}

function distinctHolders(db: LeaseDatabase): HolderRow[] {
  return db.prepare('SELECT session, agent, pid, proc_start FROM leases GROUP BY session, agent, pid, proc_start').all() as HolderRow[]
}

function holderWhere(holder: LeaseHolder): { sql: string; values: SqlValue[] } {
  const procStart = holder.procStart ?? null
  return { sql: '(session = ? AND agent = ? AND pid = ? AND (proc_start IS NULL OR ? IS NULL OR proc_start = ?))', values: [holder.sessionId, holder.agentId, holder.pid, procStart, procStart] }
}

function deleteHolderRows(db: LeaseDatabase, holder: LeaseHolder): number {
  const where = holderWhere(holder)
  const count = Number(db.prepare(`SELECT COUNT(*) AS count FROM leases WHERE ${where.sql}`).get(...where.values)?.count ?? 0)
  if (count > 0) db.prepare(`DELETE FROM leases WHERE ${where.sql}`).run(...where.values)
  return count
}

function parseLease(row: LeaseRow): ProjectLease {
  return JSON.parse(String(row.record)) as ProjectLease
}

function leaseDetail(db: LeaseDatabase, where: string, values: SqlValue[]): ProjectLease[] {
  return db.prepare(`SELECT record FROM leases${where ? ` WHERE ${where}` : ''} ORDER BY path LIMIT ${LEASE_DETAIL_LIMIT}`).all(...values).map(parseLease)
}

function summaries(db: LeaseDatabase, where: string, values: SqlValue[]): LeaseHolderSummary[] {
  return db.prepare(`SELECT session, agent, pid, proc_start, COUNT(*) AS count, MIN(path) AS first, MAX(path) AS last FROM leases${where ? ` WHERE ${where}` : ''} GROUP BY session, agent, pid, proc_start ORDER BY count DESC, session, agent, pid`).all(...values)
    .map(row => ({ holder: holderOf(row as unknown as HolderRow), count: Number(row.count), under: commonDirectory(String(row.first), String(row.last)) }))
}

type Conflict = { lease: ProjectLease; message: string }

function firstConflict(db: LeaseDatabase, resolved: readonly string[], holder: LeaseHolder): Conflict | null {
  const exact = new Set<string>()
  const ranges: [string, string][] = []
  for (const lease of resolved) {
    exact.add(lease)
    for (const dir of coveringDirectories(lease)) exact.add(dir)
    if (isDirectoryLease(lease)) ranges.push([lease, directoryUpperBound(lease)])
  }
  const own = holderWhere(holder)
  const describe = (row: LeaseRow): Conflict => {
    const lease = parseLease(row)
    const covered = resolved.find(wanted => wanted !== lease.path && coveringDirectories(wanted).includes(lease.path))
    const subject = covered ? `${covered} is under ${lease.path},` : `${lease.path} is`
    return { lease, message: `${subject} leased by session ${lease.holder.sessionId}, agent ${lease.holder.agentId} (pid ${lease.holder.pid})` }
  }
  const direct = db.prepare(`SELECT path, record FROM leases WHERE path IN (SELECT value FROM json_each(?)) AND NOT ${own.sql} ORDER BY path LIMIT 1`).get(JSON.stringify([...exact]), ...own.values)
  if (direct) return describe(direct)
  if (ranges.length === 0) return null
  const under = db.prepare(`SELECT l.path AS path, l.record AS record FROM json_each(?) AS d JOIN leases AS l ON l.path >= json_extract(d.value, '$[0]') AND l.path < json_extract(d.value, '$[1]') WHERE NOT ${own.sql} ORDER BY l.path LIMIT 1`).get(JSON.stringify(ranges), ...own.values)
  return under ? describe(under) : null
}

async function openLeaseDatabase(file: string): Promise<LeaseDatabase> {
  const bunSqlite = 'bun:sqlite'
  const db: LeaseDatabase = process.versions.bun
    ? new ((await import(bunSqlite)) as { Database: new (file: string) => LeaseDatabase }).Database(file)
    : new (await import('node:sqlite')).DatabaseSync(file)
  db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = DELETE; PRAGMA temp_store = MEMORY')
  return db
}

async function transaction<T>(projectRoot: string, change: (db: LeaseDatabase) => T): Promise<T> {
  const root = realpathSync(projectRoot)
  const db = await openLeaseDatabase(leaseFile(root))
  try {
    migrate(db)
    const tokens = new Map<number, string | null>()
    for (const row of distinctHolders(db)) {
      if (row.proc_start && !tokens.has(row.pid)) tokens.set(row.pid, procStartToken(row.pid) ?? await getProcessStartTokenAsync(row.pid))
    }
    db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of distinctHolders(db)) {
        const holder = holderOf(row)
        const alive = holderAlive({ owner: holder.sessionId, pid: holder.pid, procStart: holder.procStart, acquiredAt: 0 }, 'assume-alive', tokens.get(holder.pid) ?? null)
        const sessionEnded = holder.pid === process.pid && (ended.has(holderKey(root, holder)) || agentLifetimes.get(agentKey(holder))?.ended === true)
        if (!alive || sessionEnded) db.prepare('DELETE FROM leases WHERE session = ? AND agent = ? AND pid = ? AND proc_start IS ?').run(row.session, row.agent, row.pid, row.proc_start)
      }
      const result = change(db)
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } finally {
    try {
      db.close()
    } catch (error) {
      logForDebugging(`project lease store did not close cleanly: ${String(error)}`)
    }
  }
}

function remember(root: string, holder: LeaseHolder): void {
  if (holder.pid !== process.pid) return
  const key = holderKey(root, holder)
  owned.set(key, { root, holder })
  if (hooksInstalled) return
  hooksInstalled = true
  registerCleanup(async () => {
    closing = true
    await Promise.all([...owned.values()].map(entry => releaseProjectLeases(entry.root, entry.holder).catch(error => {
      logForDebugging(`project lease cleanup could not release ${entry.root} at exit: ${String(error)}`)
    })))
  })
  onSessionSwitch(id => {
    sessionRevision++
    for (const [key, entry] of owned) {
      if (entry.holder.sessionId === id) {
        ended.delete(key)
        continue
      }
      ended.add(key)
      void releaseProjectLeases(entry.root, entry.holder).catch(error => logForDebugging(`project lease cleanup could not release the ended session: ${String(error)}`))
    }
  })
}

export async function takeProjectLeases(projectRoot: string, paths: readonly string[], holder: LeaseHolder = projectLeaseHolder()): Promise<ProjectLeaseTakeResult> {
  validateHolder(holder)
  const root = realpathSync(projectRoot)
  const resolved = [...new Set(paths.map(file => canonicalProjectLeasePath(root, file)))]
  const identity = { ...holder }
  remember(root, identity)
  const lifetime = agentLifetimes.get(agentKey(identity))
  const sessionId = getSessionId()
  const revision = sessionRevision
  const liveToken = procStartToken(identity.pid) ?? await getProcessStartTokenAsync(identity.pid)
  identity.procStart ??= liveToken || undefined
  if (!holderAlive({ owner: identity.sessionId, pid: identity.pid, procStart: identity.procStart, acquiredAt: 0 }, 'assume-alive', liveToken)) throw new Error('the lease holder process has ended')
  return transaction<ProjectLeaseTakeResult>(root, db => {
    if (identity.pid === process.pid && (closing || ended.has(holderKey(root, identity)) || revision !== sessionRevision || sessionId !== getSessionId())) throw new Error('the lease holder session has ended')
    if (identity.pid === process.pid && (lifetime?.ended || agentLifetimes.get(agentKey(identity)) !== lifetime)) throw new Error('the lease holder agent has ended')
    const conflict = firstConflict(db, resolved, identity)
    if (conflict) return { ok: false, conflict: conflict.lease, message: conflict.message }
    const acquiredAt = new Date().toISOString()
    const insert = db.prepare('INSERT OR IGNORE INTO leases (path, record, session, agent, pid, proc_start) VALUES (?, ?, ?, ?, ?, ?)')
    for (const file of resolved) insert.run(file, JSON.stringify({ path: file, holder: identity, acquiredAt }), identity.sessionId, identity.agentId, identity.pid, identity.procStart ?? null)
    const own = holderWhere(identity)
    const totals = db.prepare(`SELECT COUNT(*) AS count, MIN(path) AS first, MAX(path) AS last FROM leases WHERE ${own.sql}`).get(...own.values)
    return { ok: true, held: Number(totals?.count ?? 0), under: totals?.first ? commonDirectory(String(totals.first), String(totals.last)) : '', leases: leaseDetail(db, own.sql, own.values) }
  })
}

export async function releaseProjectLeases(projectRoot: string, holder: LeaseHolder = projectLeaseHolder(), paths?: readonly string[], options: { agentId?: string; all?: boolean } = {}): Promise<ProjectLeaseReleaseResult> {
  validateHolder(holder)
  if (options.all && options.agentId !== undefined) throw new Error('choose agentId or all, not both')
  if (options.agentId !== undefined && !options.agentId.trim()) throw new Error('agentId must name an agent')
  const override = options.all === true || options.agentId !== undefined
  if (override && holder.agentId !== 'main') throw new Error('only the session director can release another agent’s leases')
  const resolved = paths ? [...new Set(paths.map(file => canonicalProjectLeasePath(projectRoot, file)))] : null
  const selected = override
    ? (options.all === true ? { sql: '(session = ?)', values: [holder.sessionId] as SqlValue[] } : { sql: '(session = ? AND agent = ?)', values: [holder.sessionId, options.agentId ?? ''] as SqlValue[] })
    : holderWhere(holder)
  return transaction<ProjectLeaseReleaseResult>(projectRoot, db => {
    if (override) {
      const foreign = resolved
        ? db.prepare(`SELECT record FROM leases WHERE path IN (SELECT value FROM json_each(?)) AND NOT ${selected.sql} ORDER BY path LIMIT 1`).get(JSON.stringify(resolved), ...selected.values)
        : options.agentId !== undefined && Number(db.prepare(`SELECT COUNT(*) AS count FROM leases WHERE ${selected.sql}`).get(...selected.values)?.count ?? 0) === 0
          ? db.prepare('SELECT record FROM leases WHERE agent = ? AND session <> ? ORDER BY path LIMIT 1').get(options.agentId, holder.sessionId)
          : null
      if (foreign) {
        const conflict = parseLease(foreign)
        throw new Error(`${conflict.path} is leased by session ${conflict.holder.sessionId}, agent ${conflict.holder.agentId} (pid ${conflict.holder.pid})`)
      }
    }
    const where = resolved ? `${selected.sql} AND path IN (SELECT value FROM json_each(?))` : selected.sql
    const values = resolved ? [...selected.values, JSON.stringify(resolved)] : selected.values
    const released = Number(db.prepare(`SELECT COUNT(*) AS count FROM leases WHERE ${where}`).get(...values)?.count ?? 0)
    if (released === 0) return { ok: true, released: 0, paths: [] }
    const shown = db.prepare(`SELECT path FROM leases WHERE ${where} ORDER BY path LIMIT ${LEASE_DETAIL_LIMIT}`).all(...values).map(row => String(row.path))
    db.prepare(`DELETE FROM leases WHERE ${where}`).run(...values)
    return { ok: true, released, paths: shown }
  })
}

export async function listProjectLeases(projectRoot: string, filter?: { sessionId: string; agentId: string }): Promise<ProjectLease[]> {
  return transaction(projectRoot, db => (filter
    ? db.prepare('SELECT record FROM leases WHERE session = ? AND agent = ? ORDER BY path').all(filter.sessionId, filter.agentId)
    : db.prepare('SELECT record FROM leases ORDER BY path').all()).map(parseLease))
}

export async function describeProjectLeases(projectRoot: string, filter: { sessionId?: string; agentId?: string } = {}): Promise<ProjectLeaseListing> {
  const agentId = filter.agentId?.trim()
  const sessionId = filter.sessionId?.trim() || getSessionId()
  return transaction<ProjectLeaseListing>(projectRoot, db => {
    const holders = summaries(db, '', [])
    const total = holders.reduce((sum, row) => sum + row.count, 0)
    if (agentId) return { total, holders, leases: leaseDetail(db, 'session = ? AND agent = ?', [sessionId, agentId]) }
    return total <= LEASE_DETAIL_LIMIT ? { total, holders, leases: leaseDetail(db, '', []) } : { total, holders }
  })
}

export async function engineLeaseRefusal(projectRoot: string, facts: ProofTreeFacts, holder: LeaseHolder = projectLeaseHolder()): Promise<string | null> {
  validateHolder(holder)
  const changes = selectedTreeChanges(facts)
  if (changes.files.length === 0) return null
  const files = [...new Set(changes.files.map(file => canonicalProjectLeasePath(projectRoot, file)))]
  const conflict = await transaction(projectRoot, db => firstConflict(db, files, holder))
  return conflict ? conflict.message : null
}
