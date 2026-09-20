import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { flagEnv } from '../substrate/flagRegistry.js'
import { getMercuryHome } from '../utils/envUtils.js'
import { readSessionWorkersSnapshot, stampedTerminalPid, type ConcourseWorkerRecordV1 } from './concourseSupervisor.js'
import { daemonControlRpc, daemonDir } from './controlSocket.js'
import { sessionParkDrainMs } from './idleRetirement.js'
import { getProcessStartTokenAsync } from './ownerWatch.js'
import type { DaemonReply, DaemonRequest } from './protocol.js'
import {
  PROCESS_SWEEP_WORDS,
  classifyMercuryProcess,
  composeProcessSweepFacts,
  processSweepIdentityKey,
  readProcessSweepCensus,
  sameSweepIdentity,
  tokenBinding,
  type ProcessSweepCensus,
  type ProcessSweepDaemonAnswer,
  type ProcessSweepDaemonRecord,
  type ProcessSweepEnding,
  type ProcessSweepEntry,
  type ProcessSweepPlane,
  type ProcessSweepRecords,
  type ProcessSweepRegistration,
  type ProcessSweepRunnerRecord,
  type ProcessSweepTable,
} from './processSweep.js'
import { collectPosixProcessTable } from './processSweepPosix.js'

export const COCKPIT_HEARTBEAT_MS = 20_000
export const COCKPIT_HEARTBEAT_ALLOWANCE_MS = 90_000
const REGISTRATION_SCHEMA = 1

export function processSweepWaitMs(): number {
  const raw = Number(flagEnv('MERCURY_PROCESS_SWEEP_WAIT_MS') ?? 4000)
  return Number.isFinite(raw) && raw >= 100 && raw <= 30_000 ? Math.floor(raw) : 4000
}

export function sweepRunnerRecord(record: ConcourseWorkerRecordV1 | undefined, pid: number | undefined, warm: boolean): ProcessSweepRunnerRecord {
  const stamps = [record?.attachedBy, record?.focusedBy].filter((stamp): stamp is string => typeof stamp === 'string' && stamp.trim() !== '')
  return {
    pid,
    procStart: record?.procStart,
    endedAt: record?.endedAt,
    stoppedAt: record?.stoppedAt,
    parkedAt: record?.parkedAt,
    seatHolders: stamps.map(stamp => ({ stamp, terminalPid: stampedTerminalPid(stamp) })),
    schedules: Array.isArray(record?.schedules) ? record.schedules.length : 0,
    activity: record?.activity?.state,
    warm,
  }
}

export function processRecordsDir(home: string = getMercuryHome()): string {
  return join(home, 'processes')
}

export function processSweepCensusPath(home: string = getMercuryHome()): string {
  return join(processRecordsDir(home), 'census.json')
}

function registrationPath(home: string, pid: number, id: string): string {
  return join(processRecordsDir(home), `cockpit-${pid}-${id}.json`)
}

async function writeAtomic(path: string, body: string): Promise<void> {
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, body, 'utf8')
  await rename(temp, path)
}

export interface CockpitRegistrationHandle {
  id: string
  path: string
  heartbeat: () => Promise<void>
  clear: () => Promise<void>
}

export async function registerCockpit(options: { terminal: string | null; home?: string; daemonDirPath?: string; nowMs?: () => number }): Promise<CockpitRegistrationHandle | null> {
  const home = options.home ?? getMercuryHome()
  const now = options.nowMs ?? Date.now
  const id = randomUUID()
  const path = registrationPath(home, process.pid, id)
  const record: ProcessSweepRegistration & { schema: number; exe: string; bundle: string } = {
    schema: REGISTRATION_SCHEMA,
    id,
    pid: process.pid,
    startToken: await getProcessStartTokenAsync(process.pid),
    exe: process.execPath,
    bundle: process.argv[1] ?? '',
    configHome: home,
    daemonDir: options.daemonDirPath ?? daemonDir(),
    terminal: options.terminal,
    bornAt: now(),
    heartbeatAt: now(),
  }
  try {
    await mkdir(processRecordsDir(home), { recursive: true })
    await writeAtomic(path, JSON.stringify(record, null, 2))
  } catch {
    return null
  }
  return {
    id,
    path,
    heartbeat: async () => {
      const at = new Date(now())
      try {
        await utimes(path, at, at)
      } catch {
        return
      }
    },
    clear: async () => {
      try {
        await rm(path, { force: true })
      } catch {
        return
      }
    },
  }
}

export async function readCockpitRegistrations(home: string = getMercuryHome()): Promise<ProcessSweepRegistration[] | null> {
  let names: string[]
  try {
    names = await readdir(processRecordsDir(home))
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null
  }
  const out: ProcessSweepRegistration[] = []
  for (const name of names) {
    if (!/^cockpit-\d+-[0-9a-f-]+\.json$/.test(name)) continue
    try {
      const path = join(processRecordsDir(home), name)
      const raw = JSON.parse(await readFile(path, 'utf8')) as Partial<ProcessSweepRegistration> & { schema?: number }
      if (raw.schema !== REGISTRATION_SCHEMA || typeof raw.id !== 'string' || typeof raw.pid !== 'number' || typeof raw.configHome !== 'string' || typeof raw.daemonDir !== 'string' || typeof raw.heartbeatAt !== 'number') continue
      const touched = (await stat(path)).mtimeMs
      out.push({
        id: raw.id,
        pid: raw.pid,
        startToken: typeof raw.startToken === 'string' ? raw.startToken : null,
        configHome: raw.configHome,
        daemonDir: raw.daemonDir,
        terminal: typeof raw.terminal === 'string' ? raw.terminal : null,
        bornAt: typeof raw.bornAt === 'number' ? raw.bornAt : raw.heartbeatAt,
        heartbeatAt: Math.max(raw.heartbeatAt, Number.isFinite(touched) ? touched : raw.heartbeatAt),
      })
    } catch {
      continue
    }
  }
  return out
}

async function clearRegistrationById(home: string, id: string): Promise<void> {
  let names: string[]
  try {
    names = await readdir(processRecordsDir(home))
  } catch {
    return
  }
  for (const name of names) {
    if (name.endsWith(`-${id}.json`)) await rm(join(processRecordsDir(home), name), { force: true }).catch(() => undefined)
  }
}

async function readPlane(dir: string, own: boolean, rpc: (request: DaemonRequest) => Promise<DaemonReply>, waitMs: number): Promise<ProcessSweepPlane> {
  let supervisor: ProcessSweepDaemonRecord | null = null
  let supervisorReadable = true
  try {
    const raw = JSON.parse(await readFile(join(dir, 'supervisor.json'), 'utf8')) as Record<string, unknown>
    if (typeof raw.pid === 'number' && typeof raw.startedAt === 'number') {
      supervisor = {
        pid: raw.pid,
        startToken: typeof raw.startToken === 'string' ? raw.startToken : raw.startToken === null ? null : undefined,
        ownerPid: typeof raw.ownerPid === 'number' ? raw.ownerPid : raw.ownerPid === null ? null : undefined,
        persist: typeof raw.persist === 'boolean' ? raw.persist : undefined,
        startedAt: raw.startedAt,
      }
    } else {
      supervisorReadable = false
    }
  } catch (error) {
    supervisorReadable = (error as NodeJS.ErrnoException).code === 'ENOENT'
  }
  const snapshot = readSessionWorkersSnapshot(dir)
  const runners: ProcessSweepRunnerRecord[] | null = snapshot.state === 'known'
    ? Object.values(snapshot.workers).map(record => sweepRunnerRecord(record, record.pid, false))
    : null
  let answer: ProcessSweepDaemonAnswer | null = null
  if (own && supervisor !== null) {
    try {
      const reply = await rpc({ op: 'processSweep', proto: 0, action: 'facts' })
      if (reply.ok && reply.op === 'processSweep' && reply.action === 'facts') answer = reply.facts
    } catch {
      answer = null
    }
  }
  return { daemonDir: dir, supervisor, supervisorReadable, answer, runners }
}

async function readCensusMemory(home: string): Promise<Record<string, number> | null> {
  try {
    const raw = JSON.parse(await readFile(processSweepCensusPath(home), 'utf8')) as Partial<ProcessSweepCensus>
    return raw !== null && typeof raw === 'object' && raw.memory !== null && typeof raw.memory === 'object' ? raw.memory : {}
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? {} : null
  }
}

export interface ProcessSweepDeps {
  home?: string
  ownDaemonDir?: string
  nowMs?: () => number
  waitMs?: number
  collect?: (recordedPids: readonly number[]) => Promise<ProcessSweepTable>
  rpc?: (request: DaemonRequest) => Promise<DaemonReply>
  signal?: (pid: number, signal: NodeJS.Signals) => boolean
  sleep?: (ms: number) => Promise<void>
  record?: boolean
}

function platformCollector(waitMs: number, nowMs: number): (recordedPids: readonly number[]) => Promise<ProcessSweepTable> {
  if (process.platform === 'win32') {
    return async recordedPids => (await import('./processSweepWindows.js')).collectWindowsProcesses(recordedPids)
  }
  return recordedPids => collectPosixProcessTable({ waitMs, recordedPids, nowMs })
}

async function gather(deps: ProcessSweepDeps): Promise<{ table: ProcessSweepTable; records: ProcessSweepRecords }> {
  const home = deps.home ?? getMercuryHome()
  const own = deps.ownDaemonDir ?? daemonDir()
  const waitMs = deps.waitMs ?? processSweepWaitMs()
  const rpc = deps.rpc ?? (request => daemonControlRpc(request, { timeoutMs: waitMs }))
  const registrations = await readCockpitRegistrations(home)
  const dirs = [own, join(home, 'daemon'), ...(registrations ?? []).filter(entry => entry.configHome === home).map(entry => entry.daemonDir)]
  const planes: ProcessSweepPlane[] = []
  for (const dir of dirs) {
    if (planes.some(plane => plane.daemonDir === dir)) continue
    planes.push(await readPlane(dir, dir === own, rpc, waitMs))
  }
  const recordedPids = new Set<number>()
  for (const plane of planes) {
    if (plane.supervisor !== null) recordedPids.add(plane.supervisor.pid)
    for (const runner of plane.answer?.runners ?? plane.runners ?? []) if (typeof runner.pid === 'number') recordedPids.add(runner.pid)
  }
  for (const registration of registrations ?? []) recordedPids.add(registration.pid)
  const nowMs = (deps.nowMs ?? Date.now)()
  const table = await (deps.collect ?? platformCollector(waitMs, nowMs))([...recordedPids])
  const records: ProcessSweepRecords = {
    nowMs,
    platform: process.platform,
    selfPid: process.pid,
    user: process.platform === 'win32'
      ? table.observations.find(row => row.process.pid === process.pid)?.process.user ?? ''
      : typeof process.getuid === 'function' ? String(process.getuid()) : '',
    configHome: home,
    drainMs: sessionParkDrainMs(),
    heartbeatAllowanceMs: COCKPIT_HEARTBEAT_ALLOWANCE_MS,
    planes,
    registrations,
    memory: await readCensusMemory(home),
  }
  return { table, records }
}

export async function readMercuryProcesses(deps: ProcessSweepDeps = {}): Promise<ProcessSweepCensus> {
  const { table, records } = await gather(deps)
  return readProcessSweepCensus(table, records)
}

export async function recordProcessCensusAtBoot(deps: ProcessSweepDeps = {}): Promise<ProcessSweepCensus> {
  const { table, records } = await gather(deps)
  const census = readProcessSweepCensus(table, records)
  await recordCensus(records.configHome, census)
  await pruneDeadRegistrations(records.configHome, table, records.registrations ?? [])
  return census
}

async function pruneDeadRegistrations(home: string, table: ProcessSweepTable, registrations: readonly ProcessSweepRegistration[]): Promise<void> {
  if (!table.complete) return
  for (const registration of registrations) {
    if (registration.configHome !== home) continue
    const row = table.observations.find(candidate => candidate.process.pid === registration.pid)
    const dead = row === undefined || row.state.startsWith('Z') || tokenBinding(registration.startToken, row.startToken) === 'stranger'
    if (dead) await rm(registrationPath(home, registration.pid, registration.id), { force: true }).catch(() => undefined)
  }
}

async function recordCensus(home: string, census: ProcessSweepCensus): Promise<void> {
  try {
    await mkdir(processRecordsDir(home), { recursive: true })
    await writeAtomic(processSweepCensusPath(home), JSON.stringify(census, null, 2))
  } catch {
    return
  }
}

function freshEntry(entry: ProcessSweepEntry, table: ProcessSweepTable, records: ProcessSweepRecords): ProcessSweepEntry | null {
  if (!table.complete) return null
  const facts = composeProcessSweepFacts(table, records).find(candidate => candidate.process.pid === entry.process.pid)
  return facts === undefined ? null : classifyMercuryProcess(facts)
}

export async function endStaleProcesses(reviewed: readonly ProcessSweepEntry[], deps: ProcessSweepDeps = {}): Promise<ProcessSweepCensus> {
  const home = deps.home ?? getMercuryHome()
  const own = deps.ownDaemonDir ?? daemonDir()
  const waitMs = deps.waitMs ?? processSweepWaitMs()
  const now = deps.nowMs ?? Date.now
  const rpc = deps.rpc ?? (request => daemonControlRpc(request, { timeoutMs: waitMs }))
  const signal = deps.signal ?? ((pid: number, name: NodeJS.Signals): boolean => {
    try {
      process.kill(pid, name)
      return true
    } catch {
      return false
    }
  })
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)))
  const endings: ProcessSweepEnding[] = []
  const record = (entry: ProcessSweepEntry, outcome: ProcessSweepEnding['outcome'], road: ProcessSweepEnding['road'], reason: string): void => {
    endings.push({ entry, outcome, road, reason, at: now() })
  }
  const stillPresent = async (entry: ProcessSweepEntry): Promise<{ present: boolean; fresh: ProcessSweepEntry | null; table: ProcessSweepTable; records: ProcessSweepRecords }> => {
    const { table, records } = await gather({ ...deps, record: false })
    const fresh = freshEntry(entry, table, records)
    const present = table.complete ? table.observations.some(row => row.process.pid === entry.process.pid && !row.state.startsWith('Z')) : true
    return { present, fresh, table, records }
  }
  const waitGone = async (entry: ProcessSweepEntry): Promise<boolean> => {
    const until = now() + waitMs
    for (;;) {
      const { present } = await stillPresent(entry)
      if (!present) return true
      if (now() >= until) return false
      await sleep(Math.min(100, Math.max(1, until - now())))
    }
  }
  if (process.platform === 'win32') {
    const { signalWindowsProcess } = await import('./processSweepWindows.js')
    windowsEntries: for (const entry of reviewed) {
      if (entry.classification !== 'stale') {
        record(entry, 'refused', 'none', `not a stale process (${entry.classification})`)
        continue
      }
      const first = await stillPresent(entry)
      if (!first.present) {
        record(entry, 'ended', 'none', 'already gone before anything was sent')
        continue
      }
      if (first.fresh === null || !sameSweepIdentity(entry, first.fresh) || first.fresh.classification !== 'stale') {
        record(entry, 'refused', 'none', first.fresh === null ? 'the process could not be re-read' : `no longer the reviewed stale process: ${first.fresh.reason}`)
        continue
      }
      const plane = first.records.planes.find(candidate => candidate.daemonDir === own)
      if (plane?.supervisor !== null && plane?.supervisor !== undefined && (
        (entry.kind === 'daemon' && plane.supervisor.pid === entry.process.pid) ||
        (entry.kind === 'runner' && (plane.answer?.runners ?? plane.runners ?? []).some(runner => runner.pid === entry.process.pid))
      )) {
        let reply: DaemonReply | null = null
        try { reply = await rpc({ op: 'processSweep', proto: 0, action: 'end', expected: first.fresh }) } catch {}
        if (reply === null || !reply.ok || reply.op !== 'processSweep' || reply.action !== 'end' || !reply.ended) {
          record(entry, 'refused', 'daemon', 'the daemon did not confirm the end request; nothing was sent')
          continue
        }
        if (await waitGone(entry)) {
          record(entry, 'ended', 'daemon', reply.reason ?? 'ended through its daemon')
          continue
        }
        if (entry.kind === 'daemon') {
          record(entry, 'survived', 'daemon', 'the daemon confirmed shutdown but had not left within the wait; nothing else was sent')
          continue
        }
      }
      for (const force of [false, true]) {
        const current = await stillPresent(entry)
        if (!current.present) {
          record(entry, 'ended', 'signal', 'the process has ended')
          continue windowsEntries
        }
        if (current.fresh === null || !sameSweepIdentity(entry, current.fresh) || current.fresh.classification !== 'stale') {
          record(entry, 'refused', 'none', 'the reviewed identity or liveness changed before the Windows stop')
          continue windowsEntries
        }
        const result = await signalWindowsProcess(current.fresh, force)
        if (!result.sent) {
          if (!force && /forcefully|\/F/.test(result.reason ?? '')) continue
          record(entry, 'refused', 'signal', result.reason ?? 'the Windows stop could not be sent')
          continue windowsEntries
        }
        if (await waitGone(entry)) {
          record(entry, 'ended', 'signal', result.reason ?? (force ? 'ended on the forced Windows stop' : 'ended on the polite Windows stop'))
          if (entry.kind === 'window' && entry.registrationId !== null) await clearRegistrationById(home, entry.registrationId)
          continue windowsEntries
        }
      }
      record(entry, 'survived', 'signal', PROCESS_SWEEP_WORDS.unkillable)
    }
    const census = { ...(await readMercuryProcesses({ ...deps, record: false })), endings }
    if (deps.record !== false) await recordCensus(home, census)
    return census
  }
  for (const entry of reviewed) {
    if (entry.classification !== 'stale') {
      record(entry, 'refused', 'none', `not a stale process (${entry.classification})`)
      continue
    }
    const first = await stillPresent(entry)
    if (!first.present) {
      record(entry, 'ended', 'none', 'already gone before anything was sent')
      continue
    }
    if (first.fresh === null || !sameSweepIdentity(entry, first.fresh)) {
      record(entry, 'refused', 'none', 'the pid no longer carries the reviewed identity')
      continue
    }
    if (first.fresh.classification !== 'stale') {
      record(entry, 'refused', 'none', `no longer stale: ${first.fresh.reason}`)
      continue
    }
    const ownPlane = first.records.planes.find(plane => plane.daemonDir === own)
    const daemonRoad = ownPlane !== undefined && ownPlane.supervisor !== null && (
      (first.fresh.kind === 'daemon' && ownPlane.supervisor.pid === entry.process.pid) ||
      (first.fresh.kind === 'runner' && (ownPlane.answer?.runners ?? ownPlane.runners ?? []).some(runner => runner.pid === entry.process.pid))
    )
    if (daemonRoad) {
      let reply: DaemonReply | null = null
      try {
        reply = await rpc({ op: 'processSweep', proto: 0, action: 'end', expected: first.fresh })
      } catch {
        reply = null
      }
      if (reply === null || !reply.ok || reply.op !== 'processSweep' || reply.action !== 'end') {
        record(entry, 'refused', 'daemon', `the daemon did not answer the end request (${reply !== null && !reply.ok ? reply.code : 'no reply'}); nothing was sent`)
        continue
      }
      const reason = typeof reply.reason === 'string' && reply.reason.trim() !== '' ? reply.reason : 'the daemon answered without a reason'
      if (reply.ended !== true) {
        record(entry, 'refused', 'daemon', reason)
        continue
      }
      if (await waitGone(entry)) {
        record(entry, 'ended', 'daemon', reason)
        continue
      }
      if (first.fresh.kind === 'daemon') {
        record(entry, 'survived', 'daemon', 'the daemon confirmed its own shutdown but had not left within the wait; nothing else was sent')
        continue
      }
    }
    const beforeTerm = await stillPresent(entry)
    if (!beforeTerm.present) {
      record(entry, 'ended', 'daemon', 'ended through its daemon')
      continue
    }
    if (beforeTerm.fresh === null || !sameSweepIdentity(entry, beforeTerm.fresh) || beforeTerm.fresh.classification !== 'stale') {
      record(entry, 'refused', 'none', beforeTerm.fresh === null ? 'the process could not be re-read before the signal' : `no longer stale before the signal: ${beforeTerm.fresh.reason}`)
      continue
    }
    if (!signal(entry.process.pid, 'SIGTERM')) {
      record(entry, 'refused', 'signal', 'the termination signal could not be sent')
      continue
    }
    if (await waitGone(entry)) {
      record(entry, 'ended', 'signal', 'ended on the termination signal')
      if (entry.kind === 'window' && entry.registrationId !== null) await clearRegistrationById(home, entry.registrationId)
      continue
    }
    const beforeKill = await stillPresent(entry)
    if (!beforeKill.present) {
      record(entry, 'ended', 'signal', 'ended on the termination signal')
      if (entry.kind === 'window' && entry.registrationId !== null) await clearRegistrationById(home, entry.registrationId)
      continue
    }
    if (beforeKill.fresh === null || !sameSweepIdentity(entry, beforeKill.fresh) || beforeKill.fresh.classification !== 'stale') {
      record(entry, 'refused', 'signal', beforeKill.fresh === null ? 'the process could not be re-read after the termination signal' : !sameSweepIdentity(entry, beforeKill.fresh) ? 'the pid no longer carries the reviewed identity after the termination signal' : `no longer stale after the termination signal: ${beforeKill.fresh.reason}`)
      continue
    }
    if (!signal(entry.process.pid, 'SIGKILL')) {
      record(entry, 'refused', 'signal', 'the kill signal could not be sent')
      continue
    }
    if (await waitGone(entry)) {
      record(entry, 'ended', 'signal', 'ended on the kill signal')
      if (entry.kind === 'window' && entry.registrationId !== null) await clearRegistrationById(home, entry.registrationId)
      continue
    }
    const after = await stillPresent(entry)
    record(entry, 'survived', 'signal', `${PROCESS_SWEEP_WORDS.unkillable} (state ${after.fresh?.state ?? entry.state} after the kill signal)`)
  }
  const census = await readMercuryProcesses(deps)
  const withEndings = { ...census, endings }
  if (deps.record !== false) await recordCensus(home, withEndings)
  return withEndings
}

export function processSweepOutcomeLine(census: ProcessSweepCensus): string {
  const ended = census.endings.filter(ending => ending.outcome === 'ended' && ending.road !== 'none').length
  const survived = census.endings.filter(ending => ending.outcome !== 'ended').length
  const running = census.entries.filter(entry => entry.classification === 'running').length
  return PROCESS_SWEEP_WORDS.result(ended, survived, running)
}

export function processSweepEntryKey(entry: ProcessSweepEntry): string {
  return processSweepIdentityKey(entry)
}
