import net from 'node:net'
import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { getMercuryHome } from '../utils/envUtils.js'
import { logForDebugging } from '../utils/debug.js'
import { controlSockPath } from './controlSocket.js'
import { vendoredNodeBeside } from './daemonBuild.js'
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

export interface DeployedRuntimeV1 {
  script: string
  buildTree: string | null
  dir: string
  node: string | null
}

export const RUNTIME_POINTER_NAMES = ['current', 'dist'] as const

export function deployedRuntime(home: string = getMercuryHome()): DeployedRuntimeV1 | null {
  for (const name of RUNTIME_POINTER_NAMES) {
    const dir = join(home, 'runtime', name)
    const script = join(dir, 'mercury.mjs')
    if (!existsSync(script)) continue
    let buildTree: string | null = null
    try {
      const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8')) as { buildTree?: unknown }
      buildTree = typeof manifest.buildTree === 'string' ? manifest.buildTree.slice(0, 12) : null
    } catch {
      buildTree = null
    }
    return { script, buildTree, dir, node: vendoredNodeBeside(dir) }
  }
  return null
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
