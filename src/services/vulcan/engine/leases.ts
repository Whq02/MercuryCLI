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

interface ProjectLease {
  path: string
  holder: LeaseHolder
  acquiredAt: string
}

type ProjectLeaseTakeResult =
  | { ok: true; leases: ProjectLease[] }
  | { ok: false; conflict: ProjectLease; message: string }

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
      .map(entry => transaction(entry.root, () => undefined).catch(error => {
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
  if (typeof input !== 'string' || !input.trim() || input.includes('\0') || /[*?\[\]{}]/.test(input)) throw new Error('lease paths must be exact project files, not globs')
  const value = input.replace(/^res:\/\//, '').replace(/\\/g, '/')
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
  try {
    if (lstatSync(current).isDirectory()) throw new Error(`lease paths name files, not directories: ${input}`)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const relative = path.relative(root, current).split(path.sep).join('/')
  const rel = caseInsensitiveProject(root) ? relative.toLowerCase() : relative
  if (LEASE_STORAGE_NAMES.some(name => rel === `${MERCURY_PROJECT_DIR}/${name}`)) throw new Error(`${input} is the lease store itself and cannot be leased`)
  return rel
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

type LeaseDatabase = {
  exec(sql: string): unknown
  prepare(sql: string): { all(): Record<string, unknown>[]; run(...values: string[]): unknown }
  close(): unknown
}

async function transaction<T>(projectRoot: string, change: (leases: ProjectLease[]) => T): Promise<T> {
  const file = leaseFile(projectRoot)
  const bunSqlite = 'bun:sqlite'
  const db: LeaseDatabase = process.versions.bun
    ? new ((await import(bunSqlite)) as { Database: new (file: string) => LeaseDatabase }).Database(file)
    : new (await import('node:sqlite')).DatabaseSync(file)
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = DELETE; CREATE TABLE IF NOT EXISTS leases (path TEXT PRIMARY KEY, record TEXT NOT NULL)')
    const starts = new Map<string, string | null>()
    for (const row of db.prepare('SELECT record FROM leases').all()) {
      const raw = String((row as { record: unknown }).record)
      const lease = JSON.parse(raw) as ProjectLease
      validateHolder(lease.holder)
      if (lease.holder.procStart) starts.set(raw, procStartToken(lease.holder.pid) ?? await getProcessStartTokenAsync(lease.holder.pid))
    }
    db.exec('BEGIN IMMEDIATE')
    try {
      const rows = db.prepare('SELECT record FROM leases ORDER BY path').all()
      const leases = rows.flatMap(row => {
        const raw = String((row as { record: unknown }).record)
        const lease = JSON.parse(raw) as ProjectLease
        validateHolder(lease.holder)
        const alive = holderAlive({ owner: lease.holder.sessionId, pid: lease.holder.pid, procStart: lease.holder.procStart, acquiredAt: 0 }, 'assume-alive', starts.get(raw) ?? null)
        const sessionEnded = lease.holder.pid === process.pid && (ended.has(holderKey(realpathSync(projectRoot), lease.holder)) || agentLifetimes.get(agentKey(lease.holder))?.ended === true)
        return alive && !sessionEnded ? [lease] : []
      })
      const result = change(leases)
      db.exec('DELETE FROM leases')
      const insert = db.prepare('INSERT INTO leases (path, record) VALUES (?, ?)')
      for (const lease of leases) insert.run(lease.path, JSON.stringify(lease))
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  } finally {
    db.close()
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
    await Promise.all([...owned.values()].map(entry => releaseProjectLeases(entry.root, entry.holder)))
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
  return transaction<ProjectLeaseTakeResult>(root, leases => {
    if (identity.pid === process.pid && (closing || ended.has(holderKey(root, identity)) || revision !== sessionRevision || sessionId !== getSessionId())) throw new Error('the lease holder session has ended')
    if (identity.pid === process.pid && (lifetime?.ended || agentLifetimes.get(agentKey(identity)) !== lifetime)) throw new Error('the lease holder agent has ended')
    const conflict = leases.find(lease => resolved.includes(lease.path) && !sameHolder(lease.holder, identity))
    if (conflict) return { ok: false, conflict, message: `${conflict.path} is leased by session ${conflict.holder.sessionId}, agent ${conflict.holder.agentId} (pid ${conflict.holder.pid})` }
    const acquiredAt = new Date().toISOString()
    for (const file of resolved) if (!leases.some(lease => lease.path === file)) leases.push({ path: file, holder: identity, acquiredAt })
    return { ok: true, leases: leases.filter(lease => sameHolder(lease.holder, identity)) }
  })
}

export async function releaseProjectLeases(projectRoot: string, holder: LeaseHolder = projectLeaseHolder(), paths?: readonly string[], options: { agentId?: string; all?: boolean } = {}): Promise<{ ok: true; released: string[] }> {
  validateHolder(holder)
  if (options.all && options.agentId !== undefined) throw new Error('choose agentId or all, not both')
  if (options.agentId !== undefined && !options.agentId.trim()) throw new Error('agentId must name an agent')
  const override = options.all === true || options.agentId !== undefined
  if (override && holder.agentId !== 'main') throw new Error('only the session director can release another agent’s leases')
  const resolved = paths ? new Set(paths.map(file => canonicalProjectLeasePath(projectRoot, file))) : null
  const selected = (lease: ProjectLease): boolean => override
    ? lease.holder.sessionId === holder.sessionId && (options.all === true || lease.holder.agentId === options.agentId)
    : sameHolder(lease.holder, holder)
  return transaction<{ ok: true; released: string[] }>(projectRoot, leases => {
    const conflict = override ? leases.find(lease => !selected(lease) && (resolved
      ? resolved.has(lease.path)
      : options.agentId !== undefined && lease.holder.agentId === options.agentId && !leases.some(selected))) : undefined
    if (conflict) throw new Error(`${conflict.path} is leased by session ${conflict.holder.sessionId}, agent ${conflict.holder.agentId} (pid ${conflict.holder.pid})`)
    const released: string[] = []
    for (let i = leases.length - 1; i >= 0; i--) {
      if (selected(leases[i]) && (!resolved || resolved.has(leases[i].path))) released.push(leases.splice(i, 1)[0].path)
    }
    return { ok: true, released }
  })
}

export async function listProjectLeases(projectRoot: string): Promise<ProjectLease[]> {
  return transaction(projectRoot, leases => leases.slice())
}

export async function engineLeaseRefusal(projectRoot: string, facts: ProofTreeFacts, holder: LeaseHolder = projectLeaseHolder()): Promise<string | null> {
  validateHolder(holder)
  const changes = selectedTreeChanges(facts)
  if (changes.files.length === 0) return null
  const files = new Set(changes.files.map(file => canonicalProjectLeasePath(projectRoot, file)))
  const leases = await listProjectLeases(projectRoot)
  const conflict = leases.find(lease => files.has(lease.path) && !sameHolder(lease.holder, holder))
  return conflict ? `${conflict.path} is leased by session ${conflict.holder.sessionId}, agent ${conflict.holder.agentId} (pid ${conflict.holder.pid})` : null
}
