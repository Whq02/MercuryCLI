import net from 'node:net'
import { existsSync, readFileSync, realpathSync, renameSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
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

export function predecessorSockPath(pid: number): string {
  return `${controlSockPath()}.${pid}`
}

export function renameSocketForPredecessor(pid: number): boolean {
  const from = controlSockPath()
  if (process.platform === 'win32' || !existsSync(from)) return false
  try {
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

export interface HandoverStateV1 {
  predecessorPid: number
  sockPath: string
  alive(): boolean
  holds(runnerId: string): boolean
  heldRunners(): Set<string>
  runnerOfSession(sessionId: string): string | undefined
}

export function handoverState(
  predecessorPid: number,
  rosterHas: (short: string) => boolean,
  records: () => HeldRecordV1[],
): HandoverStateV1 {
  const alive = (): boolean => isProcessAlive(predecessorPid)
  const held = (): Map<string, HeldRecordV1> => {
    const out = new Map<string, HeldRecordV1>()
    if (!alive()) return out
    for (const r of records()) {
      if (r.endedAt !== undefined || r.pid === undefined || rosterHas(r.runnerId)) continue
      if (isProcessAlive(r.pid)) out.set(r.runnerId, r)
    }
    return out
  }
  return {
    predecessorPid,
    sockPath: predecessorSockPath(predecessorPid),
    alive,
    holds: runnerId => held().has(runnerId),
    heldRunners: () => new Set(held().keys()),
    runnerOfSession: sessionId => [...held().values()].find(r => r.sessionId === sessionId)?.runnerId,
  }
}

const SESSION_FIELDS = ['sessionId', 'targetSessionId', 'resumeSessionId'] as const

export function handoverRoadOf(op: string, raw: Record<string, unknown>, state: HandoverStateV1): 'here' | 'predecessor' {
  if (!state.alive()) return 'here'
  for (const field of SESSION_FIELDS) {
    const value = raw[field]
    if (typeof value === 'string' && value !== '' && state.runnerOfSession(value) !== undefined) return 'predecessor'
  }
  for (const field of ['short', 'runnerId', 'workerId'] as const) {
    const value = raw[field]
    if (typeof value === 'string' && value !== '' && state.holds(value)) return 'predecessor'
  }
  void op
  return 'here'
}
