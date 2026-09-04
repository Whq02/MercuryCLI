
import net from 'node:net'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { readFileSync, unlinkSync } from 'node:fs'
import { flagEnv } from '../substrate/flagRegistry.js'
import {
  mkdir,
  readFile,
  writeFile,
  unlink,
  chmod,
} from 'node:fs/promises'
import { platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquirePidLock, noteLockRelease, releasePidLock } from '../substrate/pidLock.js'
import { getMercuryHome } from '../utils/envUtils.js'
import { logForDebugging } from '../utils/debug.js'
import { recordSpawnExit } from '../utils/spawnLedger.js'
import {
  MERCURY_DAEMON_PROTO,
  MIN_PROTO,
  encodeFrame,
  type DaemonReply,
  type DaemonRequest,
} from './protocol.js'

declare const MACRO: { VERSION: string }

function configHome(): string {
  return getMercuryHome()
}

export function daemonDir(): string {
  const override = flagEnv('MERCURY_DAEMON_DIR')
  if (override && override.trim() !== '') return override
  return join(configHome(), 'daemon')
}

const SUN_PATH_SAFE_MAX = 100
export function controlSockPath(): string {
  if (platform() === 'win32') {
    const h = createHash('sha1').update(daemonDir()).digest('hex').slice(0, 12)
    return `\\\\.\\pipe\\hermes-daemon-${h}`
  }
  const preferred = join(daemonDir(), 'control.sock')
  if (Buffer.byteLength(preferred, 'utf8') <= SUN_PATH_SAFE_MAX) return preferred
  const h = createHash('sha1').update(daemonDir()).digest('hex').slice(0, 12)
  return join(tmpdir(), `hermes-daemon-${h}.sock`)
}

export function supervisorStatePath(): string {
  return join(daemonDir(), 'supervisor.json')
}

export function controlKeyPath(): string {
  return join(daemonDir(), 'control.key')
}


export interface SupervisorState {
  pid: number
  version: string
  origin: 'transient'
  startedAt: number
  dir: string
  controlSock: string
  proto?: number
  buildTree?: string | null
  ownerPid?: number | null
  foreground?: boolean
  startToken?: string | null
}

export async function readSupervisorState(): Promise<SupervisorState | null> {
  try {
    const raw = await readFile(supervisorStatePath(), 'utf8')
    const parsed = JSON.parse(raw)
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof parsed.pid === 'number' &&
      typeof parsed.startedAt === 'number'
    ) {
      return parsed as SupervisorState
    }
    return null
  } catch {
    return null
  }
}

export async function writeSupervisorState(
  state: SupervisorState,
): Promise<void> {
  try {
    await mkdir(daemonDir(), { recursive: true })
    await writeFile(supervisorStatePath(), JSON.stringify(state, null, 2), 'utf8')
  } catch (e) {
    logForDebugging(`[daemon] could not write supervisor state: ${e}`)
  }
}

export function ownsControlPlaneSync(): boolean {
  try {
    const raw = JSON.parse(readFileSync(supervisorStatePath(), 'utf8')) as { pid?: number }
    return raw?.pid === process.pid
  } catch {
    return false
  }
}

export async function reassertControlKey(key: string): Promise<void> {
  try {
    await mkdir(daemonDir(), { recursive: true })
    await writeFile(controlKeyPath(), key, { encoding: 'utf8', mode: 0o600 })
    await chmod(controlKeyPath(), 0o600).catch(() => {})
  } catch (e) {
    logForDebugging(`[daemon] control-key reassert failed: ${e}`)
  }
}

export async function clearSupervisorState(): Promise<void> {
  if (!ownsControlPlaneSync()) return
  await unlink(supervisorStatePath()).catch(() => {})
}

export async function clearDeadSupervisorRecords(): Promise<void> {
  await unlink(supervisorStatePath()).catch(() => {})
  await unlink(join(daemonDir(), 'supervisor.lock')).catch(() => {})
  await unlink(controlKeyPath()).catch(() => {})
}

export async function clearControlKey(): Promise<void> {
  if (!ownsControlPlaneSync()) return
  await unlink(controlKeyPath()).catch(() => {})
}

export function supervisorExitTeardownSync(reason: string, exitCode?: number): void {
  const keptFiles: string[] = []
  if (ownsControlPlaneSync()) {
    for (const p of [supervisorStatePath(), join(daemonDir(), 'supervisor.lock'), controlKeyPath()]) {
      try {
        unlinkSync(p)
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
          keptFiles.push(`${p.split(/[\\/]/).pop() ?? p}:${(e as NodeJS.ErrnoException).code ?? 'EUNKNOWN'}`)
        }
      }
    }
  }
  recordSpawnExit({
    kind: 'supervisor',
    event: 'exit',
    id: 'supervisor',
    pid: process.pid,
    reason: keptFiles.length > 0 ? `${reason} (sweep-failed: ${keptFiles.join(', ')})` : reason,
  })
  if (reason === 'exit-before-teardown') {
    try {
      process.stderr.write(
        `[daemon] exit (code ${exitCode ?? process.exitCode ?? '?'}) WITHOUT a shutdown road — no signal, no shutdown RPC, no crash handler spoke; records ${keptFiles.length > 0 ? `KEPT (${keptFiles.join(', ')})` : 'swept'}. Re-run under node --trace-exit to name the exit site.\n`,
      )
    } catch {
    }
  }
}


export async function mintControlKey(): Promise<string> {
  const key = randomBytes(32).toString('hex')
  await mkdir(daemonDir(), { recursive: true })
  await writeFile(controlKeyPath(), key, { mode: 0o600 })
  await chmod(controlKeyPath(), 0o600).catch(() => {})
  return key
}

export async function readControlKey(): Promise<string | null> {
  try {
    return (await readFile(controlKeyPath(), 'utf8')).trim() || null
  } catch {
    return null
  }
}

let controlKeyMemo: string | null = null
export function clearControlKeyMemo(): void {
  controlKeyMemo = null
}
async function controlKeyForStamp(): Promise<string | null> {
  if (controlKeyMemo !== null) {
    controlSocketCensus.keyMemoHits++
    return controlKeyMemo
  }
  controlSocketCensus.keyReads++
  const key = await readControlKey()
  if (key !== null) controlKeyMemo = key
  return key
}
let lastUnreachableAt = 0
export function daemonLastUnreachableAt(): number {
  return lastUnreachableAt
}
export const controlSocketCensus = { keyReads: 0, keyMemoHits: 0, eauthRetries: 0 }

export function verifyControlAuth(
  presented: string | undefined,
  serverKey: string | null,
): boolean {
  if (!presented || !serverKey) return false
  if (presented.length !== serverKey.length) return false
  let diff = 0
  for (let i = 0; i < serverKey.length; i++) {
    diff |= presented.charCodeAt(i) ^ serverKey.charCodeAt(i)
  }
  return diff === 0
}


const AUTH_STAMPED_OPS: ReadonlySet<string> = new Set([
  'list',
  'has',
  'status',
  'dispatch',
  'reply',
  'kill',
  'reconfigure',
  'envelope',
  'crewSpawn',
  'sessionAdmit',
  'sessionDispatch',
  'sessionList',
  'sessionControl',
  'sessionRelease',
  'sessionRewind',
  'concourseAdmit',
  'concourseDispatch',
  'concourseList',
  'concourseControl',
  'concourseRelease',
  'concourseWithdraw',
  'concourseWarm',
  'restart-when-idle',
  'signIns',
])


const SESSION_OP_DOWNGRADES: Record<string, string> = {
  sessionAdmit: 'concourseAdmit',
  sessionDispatch: 'concourseDispatch',
  sessionList: 'concourseList',
  sessionRelease: 'concourseRelease',
  sessionControl: 'concourseControl',
}

export function sessionOpWireFrame<T extends { op: string; proto?: number }>(outbound: T): T {
  const proto = outbound.proto ?? MERCURY_DAEMON_PROTO
  const old = proto < 3 ? SESSION_OP_DOWNGRADES[outbound.op] : undefined
  if (old === undefined) return outbound
  const frame = { ...outbound, op: old } as T & { workerId?: string; runnerId?: string }
  if (old === 'concourseRelease' && typeof frame.runnerId === 'string') {
    frame.workerId = frame.runnerId
    delete frame.runnerId
  }
  return frame
}

export function normalizeSessionOpReply(reply: DaemonReply): DaemonReply {
  if (!('op' in reply) || typeof reply.op !== 'string') return reply
  let out: DaemonReply & { op: string } = reply
  for (const [nu, old] of Object.entries(SESSION_OP_DOWNGRADES)) {
    if (out.op === old) out = { ...out, op: nu } as DaemonReply & { op: string }
  }
  const fielded = out as DaemonReply & { workerId?: string; runnerId?: string }
  if (typeof fielded.workerId === 'string' && fielded.runnerId === undefined) {
    return { ...fielded, runnerId: fielded.workerId } as DaemonReply
  }
  return out
}


let negotiated: { proto: number; version: string | null } | null = null

export function noteDaemonProto(proto: number, version?: string | null): void {
  if (!Number.isInteger(proto) || proto < MIN_PROTO) return
  negotiated = { proto, version: version ?? negotiated?.version ?? null }
}

export function negotiatedDaemonProto(): { proto: number; version: string | null } | null {
  return negotiated === null ? null : { ...negotiated }
}

export function forgetDaemonProtoForTesting(): void {
  negotiated = null
}

function protoToStamp(): number {
  if (negotiated === null) return MERCURY_DAEMON_PROTO
  return Math.max(MIN_PROTO, Math.min(MERCURY_DAEMON_PROTO, negotiated.proto))
}

export async function daemonControlRpc(
  req: DaemonRequest,
  opts: { timeoutMs?: number; protoRetry?: boolean } = {},
): Promise<DaemonReply> {
  const timeoutMs = opts.timeoutMs ?? 2000
  const outbound: DaemonRequest & { proto?: number; auth?: string } = { ...req }
  const stamped = AUTH_STAMPED_OPS.has(req.op)
  if (stamped) {
    outbound.proto = protoToStamp()
    const key = await controlKeyForStamp()
    if (key) outbound.auth = key
  } else if (outbound.proto === undefined) {
    outbound.proto = protoToStamp()
  }

  let reply = await rpcOnce(sessionOpWireFrame(outbound), timeoutMs)
  if (!reply.ok && reply.code === 'ENOCONN') lastUnreachableAt = Date.now()
  if (stamped && !reply.ok && reply.code === 'EAUTH') {
    const stale = outbound.auth
    clearControlKeyMemo()
    const fresh = await controlKeyForStamp()
    if (fresh !== null && fresh !== stale) {
      controlSocketCensus.eauthRetries++
      outbound.auth = fresh
      reply = await rpcOnce(sessionOpWireFrame(outbound), timeoutMs)
      if (!reply.ok && reply.code === 'ENOCONN') lastUnreachableAt = Date.now()
    }
  }
  if (
    opts.protoRetry !== false &&
    !reply.ok &&
    reply.code === 'EPROTO' &&
    typeof reply.serverProto === 'number' &&
    Number.isInteger(reply.serverProto) &&
    reply.serverProto >= MIN_PROTO &&
    reply.serverProto < (outbound.proto ?? MERCURY_DAEMON_PROTO)
  ) {
    noteDaemonProto(reply.serverProto, reply.serverVersion ?? null)
    logForDebugging(
      `[daemon] ${req.op}: daemon speaks proto ${reply.serverProto} (this build ${MERCURY_DAEMON_PROTO}) — re-sent in its dialect`,
    )
    return normalizeSessionOpReply(await rpcOnce(sessionOpWireFrame({ ...outbound, proto: reply.serverProto }), timeoutMs))
  }
  return normalizeSessionOpReply(reply)
}

function rpcOnce(outbound: DaemonRequest & { proto?: number; auth?: string }, timeoutMs: number): Promise<DaemonReply> {
  return new Promise<DaemonReply>(resolve => {
    let settled = false
    const finish = (reply: DaemonReply) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        sock.destroy()
      } catch {
      }
      resolve(reply)
    }

    const sock = net.connect(controlSockPath())
    const collected: Buffer[] = []

    const timer = setTimeout(() => {
      finish({ ok: false, code: 'ETIMEOUT', error: `daemon did not answer within ${timeoutMs}ms (ETIMEOUT)` })
    }, timeoutMs)
    timer.unref?.()

    sock.on('connect', () => {
      sock.write(encodeFrame(outbound))
    })
    sock.on('data', (chunk: Buffer) => {
      collected.push(chunk)
      const joined = Buffer.concat(collected)
      const nl = joined.indexOf(10)
      if (nl < 0) return
      const line = joined.subarray(0, nl).toString('utf8')
      try {
        finish(JSON.parse(line) as DaemonReply)
      } catch {
        finish({ ok: false, code: 'EUNKNOWN', error: 'malformed daemon reply' })
      }
    })
    sock.on('error', err => {
      logForDebugging(`[daemon] control RPC transport error: ${err}`)
      finish({
        ok: false,
        code: 'ENOCONN',
        error: `daemon unreachable (${(err as NodeJS.ErrnoException).code ?? 'ENOCONN'})`,
      })
    })
    sock.on('close', () => {
      finish({ ok: false, code: 'ENOCONN', error: 'daemon closed without a reply (ENOCONN)' })
    })
  })
}


export function mintSupervisorIdentity(): string {
  return `hermes-supervisor-${randomUUID()}`
}

function supervisorLockPath(): string {
  return join(daemonDir(), 'supervisor.lock')
}

export interface SupervisorLock {
  release: () => Promise<void>
}

export async function acquireSupervisorLock(): Promise<SupervisorLock | null> {
  await mkdir(daemonDir(), { recursive: true })
  const lockPath = supervisorLockPath()
  const owner = mintSupervisorIdentity()
  const res = await acquirePidLock(lockPath, owner, {
    liveness: 'assume-alive',
    extra: { id: owner, startedAt: Date.now() },
  })
  if (!res.held) {
    if (!res.by) logForDebugging('[daemon] supervisor lock unavailable')
    return null
  }
  return {
    release: async () => {
      noteLockRelease(`supervisor lock ${lockPath}`, await releasePidLock(lockPath, owner))
    },
  }
}

export function currentVersion(): string {
  try {
    return typeof MACRO !== 'undefined' && typeof MACRO.VERSION === 'string'
      ? MACRO.VERSION
      : 'unknown'
  } catch {
    return 'unknown'
  }
}
