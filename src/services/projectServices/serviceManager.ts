// ============================================================================
//  projectServices/serviceManager — the one owner of service lifecycle
// durable records (atomic publish, project-scoped),
//  spawn/stop/restart with pid+start-token identity, per-condition
//  readiness truth, ordered log cursors, and reconciliation that never
//  claims a live process from a record alone.
// ============================================================================

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

// ── storage ─────────────────────────────────────────────────────────────────

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
  // the durable domain record and its canonical execution
  // projection are the SAME publication — they can never disagree silently.
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

// ── live process tracking (this session's children) ────────────────────────

const liveChildren = new Map<string, ChildProcess>()
const restartTimers = new Map<string, ReturnType<typeof setTimeout>>()

function childKey(cwd: string, name: string): string {
  return `${path.resolve(cwd)}::${name}`
}

// THE QUIT'S FIRST ROAD: an async cleanup, so a session-lifecycle service's
// own children go with it. The sync hook below could only ever signal the
// leader — a tree walk cannot complete inside process.once('exit') — and a
// dev server's grandchild outlived the quit holding its port (FN-015 rank
// 11). Bounded by the shutdown path's own cleanup cap.
registerCleanup(async () => {
  const children = [...liveChildren.values()]
  liveChildren.clear()
  await Promise.all(children.map(child => endProcessTree(child, 'SIGTERM').catch(() => undefined)))
})

process.once('exit', () => {
  // The BACKSTOP for a death too abrupt for the cleanup above (a crash, a
  // hard kill): session-lifecycle services die with the session;
  // project-lifecycle children are detached+unref'd and survive.
  for (const [key, child] of liveChildren) {
    void key
    try {
      child.kill('SIGTERM')
    } catch {
      /* best effort */
    }
  }
})

// ── reconciliation ──────────────────────────────────────────────────────────

function processAlive(pid: number | null, startToken: string | null): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }
  if (startToken) {
    // Reconcile runs on read paths — the cached-or-refresh form
    // never spawns synchronously (win32 PowerShell cost 400–900ms per call);
    // a cold miss reads null = cannot-prove-reuse ⇒ alive, converging on the
    // next reconcile pass.
    const current = getProcessStartTokenCachedOrRefresh(pid)
    if (current !== null && current !== startToken) return false
  }
  return true
}

/** The backfill's retry ladder: a probe that COULD NOT ANSWER (the win32
 *  CIM query past its budget on a cold disk, an exe not found) is retried
 *  on a short backoff instead of leaving the record unverifiable for its
 *  whole life — one missed shot made every later stop and restart of that
 *  service refuse (FN-019 blocker 2). A pid that answers "gone" is never
 *  retried; a record that moved on ends the ladder. */
const TOKEN_BACKFILL_RETRY_MS = [500, 1500, 3500] as const

/** Fill a record's identity token after the spawn, without blocking it. A
 *  record that has since moved on (a different pid, a token already there,
 *  the service stopped) is left exactly as it is. */
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
      /* an identity we could not take is a strike we will not make */
    })
}

/** THE SESSION'S OWN HANDLE AS IDENTITY: a child this process spawned and
 *  still holds — not exited, the very pid the record names — is provably
 *  ours without any probe. The runtime keeps the process handle (win32) or
 *  the unreaped entry (posix) until the exit lands here, so the pid cannot
 *  have been recycled under us. Without this the ownership gate refused to
 *  stop a service Mercury itself had started whenever the win32 token
 *  backfill had missed, and the restart put a second copy beside it
 *  (FN-019 blocker 2). */
function ownedLiveChild(cwd: string, name: string, pid: number): boolean {
  const child = liveChildren.get(childKey(cwd, name))
  return child !== undefined && child.pid === pid && child.exitCode === null && child.signalCode === null
}

/** Reconcile one record against process truth. Never claims live from a
 *  record: a dead pid downgrades ready/running/starting → failed/stopped. */
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

// The execution plane's 'service' domain truth: reconciliation reads the
// SAME pid+start-token logic as the domain (never a second liveness path);
// a plane stop request drives the real stop ladder.
installServiceExecutionDomain({
  reconcile: (cwd, name) => reconcileRecord(cwd, name),
  stop: (cwd, name) => stopService(cwd, name),
})

// ── readiness ───────────────────────────────────────────────────────────────

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
        // The log file APPENDS across starts of the same name — readiness
        // must only read THIS generation's bytes, or a previous run's READY
        // line satisfies a new start that hasn't come up (caught by the
        // journey proof).
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

/** Poll readiness until met or deadline; returns the final per-condition
 *  truth either way (a timeout names exactly what stayed unmet). */
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

// ── lifecycle ───────────────────────────────────────────────────────────────

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
  // THIS generation's log offset: the file appends across starts, and log
  // readiness must never satisfy on a PREVIOUS run's line (the
  // journey proof caught exactly that — a dead fixture's READY matched a
  // restart that hadn't come up).
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
      // stdout+stderr both append to ONE ordered log (platform-faithful
      // interleaving; the separate-stream caveat is documented).
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
    // win32's sync probe is a 2s spawnSync of pwsh with a CIM query — on a
    // slow disk it MISSES, and a null token is what let the stop strike an
    // unverifiable pid (FN-015 rank 6). POSIX's `ps` is cheap enough to
    // take inline; win32 takes it asynchronously, below.
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
  // The late identity: never blocks the spawn, and lands only while the
  // record still names THIS pid with no token of its own.
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
    // Bounded-backoff auto-restart on failure (explicit stop suppresses).
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

/**
 * Signal a service pid with platform-honest semantics: POSIX gets the real
 * signal (TERM graceful, KILL hard); win32 has no signal ladder — every kill
 * is TerminateProcess — so send the unconditional default instead of a POSIX
 * signal name.
 */
function signalPid(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    process.kill(pid)
  } else {
    process.kill(pid, signal)
  }
}

export type ServiceStrikeVerdict = 'no-process' | 'strike' | 'refuse-unverified' | 'refuse-reused'

/**
 * PURE: may this stop STRIKE the recorded pid?
 *
 * A stop that cannot prove the pid is still the process it started must
 * never force-kill it: the escalation ran taskkill /T /F against whatever
 * process now held a recorded pid, ending an unrelated program and its
 * whole descendant tree with no warning (FN-015 rank 6). `startToken` is
 * the identity that pairs with the pid; a record without one, or a probe
 * that could not answer, is an UNVERIFIABLE pid — and an unverifiable pid
 * is not ours. Only a token that matches earns the strike.
 *
 * `currentToken`: the live probe's answer — the token, '' when the pid is
 * gone, null when the probe itself could not run.
 *
 * `ownedHandle`: this process spawned the pid and still holds its live
 * child handle (ownedLiveChild) — an identity stronger than any token, and
 * the one the win32 backfill miss cannot take away.
 */
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

/** The refusal's sentence — what the operator is told instead of a strike. */
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
  // Mark explicit FIRST so the exit handler and reconciliation read stopped.
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

  // OWNERSHIP BEFORE FORCE (FN-015 rank 6). The identity probe is awaited
  // here — the stop is not a render path, and a strike decided on a stale
  // cache is exactly the mistake this gate exists to stop. A child this
  // session still holds needs no probe at all (FN-019 blocker 2).
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
    // The WHOLE TREE, first strike: win32 has no signal ladder (every kill
    // is TerminateProcess) and a root-only kill orphaned the listener a
    // `.cmd` shim / `cmd /c` / `python -m` wrapper spawned — the record
    // then read 'stopped', pid nulled, while netstat still showed the
    // grandchild LISTENING on the port the restart could not bind
    // (TASK-017 S2, service-stop-kills-root-only). endProcessTree is the
    // estate's one cross-platform tree owner (taskkill /T /F under the
    // hood) and never rejects.
    await endProcessTree(record.pid, 'SIGKILL')
  } else {
    try {
      signalPid(record.pid, 'SIGTERM')
    } catch {
      /* already gone */
    }
  }
  // Bounded escalation (posix: the TERM grace, then a TREE strike so
  // descendants go with the root; win32: the strike already ran — the loop
  // confirms the reap).
  const deadline = Date.now() + 5_000
  while (Date.now() < deadline) {
    if (!processAlive(record.pid, record.startToken)) break
    await new Promise(r => setTimeout(r, 100))
  }
  if (processAlive(record.pid, record.startToken)) {
    // The identity is re-checked at the SECOND strike too: the grace window
    // is long enough for the pid to be recycled under us.
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
    // FN-019 blocker 2: a stop that REFUSED to strike is not a stop. The
    // record reads 'stopped' with its pid cleared and nothing was killed;
    // starting now would put a second copy beside a server that may still
    // hold the port and print "restarted" over it, with the old process
    // unreachable from Mercury from then on. The refusal is the restart's
    // failure; the start is the operator's call once they have looked.
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

/** Write to the live child's stdin — only the SPAWNING session holds it. */
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

// ── logs (ordered byte cursors) ─────────────────────────────────────────────

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
    // Tail mode: start near the end (bounded window).
    start = Math.max(0, size - 64 * 1024)
  }
  if (start >= size) return { lines: [], nextCursor: size, eof: true, totalBytes: size }
  const text = await new Promise<string>((resolve, reject) => {
    // Bytes first, decode once: per-chunk toString() splits multi-byte
    // UTF-8 at stream chunk boundaries into replacement chars (the
    // fixture-capture class; byte-ranged slice edges remain the
    // cursor contract's own concern).
    const chunks: Buffer[] = []
    createReadStream(record.logFile, { start, end: Math.min(size - 1, start + 512 * 1024) })
      .on('data', chunk => {
        chunks.push(chunk as Buffer)
      })
      .on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      .on('error', reject)
  }).catch(() => '')
  let lines = text.split('\n')
  // Drop a trailing partial (unless at eof).
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
