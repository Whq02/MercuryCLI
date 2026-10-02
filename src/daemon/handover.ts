import net from 'node:net'
import { existsSync, lstatSync, readFileSync, realpathSync, renameSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { getMercuryHome } from '../utils/envUtils.js'
import { logForDebugging } from '../utils/debug.js'
import { flagEnv } from '../substrate/flagRegistry.js'
import { readCurrentVersion, resolveLayoutRoots } from '../services/privateChannel/installLayout.js'
import { payloadVendoredRuntime } from '../services/privateChannel/vendoredRuntime.js'
import { controlSockPath } from './controlSocket.js'
import { selfScriptPath, vendoredNodeBeside } from './daemonBuild.js'
import { isProcessAlive } from './ownerWatch.js'
import { encodeFrame, readControlFrame, type DaemonReply } from './protocol.js'

export const HANDOVER_FROM_ENV = 'MERCURY_DAEMON_HANDOVER_FROM'

export const HANDOVER_FORWARD_TIMEOUT_MS = 20_000

export function parseHandoverFrom(raw: string | undefined): number | null {
  const trimmed = raw?.trim()
  if (!trimmed) return null
  const pid = Number(trimmed)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

export type DeployedLayout = 'source' | 'release'

export interface DeployedRuntimeV1 {
  script: string
  buildTree: string | null
  dir: string
  node: string | null
  layout: DeployedLayout
  version: string | null
}

export const RUNTIME_POINTER_NAMES = ['current', 'dist'] as const

export interface DeployedRuntimeOptions {
  platform?: NodeJS.Platform
  runningScript?: string
}

function manifestFacts(dir: string): { buildTree: string | null; version: string | null } {
  try {
    const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { buildTree?: unknown; version?: unknown }
    return {
      buildTree: typeof manifest.buildTree === 'string' ? manifest.buildTree.slice(0, 12) : null,
      version: typeof manifest.version === 'string' && manifest.version !== '' ? manifest.version : null,
    }
  } catch {
    return { buildTree: null, version: null }
  }
}

export function sourceDeployedRuntime(home: string = getMercuryHome(), platform: NodeJS.Platform = process.platform): DeployedRuntimeV1 | null {
  for (const name of RUNTIME_POINTER_NAMES) {
    const dir = join(home, 'runtime', name)
    const script = join(dir, 'mercury.mjs')
    if (!existsSync(script)) continue
    const facts = manifestFacts(dir)
    return { script, buildTree: facts.buildTree, dir, node: vendoredNodeBeside(dir, platform), layout: 'source', version: facts.version }
  }
  return null
}

export function releaseVersionsDir(home: string = getMercuryHome()): string {
  return flagEnv('MERCURY_VERSIONS_DIR') || join(home, 'versions')
}

export function releaseDeployedRuntime(home: string = getMercuryHome(), platform: NodeJS.Platform = process.platform): DeployedRuntimeV1 | null {
  const roots = { ...resolveLayoutRoots(platform), versionsDir: releaseVersionsDir(home) }
  const version = readCurrentVersion(roots)
  if (version === null || /[\\/"]|\.\./.test(version)) return null
  const dir = join(roots.versionsDir, version)
  const script = join(dir, 'mercury.mjs')
  if (!existsSync(script)) return null
  const facts = manifestFacts(dir)
  let node: string | null = null
  try {
    node = payloadVendoredRuntime(dir)?.binaryPath ?? null
  } catch {
    node = null
  }
  return { script, buildTree: facts.buildTree, dir, node: node ?? vendoredNodeBeside(dir, platform), layout: 'release', version: facts.version ?? version }
}

function realOrResolved(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return resolve(p)
  }
}

function pathWithin(parent: string, child: string, platform: NodeJS.Platform): boolean {
  if (child === '') return false
  const fold = (p: string): string => (platform === 'win32' ? realOrResolved(p).toLowerCase() : realOrResolved(p))
  const rel = relative(fold(parent), fold(child))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export function deployedRuntime(home: string = getMercuryHome(), opts: DeployedRuntimeOptions = {}): DeployedRuntimeV1 | null {
  const platform = opts.platform ?? process.platform
  const source = sourceDeployedRuntime(home, platform)
  const release = releaseDeployedRuntime(home, platform)
  const running = opts.runningScript ?? selfScriptPath()
  if (release !== null && pathWithin(releaseVersionsDir(home), running, platform)) return release
  if (source !== null && pathWithin(join(home, 'runtime'), running, platform)) return source
  return source ?? release
}

export interface HandoverDecisionInput {
  daemonBuildTree: string | null
  deployedBuildTree: string | null
  healState: 'none' | 'restarting' | 'armed' | 'refused' | 'operator'
  live: number
}

export type HandoverDecision = { handover: true; why: string } | { handover: false; why: string }

export function decideHandover(input: HandoverDecisionInput): HandoverDecision {
  if (input.deployedBuildTree === null) return { handover: false, why: 'no deployed runtime to move onto' }
  if (input.daemonBuildTree === null) return { handover: false, why: 'the daemon carries no build tree (a source run) — nothing says it is older' }
  if (input.daemonBuildTree === input.deployedBuildTree) return { handover: false, why: 'the daemon already runs the deployed build' }
  if (input.healState === 'restarting') return { handover: false, why: 'the daemon is restarting itself as the deployed build' }
  if (input.healState === 'none') return { handover: false, why: 'no heal was asked' }
  return {
    handover: true,
    why: `the daemon's build ${input.daemonBuildTree} is not the deployed ${input.deployedBuildTree} and its restart ${input.healState === 'armed' ? `waits on ${input.live} live worker(s)` : `was refused`} — a successor on the deployed build takes the plane and the old daemon keeps what it holds`,
  }
}

const PLANE_HOME_HASH = /^hermes-daemon-([0-9a-f]+)\.sock$/

function planeHomeHash(plane: string): string | null {
  return PLANE_HOME_HASH.exec(basename(plane))?.[1] ?? null
}

export function predecessorSockPath(pid: number, plane: string = controlSockPath()): string {
  const path = `${plane}.${pid}`
  if (process.platform === 'win32' || Buffer.byteLength(path) <= 100) return path
  const hash = planeHomeHash(plane)
  return join(dirname(plane), hash === null ? `${pid}.sock` : `${hash}.${pid}.sock`)
}

export function predecessorSockPidOf(entry: string, plane: string = controlSockPath()): number | null {
  const name = basename(plane)
  if (entry.startsWith(`${name}.`)) {
    const tail = /^(\d+)$/.exec(entry.slice(name.length + 1))
    return tail === null ? null : Number(tail[1])
  }
  const hash = planeHomeHash(plane)
  const short = (hash === null ? /^(\d+)\.sock$/ : new RegExp(`^${hash}\\.(\\d+)\\.sock$`)).exec(entry)
  return short === null ? null : Number(short[1])
}

export function renameSocketForPredecessor(pid: number): boolean {
  const from = controlSockPath()
  if (process.platform === 'win32' || !existsSync(from)) return false
  try {
    if (lstatSync(from).isSymbolicLink()) return existsSync(predecessorSockPath(pid))
    renameSync(from, predecessorSockPath(pid))
    return true
  } catch (e) {
    logForDebugging(`[daemon] handover: could not rename the predecessor's socket: ${e}`)
    return false
  }
}

export function forwardFrame(sockPath: string, line: string, timeoutMs: number = HANDOVER_FORWARD_TIMEOUT_MS): Promise<DaemonReply> {
  return new Promise(resolve => {
    let settled = false
    const done = (reply: DaemonReply): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(reply)
    }
    const timer = setTimeout(() => {
      sock.destroy()
      done({ ok: false, code: 'ETIMEOUT', error: 'the daemon that holds this session did not answer in time' })
    }, timeoutMs)
    const sock = net.connect(sockPath)
    sock.on('error', () => done({ ok: false, code: 'ENOCONN', error: 'the daemon that holds this session is unreachable' }))
    sock.on('connect', () => {
      readControlFrame(
        sock,
        reply => {
          try {
            done(JSON.parse(reply) as DaemonReply)
          } catch {
            done({ ok: false, code: 'EUNKNOWN', error: 'the daemon that holds this session answered an unreadable frame' })
          }
          sock.destroy()
        },
        () => {
          done({ ok: false, code: 'ETOOLARGE', error: 'the daemon that holds this session answered past the frame cap' })
          sock.destroy()
        },
      )
      sock.write(line.endsWith('\n') ? line : encodeFrame(JSON.parse(line) as unknown))
    })
  })
}

export interface HeldRecordV1 {
  runnerId: string
  sessionId: string
  pid?: number
  endedAt?: number
}

export interface HandoverHost {
  pid: number
  runners: string[] | null
}

export async function readHandoverHosts(predecessorPid: number, auth: string): Promise<HandoverHost[]> {
  const hosts = new Map<number, HandoverHost>()
  const pending = [predecessorPid]
  while (pending.length > 0) {
    const pid = pending.shift()!
    if (pid === process.pid || hosts.has(pid) || !isProcessAlive(pid)) continue
    const path = pid === predecessorPid ? controlSockPath() : predecessorSockPath(pid)
    const hello = await forwardFrame(path, JSON.stringify({ op: 'hello' }), 3000)
    if (!hello.ok || hello.op !== 'hello' || hello.pid !== pid) {
      if (isProcessAlive(pid)) {
        logForDebugging(`[daemon] handover: pid ${pid} did not answer hello (${hello.ok ? 'another daemon answered on its path' : hello.error}) — it is read as holding every live session no other daemon names`)
        hosts.set(pid, { pid, runners: null })
      }
      continue
    }
    const list = await forwardFrame(path, JSON.stringify({ op: 'list', proto: hello.proto, auth }), 3000)
    hosts.set(pid, { pid, runners: list.ok && list.op === 'list' ? list.jobs.filter(job => !job.outcome).map(job => job.short) : null })
    for (const earlier of hello.predecessorPids ?? (hello.predecessorPid === null || hello.predecessorPid === undefined ? [] : [hello.predecessorPid])) {
      if (Number.isInteger(earlier) && earlier > 0 && !hosts.has(earlier)) pending.push(earlier)
    }
  }
  return [...hosts.values()]
}

export interface HandoverStateV1 {
  predecessorPid: number
  sockPath: string
  alive(): boolean
  predecessorPids(): number[]
  holds(runnerId: string): boolean
  heldRunners(pid?: number): Set<string>
  runnerOfSession(sessionId: string): string | undefined
  socketFor(raw: Record<string, unknown>): string | null
  forward(line: string): Promise<DaemonReply>
}

export function handoverState(
  predecessorPid: number,
  rosterHas: (short: string) => boolean,
  records: () => HeldRecordV1[],
  hosts: HandoverHost[] = [{ pid: predecessorPid, runners: null }],
): HandoverStateV1 {
  const owners = new Map(hosts.flatMap(host => (host.runners ?? []).map(runner => [runner, host.pid] as const)))
  const unnamed = hosts.find(host => host.runners === null)?.pid
  const ownerOf = (runnerId: string): number | undefined => owners.get(runnerId) ?? unnamed
  const predecessorPids = (): number[] => hosts.map(host => host.pid).filter(isProcessAlive)
  const alive = (): boolean => predecessorPids().length > 0
  const held = (): Map<string, HeldRecordV1> => {
    const out = new Map<string, HeldRecordV1>()
    const living = new Set(predecessorPids())
    for (const r of records()) {
      if (r.endedAt !== undefined || r.pid === undefined || rosterHas(r.runnerId)) continue
      const owner = ownerOf(r.runnerId)
      if (owner === undefined || !living.has(owner)) continue
      if (isProcessAlive(r.pid)) out.set(r.runnerId, r)
    }
    return out
  }
  const socketFor = (raw: Record<string, unknown>): string | null => {
    for (const r of held().values()) {
      if (SESSION_FIELDS.some(field => raw[field] === r.sessionId) || RUNNER_FIELDS.some(field => raw[field] === r.runnerId)) {
        return predecessorSockPath(ownerOf(r.runnerId)!)
      }
    }
    return null
  }
  return {
    predecessorPid,
    sockPath: predecessorSockPath(predecessorPid),
    alive,
    predecessorPids,
    holds: runnerId => held().has(runnerId),
    heldRunners: pid => new Set([...held().keys()].filter(runner => pid === undefined || ownerOf(runner) === pid)),
    runnerOfSession: sessionId => [...held().values()].find(r => r.sessionId === sessionId)?.runnerId,
    socketFor,
    forward: line => {
      const path = socketFor(JSON.parse(line) as Record<string, unknown>)
      return path === null ? Promise.resolve({ ok: false, code: 'ENOCONN', error: 'the daemon that held this session has left' }) : forwardFrame(path, line)
    },
  }
}

const SESSION_FIELDS = ['sessionId', 'targetSessionId', 'resumeSessionId'] as const
const RUNNER_FIELDS = ['short', 'runnerId', 'workerId'] as const

export function handoverRoadOf(op: string, raw: Record<string, unknown>, state: HandoverStateV1): 'here' | 'predecessor' {
  void op
  return state.socketFor(raw) === null ? 'here' : 'predecessor'
}
