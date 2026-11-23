
import net from 'node:net'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, unlinkSync } from 'node:fs'
import {
  mkdir,
  readFile,
  writeFile,
  unlink,
  chmod,
  stat,
} from 'node:fs/promises'
import { loadavg, platform, tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquirePidLock, noteLockRelease, releasePidLock } from '../substrate/pidLock.js'
import { daemonDir, daemonStatePath, readDaemonState, type DaemonState } from '../utils/daemonState.js'
import { directoryIdentity } from '../utils/directoryIdentity.js'
import { isProcessAlive } from '../utils/ownerWatch.js'
import { availableCores } from '../utils/availableCores.js'
import { logForDebugging } from '../utils/debug.js'
import { posixFileModesApply } from '../utils/platform/files.js'
import { errorMessage, getErrnoCode } from '../utils/errors.js'
import { recordSpawnExit } from './spawnLedger.js'
import { daemonHomeStands, publishInDaemonHome } from './daemonHome.js'
import {
  MERCURY_DAEMON_PROTO,
  MIN_PROTO,
  encodeFrame,
  verbBornAt,
  type DaemonReply,
  type DaemonReplyTo,
  type DaemonRequest,
} from './protocol.js'
import { SESSION_VERBS, type SessionVerbRow } from '../runner/wire/sessionVerbs.js'
import { passedOver } from '../utils/passedOver.js'
import { startTimeout, stopTimeout } from '../utils/timers.js'

declare const MACRO: { VERSION: string }

export { daemonDir, daemonStatePath, readDaemonState, type DaemonState }

const SUN_PATH_SAFE_MAX = 100
export function controlSockPath(hostPlatform: string = platform()): string {
  if (hostPlatform === 'win32') {
    const dir = daemonDir()
    mkdirSync(dir, { recursive: true })
    const h = createHash('sha1').update(directoryIdentity(dir).key).digest('hex').slice(0, 12)
    return `\\\\.\\pipe\\hermes-daemon-${h}`
  }
  const preferred = join(daemonDir(), 'control.sock')
  if (Buffer.byteLength(preferred, 'utf8') <= SUN_PATH_SAFE_MAX) return preferred
  const h = createHash('sha1').update(daemonDir()).digest('hex').slice(0, 12)
  return join(tmpdir(), `hermes-daemon-${h}.sock`)
}

export function controlConnectPath(hostPlatform: string = platform()): string {
  try {
    const state = JSON.parse(readFileSync(daemonStatePath(), 'utf8')) as DaemonState
    const local = typeof state.controlSock === 'string' && (hostPlatform === 'win32'
      ? state.controlSock.startsWith('\\\\.\\pipe\\hermes-daemon-') && /^[0-9a-f]{12}$/.test(state.controlSock.slice('\\\\.\\pipe\\hermes-daemon-'.length))
      : state.controlSock.startsWith('/'))
    if (local && Number.isInteger(state.pid) && state.pid > 0 && isProcessAlive(state.pid)) return state.controlSock
  } catch (error) {
    passedOver(error)
  }
  return controlSockPath(hostPlatform)
}

export function controlKeyPath(): string {
  return join(daemonDir(), 'control.key')
}



export async function writeDaemonState(
  state: DaemonState,
): Promise<void> {
  try {
    if (!daemonHomeStands('the daemon record')) return
    publishInDaemonHome('the daemon record', daemonStatePath(), JSON.stringify(state, null, 2))
  } catch (e) {
    logForDebugging(`[daemon] could not write the daemon record: ${e}`)
  }
}

export function markDaemonStoppingSync(now = Date.now()): boolean {
  if (!daemonHomeStands('the daemon record')) return false
  const path = daemonStatePath()
  let current: DaemonState
  try {
    current = JSON.parse(readFileSync(path, 'utf8')) as DaemonState
  } catch (error) {
    passedOver(error)
    return false
  }
  if (current?.pid !== process.pid) return false
  try {
    return publishInDaemonHome('the daemon record', path, JSON.stringify({ ...current, state: 'stopping', stoppingAt: now }, null, 2)) === 'published'
  } catch (e) {
    logForDebugging(`[daemon] could not mark the daemon record stopping: ${e}`)
    return false
  }
}

export function ownsControlPlaneSync(): boolean {
  try {
    const raw = JSON.parse(readFileSync(daemonStatePath(), 'utf8')) as { pid?: number }
    return raw?.pid === process.pid
  } catch (error) {
    passedOver(error)
    return false
  }
}

export async function reassertControlKey(key: string): Promise<void> {
  try {
    if (!daemonHomeStands('the control key')) return
    publishInDaemonHome('the control key', controlKeyPath(), key, { mode: 0o600 })
  } catch (e) {
    logForDebugging(`[daemon] control-key reassert failed: ${e}`)
  }
}

export async function clearDaemonState(): Promise<void> {
  if (!ownsControlPlaneSync()) return
  await unlink(daemonStatePath()).catch(passedOver)
}

export async function clearDeadDaemonRecords(): Promise<void> {
  await unlink(daemonStatePath()).catch(passedOver)
  await unlink(join(daemonDir(), 'daemon.lock')).catch(passedOver)
  await unlink(controlKeyPath()).catch(passedOver)
}

export async function clearControlKey(): Promise<void> {
  if (!ownsControlPlaneSync()) return
  await unlink(controlKeyPath()).catch(passedOver)
}

export function daemonExitTeardownSync(reason: string, exitCode?: number): void {
  const keptFiles: string[] = []
  if (ownsControlPlaneSync()) {
    for (const p of [daemonStatePath(), join(daemonDir(), 'daemon.lock'), controlKeyPath()]) {
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
    kind: 'daemon',
    event: 'exit',
    id: 'daemon',
    pid: process.pid,
    reason: keptFiles.length > 0 ? `${reason} (sweep-failed: ${keptFiles.join(', ')})` : reason,
  })
  if (reason === 'exit-before-teardown') {
    try {
      process.stderr.write(
        `[daemon] exit (code ${exitCode ?? process.exitCode ?? '?'}) WITHOUT a shutdown road — no signal, no shutdown RPC, no crash handler spoke; records ${keptFiles.length > 0 ? `KEPT (${keptFiles.join(', ')})` : 'swept'}. Re-run under node --trace-exit to name the exit site.\n`,
      )
    } catch (error) {
      passedOver(error)
    }
  }
}


export async function mintControlKey(): Promise<string> {
  const key = randomBytes(32).toString('hex')
  await mkdir(daemonDir(), { recursive: true })
  await writeFile(controlKeyPath(), key, { mode: 0o600 })
  await chmod(controlKeyPath(), 0o600).catch(async (err: unknown) => {
    if (!posixFileModesApply()) return
    const path = controlKeyPath()
    const code = getErrnoCode(err) ?? errorMessage(err)
    let owner: number
    try {
      owner = (await stat(path)).uid
    } catch (statErr) {
      console.error(`[daemon] the control key ${path} could not be made private (${code}) and its owner could not be read (${getErrnoCode(statErr) ?? errorMessage(statErr)}), so it is used as it was written`)
      return
    }
    if (owner !== process.getuid?.()) {
      throw new Error(`the control key ${path} belongs to another user and could not be made private (${code}) — remove it and start the daemon again`)
    }
    console.error(`[daemon] the control key ${path} could not be made private (${code}): its filesystem takes no file mode`)
  })
  return key
}

export async function readControlKey(): Promise<string | null> {
  try {
    return (await readFile(controlKeyPath(), 'utf8')).trim() || null
  } catch (error) {
    passedOver(error)
    return null
  }
}

export async function readLiveControlKey(): Promise<string | null> {
  try {
    return (await readFile(controlKeyPath(), 'utf8')).trim() || null
  } catch (error) {
    if (getErrnoCode(error) === 'ENOENT') return null
    throw error
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
export const controlSocketCensus = { keyReads: 0, keyMemoHits: 0, eauthRetries: 0, waitsExtended: 0, waitsEndedDead: 0, waitsEndedIdle: 0 }

let boxReadingForTesting: { load1: number; cores: number } | null = null

export function setBoxReadingForTesting(reading: { load1: number; cores: number } | null): void {
  boxReadingForTesting = reading
}

export function answerCeilingMs(timeoutMs: number, box: { load1: number; cores: number } = boxReadingForTesting ?? { load1: loadavg()[0] ?? 0, cores: availableCores() }): number {
  const perCore = box.cores > 0 && Number.isFinite(box.load1) ? box.load1 / box.cores : 0
  return Math.round(timeoutMs * Math.max(1, perCore))
}

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


const DAEMON_WIDE_AUTH_OPS = ['list', 'has', 'status', 'dispatch', 'reply', 'kill', 'reconfigure'] as const

const ALIASED_SESSION_ROWS = (Object.values(SESSION_VERBS) as readonly SessionVerbRow[])
  .filter(
    (row): row is SessionVerbRow & { daemon: { op: string; legacyOp: string; bornAt?: number; bornOrder?: number } } =>
      row.daemon?.legacyOp !== undefined,
  )
  .sort((a, b) => (a.daemon.bornOrder ?? 0) - (b.daemon.bornOrder ?? 0))

const AUTH_STAMPED_OPS: ReadonlySet<string> = (() => {
  const ops = new Set<string>(DAEMON_WIDE_AUTH_OPS)
  for (const row of Object.values(SESSION_VERBS) as readonly SessionVerbRow[]) {
    const d = row.daemon
    if (!d || d.auth === false) continue
    ops.add(d.op)
    if (d.legacyOp !== undefined) ops.add(d.legacyOp)
  }
  return ops
})()

const SESSION_OP_DOWNGRADES: Readonly<Record<string, { legacyOp: string; bornAt: number }>> = Object.fromEntries(
  ALIASED_SESSION_ROWS.map(row => [row.daemon.op, { legacyOp: row.daemon.legacyOp, bornAt: row.daemon.bornAt ?? 3 }]),
)

export const SESSION_OP_ALIASES: Readonly<Record<string, string>> = Object.fromEntries(
  ALIASED_SESSION_ROWS.map(row => [row.daemon.legacyOp, row.daemon.op]),
)

export function sessionOpWireFrame<T extends { op: string; proto?: number }>(outbound: T): T {
  const proto = outbound.proto ?? MERCURY_DAEMON_PROTO
  const downgrade = Object.hasOwn(SESSION_OP_DOWNGRADES, outbound.op) ? SESSION_OP_DOWNGRADES[outbound.op] : undefined
  const old = downgrade !== undefined && proto < downgrade.bornAt ? downgrade.legacyOp : undefined
  if (old === undefined) return outbound
  const frame = { ...outbound, op: old } as T & { workerId?: string; runnerId?: string }
  if (old === SESSION_VERBS.sessionRelease.daemon.legacyOp && typeof frame.runnerId === 'string') {
    frame.workerId = frame.runnerId
    delete frame.runnerId
  }
  return frame
}

export function normalizeSessionOpReply(reply: DaemonReply): DaemonReply {
  if (!('op' in reply) || typeof reply.op !== 'string') return reply
  let out: DaemonReply & { op: string } = reply
  if (Object.hasOwn(SESSION_OP_ALIASES, out.op)) {
    out = { ...out, op: SESSION_OP_ALIASES[out.op]! } as DaemonReply & { op: string }
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

export type DaemonRpcRequest = DaemonRequest extends infer R
  ? R extends { proto: number }
    ? Omit<R, 'proto'> & { proto?: number }
    : R
  : never

export async function daemonControlRpc<Op extends DaemonRpcRequest['op']>(
  req: DaemonRpcRequest & { op: Op },
  opts?: { timeoutMs?: number; protoRetry?: boolean },
): Promise<DaemonReplyTo<Op> & { frameWritten?: boolean }>
export async function daemonControlRpc(
  req: DaemonRpcRequest,
  opts: { timeoutMs?: number; protoRetry?: boolean } = {},
): Promise<DaemonReply & { frameWritten?: boolean }> {
  const timeoutMs = opts.timeoutMs ?? 2000
  const outbound: DaemonRpcRequest & { proto?: number; auth?: string } = { ...req }
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
    return speakProtoGap(req, normalizeSessionOpReply(await rpcOnce(sessionOpWireFrame({ ...outbound, proto: reply.serverProto }), timeoutMs)))
  }
  return speakProtoGap(req, normalizeSessionOpReply(reply))
}


export function restartDaemonWords(binary = 'mercury'): string {
  return `restart the daemon: \`${binary} daemon restart\``
}

function isUnknownVerbShape(error: string, action?: string): boolean {
  if (/^unknown op\b/i.test(error)) return true
  return action !== undefined && /requires \{ action:/.test(error) && !error.includes(`|${action}|`) && !error.includes(`|${action},`) && !error.includes(`action: ${action}`)
}

export function olderDaemonRefusalLine(verb: string, needs: number, daemon: { proto: number; version: string | null } | null): string {
  const who =
    daemon === null
      ? 'the daemon is an older build'
      : `the daemon is an older build (protocol ${daemon.proto}${daemon.version !== null ? `, v${daemon.version}` : ''}; this Mercury speaks ${MERCURY_DAEMON_PROTO})`
  return `${who}: \`${verb}\` needs protocol ${needs} · ${restartDaemonWords()}`
}

function speakProtoGap(req: DaemonRpcRequest, reply: DaemonReply): DaemonReply {
  if (reply.ok || reply.code !== 'EUNKNOWN') return reply
  const action = typeof (req as { action?: unknown }).action === 'string' ? (req as { action: string }).action : undefined
  if (!isUnknownVerbShape(reply.error, action)) return reply
  const needs = verbBornAt(req.op, action)
  if (negotiated !== null && negotiated.proto >= needs) return reply
  const verb = action !== undefined ? `${req.op} ${action}` : req.op
  return { ...reply, error: olderDaemonRefusalLine(verb, needs, negotiated), refusal: 'daemon-older' }
}

function daemonServes(timeoutMs: number): Promise<{ serves: boolean; working: number | null }> {
  return rpcOnce({ op: 'ping', proto: protoToStamp() } as DaemonRequest & { proto?: number }, timeoutMs, { probe: true }).then(reply => {
    const working = (reply as { working?: unknown }).working
    return { serves: reply.ok === true, working: typeof working === 'number' && Number.isFinite(working) ? working : null }
  })
}

function rpcOnce(outbound: DaemonRpcRequest & { proto?: number; auth?: string }, timeoutMs: number, opts: { probe?: boolean } = {}): Promise<DaemonReply & { frameWritten?: boolean }> {
  return new Promise<DaemonReply & { frameWritten?: boolean }>(resolve => {
    let settled = false
    let frameWritten = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const startedAt = Date.now()
    const ceilingMs = opts.probe === true ? timeoutMs : answerCeilingMs(timeoutMs)
    const finish = (reply: DaemonReply, transportFailure = false) => {
      if (settled) return
      settled = true
      if (timer !== undefined) stopTimeout(timer)
      try {
        sock.destroy()
      } catch (error) {
        passedOver(error)
      }
      resolve(transportFailure ? { ...reply, frameWritten } : reply)
    }
    const expired = (): void => {
      finish({ ok: false, code: 'ETIMEOUT', error: `daemon did not answer within ${Date.now() - startedAt}ms (ETIMEOUT)` }, true)
    }
    const arm = (ms: number): void => {
      timer = startTimeout(() => {
        if (settled) return
        if (opts.probe === true || !frameWritten) {
          expired()
          return
        }
        void daemonServes(timeoutMs).then(pong => {
          if (settled) return
          if (!pong.serves) {
            controlSocketCensus.waitsEndedDead++
            expired()
            return
          }
          if (pong.working !== null) {
            if (pong.working === 0) {
              controlSocketCensus.waitsEndedIdle++
              expired()
              return
            }
            controlSocketCensus.waitsExtended++
            arm(timeoutMs)
            return
          }
          const left = ceilingMs - (Date.now() - startedAt)
          if (left <= 0) {
            expired()
            return
          }
          controlSocketCensus.waitsExtended++
          arm(Math.min(timeoutMs, left))
        })
      }, ms)
      timer.unref?.()
    }

    const sock = net.connect(controlConnectPath())
    const collected: Buffer[] = []

    arm(timeoutMs)

    sock.on('connect', () => {
      if (settled) return
      frameWritten = true
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
        finish({ ok: false, code: 'EBADMSG', error: 'malformed daemon reply' }, true)
      }
    })
    sock.on('error', err => {
      logForDebugging(`[daemon] control RPC transport error: ${err}`)
      finish({
        ok: false,
        code: 'ENOCONN',
        error: `daemon unreachable (${(err as NodeJS.ErrnoException).code ?? 'ENOCONN'})`,
      }, true)
    })
    sock.on('close', () => {
      finish({ ok: false, code: 'ENOCONN', error: 'daemon closed without a reply (ENOCONN)' }, true)
    })
  })
}


export function mintDaemonIdentity(): string {
  return `hermes-daemon-${randomUUID()}`
}

function daemonLockPath(): string {
  return join(daemonDir(), 'daemon.lock')
}

export interface DaemonLock {
  release: () => Promise<void>
}

export async function acquireDaemonLock(): Promise<DaemonLock | null> {
  await mkdir(daemonDir(), { recursive: true })
  const lockPath = daemonLockPath()
  const owner = mintDaemonIdentity()
  const res = await acquirePidLock(lockPath, owner, {
    liveness: 'assume-alive',
    extra: { id: owner, startedAt: Date.now() },
  })
  if (!res.held) {
    if (!res.by) logForDebugging('[daemon] the daemon lock is unavailable')
    return null
  }
  return {
    release: async () => {
      noteLockRelease(`daemon lock ${lockPath}`, await releasePidLock(lockPath, owner))
    },
  }
}

export function currentVersion(): string {
  try {
    return typeof MACRO !== 'undefined' && typeof MACRO.VERSION === 'string'
      ? MACRO.VERSION
      : 'unknown'
  } catch (error) {
    passedOver(error)
    return 'unknown'
  }
}
