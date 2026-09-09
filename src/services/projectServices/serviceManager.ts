
import { spawn, type ChildProcess } from 'node:child_process'
import { registerCleanup } from '../../utils/cleanupRegistry.js'
import { endProcessTree } from '../../utils/processGroup.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import {
  closeSync,
  createReadStream,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
} from 'node:fs'
import { connect } from 'node:net'
import * as path from 'node:path'
import { getProcessStartToken, getProcessStartTokenAsync, getProcessStartTokenCachedOrRefresh } from '../../daemon/ownerWatch.js'
import { durableAtomicPublishSync } from '../../substrate/durablePublish.js'
import { getMercuryHome } from '../../utils/envUtils.js'
import { logForDebugging } from '../../utils/debug.js'
import {
  describeCondition,
  SERVICE_NAME_RE,
  type ReadinessCondition,
  type ReadinessStatus,
  type ServiceRecord,
  type ServiceSpec,
} from './contracts.js'
import {
  installServiceExecutionDomain,
  projectServiceExecution,
} from './executionProjection.js'

const RESTART_BACKOFF_BASE_MS = 500
const RESTART_BACKOFF_MAX_MS = 15_000
const MAX_AUTO_RESTARTS = 5


function projectSlug(cwd: string): string {
  return path.resolve(cwd).replace(/[^a-zA-Z0-9]/g, '-').slice(-80)
}

export function servicesDir(cwd: string): string {
  return path.join(getMercuryHome(), 'services', projectSlug(cwd))
}

function recordPath(cwd: string, name: string): string {
  return path.join(servicesDir(cwd), `${name}.json`)
}

function logPath(cwd: string, name: string): string {
  return path.join(servicesDir(cwd), `${name}.log`)
}

function writeRecord(cwd: string, record: ServiceRecord): void {
  mkdirSync(servicesDir(cwd), { recursive: true })
  durableAtomicPublishSync(
    recordPath(cwd, record.spec.name),
    JSON.stringify(record, null, 2),
  )
  projectServiceExecution(cwd, record)
}

export function readRecord(cwd: string, name: string): ServiceRecord | null {
  try {
    const raw = JSON.parse(readFileSync(recordPath(cwd, name), 'utf8')) as ServiceRecord
    if (raw.schema !== 1 || !raw.spec?.name) return null
    return raw
  } catch {
    return null
  }
}

export function listRecords(cwd: string): ServiceRecord[] {
  try {
    const dir = servicesDir(cwd)
    const names = existsSync(dir)
      ? readFileSyncDirNames(dir)
      : []
    return names
      .map(n => readRecord(cwd, n))
      .filter((r): r is ServiceRecord => r !== null)
      .sort((a, b) => a.spec.name.localeCompare(b.spec.name))
  } catch {
    return []
  }
}

function readFileSyncDirNames(dir: string): string[] {
  const { readdirSync } = require('node:fs') as typeof import('node:fs')
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.slice(0, -5))
}


const liveChildren = new Map<string, ChildProcess>()
const restartTimers = new Map<string, ReturnType<typeof setTimeout>>()

function childKey(cwd: string, name: string): string {
  return `${path.resolve(cwd)}::${name}`
}

export function liveServiceChildren(): Array<{ key: string; pid: number | undefined }> {
  return [...liveChildren.entries()]
    .filter(([, child]) => child.exitCode === null && child.signalCode === null)
    .map(([key, child]) => ({ key, pid: child.pid }))
}

registerCleanup(async () => {
  const children = [...liveChildren.values()]
  liveChildren.clear()
  await Promise.all(children.map(child => endProcessTree(child, 'SIGTERM').catch(() => undefined)))
})

process.once('exit', () => {
  for (const [key, child] of liveChildren) {
    void key
    try {
      child.kill('SIGTERM')
    } catch {
    }
  }
})


function processAlive(pid: number | null, startToken: string | null): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  if (startToken) {
    const current = getProcessStartTokenCachedOrRefresh(pid)
    if (current !== null && current !== startToken) return false
  }
  return true
}

const TOKEN_BACKFILL_RETRY_MS = [500, 1500, 3500] as const

function captureStartTokenAsync(cwd: string, name: string, pid: number, attempt = 0): void {
  void getProcessStartTokenAsync(pid)
    .then(token => {
      const current = readRecord(cwd, name)
      if (!current || current.pid !== pid || current.startToken !== null) return
      if (token === null) {
        const delay = TOKEN_BACKFILL_RETRY_MS[attempt]
        if (delay === undefined) return
        const timer = setTimeout(() => captureStartTokenAsync(cwd, name, pid, attempt + 1), delay)
        timer.unref?.()
        return
      }
      if (token === '') return
      writeRecord(cwd, { ...current, startToken: token, updatedAt: Date.now() })
    })
    .catch(() => {
    })
}

function ownedLiveChild(cwd: string, name: string, pid: number): boolean {
  const child = liveChildren.get(childKey(cwd, name))
  return child !== undefined && child.pid === pid && child.exitCode === null && child.signalCode === null
}

export function reconcileRecord(cwd: string, name: string): ServiceRecord | null {
  const record = readRecord(cwd, name)
  if (!record) return null
  const liveStates = new Set(['starting', 'ready', 'running', 'stopping'])
  if (liveStates.has(record.state) && !processAlive(record.pid, record.startToken)) {
    const reconciled: ServiceRecord = {
      ...record,
      state: record.explicitStop ? 'stopped' : 'failed',
      pid: null,
      startToken: null,
      stoppedAt: record.stoppedAt ?? Date.now(),
      updatedAt: Date.now(),
    }
    writeRecord(cwd, reconciled)
    return reconciled
  }
  return record
}

export function reconcileAll(cwd: string): ServiceRecord[] {
  return listRecords(cwd)
    .map(r => reconcileRecord(cwd, r.spec.name))
    .filter((r): r is ServiceRecord => r !== null)
}

installServiceExecutionDomain({
  reconcile: (cwd, name) => reconcileRecord(cwd, name),
  stop: (cwd, name) => stopService(cwd, name),
})


async function checkCondition(
  cwd: string,
  record: ServiceRecord,
  condition: ReadinessCondition,
  startedAt: number,
): Promise<ReadinessStatus> {
  const base = { condition, met: false, detail: describeCondition(condition) }
  try {
    switch (condition.kind) {
      case 'log': {
        const re = new RegExp(condition.regex, 'm')
        let text = ''
        try {
          text = readFileSync(record.logFile, 'utf8')
        } catch {
          return { ...base, detail: `${base.detail} — no log yet` }
        }
        const fromThisStart = text.slice(record.logStartByte ?? 0)
        return re.test(fromThisStart)
          ? { ...base, met: true, detail: `${base.detail} — matched` }
          : { ...base, detail: `${base.detail} — not yet` }
      }
      case 'tcp': {
        const ok = await new Promise<boolean>(resolve => {
          const socket = connect(
            { host: condition.host ?? '127.0.0.1', port: condition.port, timeout: 1_000 },
            () => {
              socket.destroy()
              resolve(true)
            },
          )
          socket.on('error', () => resolve(false))
          socket.on('timeout', () => {
            socket.destroy()
            resolve(false)
          })
        })
        return ok
          ? { ...base, met: true, detail: `${base.detail} — accepting` }
          : { ...base, detail: `${base.detail} — refused` }
      }
      case 'http': {
        try {
          const res = await fetch(condition.url, {
            method: condition.method ?? 'GET',
            signal: AbortSignal.timeout(2_000),
          })
          const wantStatus = condition.status ?? 200
          if (res.status !== wantStatus) {
            return { ...base, detail: `${base.detail} — got ${res.status}` }
          }
          if (condition.bodyRegex) {
            const body = await res.text()
            if (!new RegExp(condition.bodyRegex, 'm').test(body)) {
              return { ...base, detail: `${base.detail} — status ok, body mismatch` }
            }
          }
          return { ...base, met: true, detail: `${base.detail} — ok` }
        } catch (e) {
          return { ...base, detail: `${base.detail} — ${e instanceof Error ? e.message.slice(0, 60) : 'unreachable'}` }
        }
      }
      case 'file': {
        try {
          if (condition.contentRegex) {
            const text = readFileSync(condition.path, 'utf8')
            return new RegExp(condition.contentRegex, 'm').test(text)
              ? { ...base, met: true, detail: `${base.detail} — matched` }
              : { ...base, detail: `${base.detail} — content not yet` }
          }
          statSync(condition.path)
          return { ...base, met: true, detail: `${base.detail} — exists` }
        } catch {
          return { ...base, detail: `${base.detail} — absent` }
        }
      }
      case 'stable': {
        const aliveFor = Date.now() - startedAt
        const alive = processAlive(record.pid, record.startToken)
        return alive && aliveFor >= condition.ms
          ? { ...base, met: true, detail: `${base.detail} — stable (${aliveFor}ms)` }
          : { ...base, detail: alive ? `${base.detail} — ${aliveFor}ms so far` : `${base.detail} — process not alive` }
      }
    }
  } catch (e) {
    return { ...base, detail: `${base.detail} — check failed: ${e instanceof Error ? e.message.slice(0, 60) : String(e)}` }
  }
}

export async function evaluateReadiness(
  cwd: string,
  record: ServiceRecord,
): Promise<{ ready: boolean; statuses: ReadinessStatus[] }> {
  const startedAt = record.startedAt ?? Date.now()
  const statuses = await Promise.all(
    record.spec.readiness.map(c => checkCondition(cwd, record, c, startedAt)),
  )
  const ready =
    statuses.length === 0
      ? processAlive(record.pid, record.startToken)
      : record.spec.readinessMode === 'any'
        ? statuses.some(s => s.met)
        : statuses.every(s => s.met)
  return { ready, statuses }
}

export async function waitForReady(
  cwd: string,
  name: string,
  timeoutMs: number,
): Promise<{ ready: boolean; statuses: ReadinessStatus[]; record: ServiceRecord | null }> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const record = reconcileRecord(cwd, name)
    if (!record) return { ready: false, statuses: [], record: null }
    if (record.state === 'failed' || record.state === 'stopped') {
      const { statuses } = await evaluateReadiness(cwd, record)
      return { ready: false, statuses, record }
    }
    const { ready, statuses } = await evaluateReadiness(cwd, record)
    if (ready) {
      if (record.state === 'starting') {
        const updated: ServiceRecord = {
          ...record,
          state: 'ready',
          readiness: statuses,
          updatedAt: Date.now(),
        }
        writeRecord(cwd, updated)
        return { ready: true, statuses, record: updated }
      }
      return { ready: true, statuses, record }
    }
    if (Date.now() >= deadline) {
      const updated: ServiceRecord = { ...record, readiness: statuses, updatedAt: Date.now() }
      writeRecord(cwd, updated)
      return { ready: false, statuses, record: updated }
    }
    await new Promise(r => setTimeout(r, 250))
  }
}


export interface StartOptions {
  spec: ServiceSpec
  sessionId: string
}

export function validateSpec(spec: ServiceSpec): string | null {
  if (!SERVICE_NAME_RE.test(spec.name)) {
    return `invalid service name '${spec.name}' (want ${SERVICE_NAME_RE})`
  }
  if (!spec.command) return 'command is required'
  return null
}

export async function startService(
  opts: StartOptions,
): Promise<{ record: ServiceRecord } | { error: string }> {
  const { spec, sessionId } = opts
  const invalid = validateSpec(spec)
  if (invalid) return { error: invalid }
  const existing = reconcileRecord(spec.cwd, spec.name)
  if (existing && ['starting', 'ready', 'running', 'stopping'].includes(existing.state)) {
    return {
      error: `service '${spec.name}' is already ${existing.state} (pid ${existing.pid}) — stop or restart it instead`,
    }
  }

  mkdirSync(servicesDir(spec.cwd), { recursive: true })
  const logFile = logPath(spec.cwd, spec.name)
  let logStartByte = 0
  try {
    logStartByte = statSync(logFile, { throwIfNoEntry: false })?.size ?? 0
  } catch {
    logStartByte = 0
  }
  let logFd: number
  try {
    logFd = openSync(logFile, 'a')
  } catch (e) {
    return { error: `cannot open log file ${logFile}: ${e instanceof Error ? e.message : String(e)}` }
  }

  let child: ChildProcess
  try {
    child = spawn(spec.command, spec.args, {
      windowsHide: true,
      cwd: spec.cwd,
      env: { ...subprocessEnv(), ...(spec.env ?? {}) },
      stdio: ['pipe', logFd, logFd],
      detached: spec.lifecycle === 'project',
    })
  } catch (e) {
    closeSync(logFd)
    return { error: `spawn failed: ${e instanceof Error ? e.message : String(e)}` }
  }
  closeSync(logFd)
  if (!child.pid) {
    return { error: 'spawn produced no pid' }
  }
  if (spec.lifecycle === 'project') child.unref()

  const record: ServiceRecord = {
    schema: 1,
    spec,
    state: 'starting',
    pid: child.pid,
    startToken: process.platform === 'win32' ? null : getProcessStartToken(child.pid),
    startedAt: Date.now(),
    stoppedAt: null,
    lastExitCode: null,
    explicitStop: false,
    restartCount: existing?.restartCount ?? 0,
    readiness: [],
    logFile,
    ownerSessionId: sessionId,
    logStartByte,
    updatedAt: Date.now(),
  }
  writeRecord(spec.cwd, record)
  liveChildren.set(childKey(spec.cwd, spec.name), child)
  captureStartTokenAsync(spec.cwd, spec.name, child.pid)

  child.on('exit', (code, signal) => {
    liveChildren.delete(childKey(spec.cwd, spec.name))
    const current = readRecord(spec.cwd, spec.name)
    if (!current) return
    const explicit = current.explicitStop
    const exited: ServiceRecord = {
      ...current,
      state: explicit ? 'stopped' : code === 0 ? 'stopped' : 'failed',
      pid: null,
      startToken: null,
      stoppedAt: Date.now(),
      lastExitCode: code ?? (signal ? -1 : null),
      updatedAt: Date.now(),
    }
    writeRecord(spec.cwd, exited)
    if (
      !explicit &&
      exited.state === 'failed' &&
      spec.restart === 'on-failure' &&
      exited.restartCount < MAX_AUTO_RESTARTS
    ) {
      const backoff = Math.min(
        RESTART_BACKOFF_BASE_MS * 2 ** exited.restartCount,
        RESTART_BACKOFF_MAX_MS,
      )
      const timer = setTimeout(() => {
        restartTimers.delete(childKey(spec.cwd, spec.name))
        const latest = readRecord(spec.cwd, spec.name)
        if (!latest || latest.explicitStop) return
        void startService({ spec, sessionId }).then(result => {
          if ('record' in result) {
            writeRecord(spec.cwd, {
              ...result.record,
              restartCount: exited.restartCount + 1,
              updatedAt: Date.now(),
            })
          } else {
            logForDebugging(`service ${spec.name}: auto-restart failed: ${result.error}`)
          }
        })
      }, backoff)
      timer.unref?.()
      restartTimers.set(childKey(spec.cwd, spec.name), timer)
    }
  })

  return { record }
}

function signalPid(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    process.kill(pid)
  } else {
    process.kill(pid, signal)
  }
}

export type ServiceStrikeVerdict = 'no-process' | 'strike' | 'refuse-unverified' | 'refuse-reused'

export function decideServiceStrike(facts: {
  pid: number | null
  startToken: string | null
  currentToken: string | null
  ownedHandle?: boolean
}): ServiceStrikeVerdict {
  if (!facts.pid) return 'no-process'
  if (facts.ownedHandle === true) return 'strike'
  if (facts.currentToken === '') return 'no-process'
  if (facts.startToken === null || facts.currentToken === null) return 'refuse-unverified'
  return facts.currentToken === facts.startToken ? 'strike' : 'refuse-reused'
}

function strikeRefusalNote(name: string, pid: number, verdict: ServiceStrikeVerdict): string {
  return verdict === 'refuse-reused'
    ? `service '${name}' was not force-stopped: pid ${pid} now belongs to a DIFFERENT process (the pid was reused) — the record is cleared and nothing was killed`
    : `service '${name}' was not force-stopped: pid ${pid} could not be confirmed as this service (no start-time identity to check it against) — the record is cleared and nothing was killed; check the process yourself if it is still running`
}

export async function stopService(
  cwd: string,
  name: string,
): Promise<{ record: ServiceRecord; note?: string } | { error: string }> {
  const record = reconcileRecord(cwd, name)
  if (!record) return { error: `no service '${name}' in this project` }
  const pending = restartTimers.get(childKey(cwd, name))
  if (pending) {
    clearTimeout(pending)
    restartTimers.delete(childKey(cwd, name))
  }
  const marked: ServiceRecord = { ...record, explicitStop: true, state: record.pid ? 'stopping' : 'stopped', updatedAt: Date.now() }
  writeRecord(cwd, marked)
  const clear = (note?: string): { record: ServiceRecord; note?: string } => {
    const stopped: ServiceRecord = {
      ...marked,
      state: 'stopped',
      pid: null,
      startToken: null,
      stoppedAt: marked.stoppedAt ?? Date.now(),
      updatedAt: Date.now(),
      ...(note !== undefined ? { stopNote: note } : {}),
    }
    writeRecord(cwd, stopped)
    return { record: stopped, ...(note !== undefined ? { note } : {}) }
  }
  if (!record.pid || !processAlive(record.pid, record.startToken)) return clear()

  const owned = ownedLiveChild(cwd, name, record.pid)
  const live = owned ? null : await getProcessStartTokenAsync(record.pid)
  const verdict = decideServiceStrike({ pid: record.pid, startToken: record.startToken, currentToken: live, ownedHandle: owned })
  if (verdict === 'no-process') return clear()
  if (verdict !== 'strike') {
    const note = strikeRefusalNote(name, record.pid, verdict)
    logForDebugging(`[services] ${note}`)
    return clear(note)
  }

  if (process.platform === 'win32') {
    await endProcessTree(record.pid, 'SIGKILL')
  } else {
    try {
      signalPid(record.pid, 'SIGTERM')
    } catch {
    }
  }
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (!processAlive(record.pid, record.startToken)) break
    await new Promise(r => setTimeout(r, 100))
  }
  if (processAlive(record.pid, record.startToken)) {
    const stillOwned = ownedLiveChild(cwd, name, record.pid)
    const stillOurs = decideServiceStrike({
      pid: record.pid,
      startToken: record.startToken,
      currentToken: stillOwned ? null : await getProcessStartTokenAsync(record.pid),
      ownedHandle: stillOwned,
    })
    if (stillOurs === 'strike') await endProcessTree(record.pid, 'SIGKILL')
    else if (stillOurs !== 'no-process') return clear(strikeRefusalNote(name, record.pid, stillOurs))
  }
  const final = reconcileRecord(cwd, name) ?? marked
  if (final.state !== 'stopped') {
    const stopped: ServiceRecord = { ...final, state: 'stopped', pid: null, startToken: null, stoppedAt: Date.now(), updatedAt: Date.now() }
    writeRecord(cwd, stopped)
    return { record: stopped }
  }
  return { record: final }
}

export async function restartService(
  cwd: string,
  name: string,
  sessionId: string,
): Promise<{ record: ServiceRecord } | { error: string }> {
  const record = readRecord(cwd, name)
  if (!record) return { error: `no service '${name}' in this project — start it first` }
  const stopped = await stopService(cwd, name)
  if ('error' in stopped) return stopped
  if (stopped.note !== undefined) {
    return { error: `restart failed: ${stopped.note}` }
  }
  const started = await startService({ spec: record.spec, sessionId })
  if ('error' in started) return started
  const bumped: ServiceRecord = {
    ...started.record,
    restartCount: record.restartCount + 1,
    updatedAt: Date.now(),
  }
  writeRecord(cwd, bumped)
  return { record: bumped }
}

export function sendInput(
  cwd: string,
  name: string,
  text: string,
  sessionId: string,
): { ok: true } | { error: string } {
  const record = reconcileRecord(cwd, name)
  if (!record) return { error: `no service '${name}' in this project` }
  if (!record.pid) return { error: `service '${name}' is ${record.state} — nothing to write to` }
  const child = liveChildren.get(childKey(cwd, name))
  if (!child || !child.stdin || child.stdin.destroyed) {
    return {
      error:
        record.ownerSessionId && record.ownerSessionId !== sessionId
          ? `service '${name}' was spawned by another session (${record.ownerSessionId}) — its stdin lives there`
          : `service '${name}' has no writable stdin in this session`,
    }
  }
  child.stdin.write(text.endsWith('\n') ? text : text + '\n')
  return { ok: true }
}


export async function readLogs(
  cwd: string,
  name: string,
  opts: { cursor?: number; limitLines?: number; filterRegex?: string; tail?: boolean },
): Promise<
  | { lines: string[]; nextCursor: number; eof: boolean; totalBytes: number }
  | { error: string }
> {
  const record = readRecord(cwd, name)
  if (!record) return { error: `no service '${name}' in this project` }
  let size = 0
  try {
    size = statSync(record.logFile).size
  } catch {
    return { lines: [], nextCursor: 0, eof: true, totalBytes: 0 }
  }
  const limit = Math.min(opts.limitLines ?? 100, 1000)
  let start = opts.cursor ?? 0
  if (opts.tail && opts.cursor === undefined) {
    start = Math.max(0, size - 64 * 1024)
  }
  if (start >= size) return { lines: [], nextCursor: size, eof: true, totalBytes: size }
  const text = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = []
    createReadStream(record.logFile, { start, end: Math.min(size - 1, start + 512 * 1024) })
      .on('data', chunk => {
        chunks.push(chunk as Buffer)
      })
      .on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      .on('error', reject)
  }).catch(() => '')
  let lines = text.split('\n')
  const consumedBytes = Buffer.byteLength(text, 'utf8')
  const atEof = start + consumedBytes >= size
  if (!atEof && lines.length > 1) lines.pop()
  if (opts.filterRegex) {
    try {
      const re = new RegExp(opts.filterRegex)
      lines = lines.filter(l => re.test(l))
    } catch {
      return { error: `invalid filter regex: ${opts.filterRegex}` }
    }
  }
  const shown = opts.tail ? lines.slice(-limit) : lines.slice(0, limit)
  const nextCursor = start + consumedBytes
  return {
    lines: shown.filter(l => l.length > 0),
    nextCursor,
    eof: atEof,
    totalBytes: size,
  }
}
