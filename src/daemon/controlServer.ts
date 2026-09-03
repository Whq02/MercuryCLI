
import { refuseRunnerArgv } from '../services/switchboard/runnerArgv.js'
import net from 'node:net'
import { readFileSync } from 'node:fs'
import { unlink } from 'node:fs/promises'
import { logForDebugging } from '../utils/debug.js'
import type { DaemonBreaker } from '../utils/daemonBreaker.js'
import { flagEnv, setFlagEnv } from '../substrate/flagRegistry.js'
import {
  CONTROL_FRAME_CAP,
  MERCURY_DAEMON_PROTO,
  MIN_PROTO,
  encodeFrame,
  readControlFrame,
  type DaemonHelloFacts,
  type DaemonReply,
  type LeaseClient,
  type SessionRewindMode,
  type SessionRewindOutcomeV1,
} from './protocol.js'
import {
  controlSockPath,
  currentVersion,
  ownsControlPlaneSync,
  supervisorStatePath,
  verifyControlAuth,
} from './controlSocket.js'
import { isProcessAlive } from './ownerWatch.js'
import { validateSessionKit, validateSessionKitEdit, type SessionKitEditV1, type SessionKitV1 } from './sessionKit.js'
import { validateSaturnSubmission, SATURN_ID_PATTERN, type ScheduleOpRequestV1 } from './saturn.js'
import { parseBusEnvelope } from '../utils/swarm/busEnvelopes.js'
import { writeToMailbox } from '../utils/teammateMailbox.js'
import type { TaskRoster } from './roster.js'
import { attachToJobPty } from './runPtyHost.js'

export interface ControlServerDeps {
  roster: TaskRoster
  breaker: DaemonBreaker
  dir: string
  startedAt: number
  maxInflight: number
  controlKey: string
  isReady: () => boolean
  onShutdown: (reapWorkers: boolean) => {
    reaped: number
    workers: Array<{ short: string; kind: 'long-lived' | 'one-shot'; purpose: string; pid?: number }>
  }
  hello?: () => DaemonHelloFacts
  restartWhenIdle?: (by: string) => { state: 'restarting' | 'armed' | 'refused'; live: number; detail?: string }
  nudgeAgent?: (agentName: string) => void
  crewSpawn?: (name: string, modelKey: string) => Promise<{ ok: boolean; pid?: number; error?: string }>
  concourseAdmit?: (req: {
    effort?: string
    workspaceDir: string
    isolation?: 'exclusive' | 'shared' | 'worktree-isolated' | 'read-only'
    modelKey?: string
    title?: string
    kit?: SessionKitV1
    kitPreset?: string
    vacatingSessionId?: string
  }) => Promise<
    | {
        ok: true
        runnerId: string
        sessionId: string
        workspaceId: string
        pid?: number
        branchName?: string
        mainHolderTitle?: string
        modelId?: string
        modelDisplayName?: string
        effort?: string
        note?: string
        kitSource?: 'carried' | 'derived' | 'preset'
        liveHop?: true
        presetName?: string
        presetNote?: string
      }
    | { ok: false; error: string; code: string }
  >
  concourseDispatch?: (req: {
    clientMessageId: string
    prompt: string
    workspaceDir: string
    isolation?: 'exclusive' | 'worktree-isolated' | 'read-only'
    modelKey?: string
    effort?: string
    title?: string
    agentName?: string
    seatsMax?: 1 | 2
    resumeSessionId?: string
    targetSessionId?: string
    mode?: 'prompt' | 'bash' | 'task-notification'
    agentId?: string
    priority?: 'now' | 'next' | 'later'
    content?: unknown[]
    by?: string
    kitPreset?: string
  }) => Promise<{
    ok: boolean
    clientMessageId: string
    state: string
    stateRevision: number
    runnerId?: string
    sessionId?: string
    error?: string
    replay?: string
    heldReason?: string
    heldByTitle?: string
    moves?: Array<{ verb: string; label: string }>
    branchName?: string
    mainHolderTitle?: string
    modelId?: string
    modelDisplayName?: string
    effort?: string
    kitSource?: 'carried' | 'derived' | 'preset'
    presetName?: string
    presetNote?: string
  }>
  concourseList?: () => ReadonlyArray<Record<string, unknown>>
  concourseWithdraw?: (clientMessageId: string) => Promise<boolean>
  concourseRelease?: (runnerId: string) => { settled: boolean; killed: boolean }
  concourseWarm?: (req: { workspaceDir: string; retiring?: string; bootCarriesRunnerOptions?: boolean; kit?: SessionKitV1 }) => Promise<{
    state: 'warmed' | 'kept' | 'refused'
    detail?: string
  }>
  warmRunnerCount?: () => number
  concourseControl?: (req: {
    action:
      | 'pause'
      | 'resume'
      | 'interrupt'
      | 'attach'
      | 'detach'
      | 'grant-workflows'
      | 'revoke-workflows'
      | 'answer-permission'
      | 'stop'
      | 'set-model'
      | 'set-permission-mode'
      | 'session-facts'
      | 'set-title'
      | 'focus'
      | 'blur'
      | 'park'
      | 'park-all'
      | 'set-effort'
      | 'contract'
      | 'set-kit'
      | 'set-schedule'
      | 'set-spawn-switch'
    sessionId: string
    by: string
    reason?: string
    requestId?: string
    allow?: boolean
    answer?: { updatedInput?: Record<string, unknown>; permissionUpdates?: unknown[]; feedback?: string; interrupt?: boolean }
    model?: string
    effort?: string
    mode?: string
    title?: string
    titleSource?: 'operator' | 'minted'
    contract?: { op: 'set' | 'ack' | 'amend' | 'close'; text?: string }
    kitEdit?: SessionKitEditV1
    scheduleEdit?: ScheduleOpRequestV1
    spawnSwitch?: { kind: 'subagents' | 'workflows'; on: boolean }
    mintedAtMs?: number
    clientOpId?: string
  }) => { outcome: 'applied' | 'noop' | 'refused' | 'draining' | 'queued'; detail?: string }
  sessionRewind?: (req: {
    sessionId: string
    by: string
    mode: SessionRewindMode
    userMessageId: string
    dryRun?: boolean
  }) => Promise<SessionRewindOutcomeV1>
}

export interface ControlServerHandle {
  close(): Promise<void>
  rebind(): Promise<void>
  leaseCount(): number
}

function answer(sock: net.Socket, payload: DaemonReply): void {
  if (sock.destroyed) return
  sock.end(encodeFrame(payload))
}

type Unlisted<R, K extends PropertyKey> = Exclude<keyof R, K>
type Whole<R, K extends PropertyKey> = [Unlisted<R, K>] extends [never] ? true : { unlisted: Unlisted<R, K> }

function pickDefined<R extends object, K extends keyof R>(r: R, keys: readonly K[]): Pick<R, K> {
  const out: Partial<Pick<R, K>> = {}
  for (const k of keys) if (r[k] !== undefined) out[k] = r[k]
  return out as Pick<R, K>
}

type AdmitOk = Extract<Awaited<ReturnType<NonNullable<ControlServerDeps['concourseAdmit']>>>, { ok: true }>
const ADMIT_WIRE_KEYS = [
  'runnerId', 'sessionId', 'workspaceId', 'pid',
  'branchName', 'mainHolderTitle', 'modelId', 'modelDisplayName', 'effort', 'note',
  'kitSource', 'liveHop', 'presetName', 'presetNote',
] as const satisfies readonly (keyof AdmitOk)[]
const admitWhole: Whole<Omit<AdmitOk, 'ok'>, (typeof ADMIT_WIRE_KEYS)[number]> = true

type DispatchResult = Awaited<ReturnType<NonNullable<ControlServerDeps['concourseDispatch']>>>
const DISPATCH_WIRE_KEYS = [
  'clientMessageId', 'state', 'stateRevision', 'runnerId', 'sessionId', 'replay',
  'branchName', 'mainHolderTitle', 'modelId', 'modelDisplayName', 'effort',
  'kitSource', 'presetName', 'presetNote',
] as const satisfies readonly (keyof DispatchResult)[]
const DISPATCH_REFUSAL_WIRE_KEYS = ['state', 'stateRevision', 'heldReason', 'heldByTitle', 'moves'] as const satisfies readonly (keyof DispatchResult)[]
const dispatchWhole: Whole<
  Omit<DispatchResult, 'ok' | 'error'>,
  (typeof DISPATCH_WIRE_KEYS)[number] | (typeof DISPATCH_REFUSAL_WIRE_KEYS)[number]
> = true

type ControlResult = ReturnType<NonNullable<ControlServerDeps['concourseControl']>>
const CONTROL_WIRE_KEYS = ['outcome', 'detail'] as const satisfies readonly (keyof ControlResult)[]
const controlWhole: Whole<ControlResult, (typeof CONTROL_WIRE_KEYS)[number]> = true

type WarmResult = Awaited<ReturnType<NonNullable<ControlServerDeps['concourseWarm']>>>
const WARM_WIRE_KEYS = ['state', 'detail'] as const satisfies readonly (keyof WarmResult)[]
const warmWhole: Whole<WarmResult, (typeof WARM_WIRE_KEYS)[number]> = true

type ReleaseResult = ReturnType<NonNullable<ControlServerDeps['concourseRelease']>>
const RELEASE_WIRE_KEYS = ['settled', 'killed'] as const satisfies readonly (keyof ReleaseResult)[]
const releaseWhole: Whole<ReleaseResult, (typeof RELEASE_WIRE_KEYS)[number]> = true

type ReconfigureResult = ReturnType<TaskRoster['reconfigureLongLived']>
const RECONFIGURE_WIRE_KEYS = ['respawned', 'pending', 'note'] as const satisfies readonly (keyof ReconfigureResult)[]
const reconfigureWhole: Whole<Omit<ReconfigureResult, 'ok' | 'error'>, (typeof RECONFIGURE_WIRE_KEYS)[number]> = true

type CrewSpawnResult = Awaited<ReturnType<NonNullable<ControlServerDeps['crewSpawn']>>>
const CREW_SPAWN_WIRE_KEYS = ['pid'] as const satisfies readonly (keyof CrewSpawnResult)[]
const crewSpawnWhole: Whole<Omit<CrewSpawnResult, 'ok' | 'error'>, (typeof CREW_SPAWN_WIRE_KEYS)[number]> = true

type WorkerDispatchResult = Awaited<ReturnType<TaskRoster['dispatch']>>
const WORKER_DISPATCH_WIRE_KEYS = ['short', 'pid', 'via'] as const satisfies readonly (keyof WorkerDispatchResult)[]
const workerDispatchWhole: Whole<Omit<WorkerDispatchResult, 'ok' | 'code' | 'error'>, (typeof WORKER_DISPATCH_WIRE_KEYS)[number]> = true

void [admitWhole, dispatchWhole, controlWhole, warmWhole, releaseWhole, reconfigureWhole, crewSpawnWhole, workerDispatchWhole]

function peerUidRejection(_sock: net.Socket): string | null {
  return null
}

export async function startControlServer(
  deps: ControlServerDeps,
): Promise<ControlServerHandle> {
  const sockPath = controlSockPath()
  await unlink(sockPath).catch(() => {})

  const conns = new Set<net.Socket>()
  const leases = new Map<net.Socket, LeaseClient>()

  const server = net.createServer(sock => {
    sock.on('error', () => sock.destroy())
    sock.setTimeout(30_000, () => sock.destroy())
    conns.add(sock)
    sock.once('close', () => {
      conns.delete(sock)
      leases.delete(sock)
    })

    const uidErr = peerUidRejection(sock)
    if (uidErr) {
      answer(sock, { ok: false, code: 'EPEERUID', error: uidErr })
      return
    }

    readControlFrame(
      sock,
      line => {
        sock.setTimeout(0)
        void routeControlRequest(deps, leases, sock, line).catch(err => {
          answer(sock, {
            ok: false,
            code: 'EUNKNOWN',
            error: `daemon error — ${err instanceof Error ? err.message : String(err)}`,
          })
        })
      },
      () => {
        answer(sock, {
          ok: false,
          code: 'ETOOLARGE',
          error: `request exceeds ${CONTROL_FRAME_CAP >> 20}MB — shorten the prompt or send in parts`,
        })
      },
    )
  })

  server.on('error', (err: NodeJS.ErrnoException) => {
    logForDebugging(`[daemon] control server error: ${err}`)
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(sockPath, () => {
      server.removeListener('error', reject)
      logForDebugging(`[daemon] control server listening at ${sockPath}`)
      resolve()
    })
  })

  return {
    close: () =>
      new Promise<void>(resolve => {
        for (const c of conns) c.destroy()
        server.close(() => {
          if (ownsControlPlaneSync()) void unlink(sockPath).catch(() => {})
          resolve()
        })
      }),
    rebind: () =>
      new Promise<void>(resolve => {
        for (const c of conns) c.destroy()
        server.close(() => {
          if (!ownsControlPlaneSync()) {
            let foreignLive = false
            try {
              const raw = JSON.parse(readFileSync(supervisorStatePath(), 'utf8')) as { pid?: number }
              foreignLive =
                typeof raw?.pid === 'number' && raw.pid !== process.pid && isProcessAlive(raw.pid)
            } catch {
              foreignLive = false
            }
            if (foreignLive) {
              logForDebugging('[daemon] rebind aborted — a live foreign pid owns the plane')
              resolve()
              return
            }
          }
          server.once('error', err => {
            logForDebugging(`[daemon] rebind listen failed (next beat retries): ${err}`)
            resolve()
          })
          void unlink(sockPath)
            .catch(() => {})
            .then(() => {
              server.listen(sockPath, () => {
                logForDebugging(`[daemon] control server re-bound at ${sockPath} (self-heal)`)
                resolve()
              })
            })
        })
      }),
    leaseCount: () => leases.size,
  }
}

const SESSION_OP_ALIASES: Record<string, string> = {
  concourseAdmit: 'sessionAdmit',
  concourseDispatch: 'sessionDispatch',
  concourseList: 'sessionList',
  concourseRelease: 'sessionRelease',
  concourseControl: 'sessionControl',
}

async function routeControlRequest(
  deps: ControlServerDeps,
  leases: Map<net.Socket, LeaseClient>,
  sock: net.Socket,
  line: string,
): Promise<void> {
  let raw: { op?: string; [k: string]: unknown }
  try {
    raw = JSON.parse(line)
  } catch {
    return answer(sock, { ok: false, code: 'EUNKNOWN', error: 'bad json' })
  }
  if (!raw || typeof raw !== 'object') {
    return answer(sock, { ok: false, code: 'EUNKNOWN', error: 'bad json' })
  }
  const requestedOp = raw.op
  const op = requestedOp !== undefined ? (SESSION_OP_ALIASES[requestedOp] ?? requestedOp) : requestedOp

  if (op === 'ping') {
    return answer(sock, {
      ok: true,
      op: 'ping',
      version: currentVersion(),
      proto: MERCURY_DAEMON_PROTO,
    })
  }
  if (op === 'hello') {
    const facts = deps.hello?.()
    logForDebugging(
      `[daemon] hello from client v${typeof raw.clientVersion === 'string' ? raw.clientVersion : '?'} proto ${
        typeof raw.proto === 'number' ? raw.proto : '?'
      } (this daemon v${currentVersion()} proto ${MERCURY_DAEMON_PROTO})`,
    )
    return answer(sock, {
      ok: true,
      op: 'hello',
      proto: MERCURY_DAEMON_PROTO,
      minProto: MIN_PROTO,
      ready: deps.isReady(),
      version: facts?.version ?? currentVersion(),
      buildTree: facts?.buildTree ?? null,
      pid: process.pid,
      startedAt: facts?.startedAt ?? deps.startedAt,
      ownerPid: facts?.ownerPid ?? null,
      foreground: facts?.foreground ?? false,
      live: facts?.live ?? 0,
      liveSessions: facts?.liveSessions ?? 0,
      warm: facts?.warm ?? 0,
      restartArmed: facts?.restartArmed ?? false,
    })
  }
  if (op === 'nudge') {
    return answer(sock, {
      ok: true,
      op: 'nudge',
      restarting: false,
      version: currentVersion(),
    })
  }
  if (op === 'leases') {
    return answer(sock, { ok: true, op: 'leases', clients: Array.from(leases.values()) })
  }
  if (op === 'shutdown') {
    const reapWorkers = raw.reapWorkers !== false
    const { reaped, workers } = deps.onShutdown(reapWorkers)
    return answer(sock, { ok: true, op: 'shutdown', reaped, workers })
  }

  if (!deps.isReady()) {
    return answer(sock, {
      ok: false,
      code: 'ESTARTING',
      error: 'daemon starting (adoption / lock acquisition in progress)',
    })
  }

  const proto = raw.proto
  if (
    typeof proto !== 'number' ||
    !Number.isInteger(proto) ||
    proto < MIN_PROTO ||
    proto > MERCURY_DAEMON_PROTO
  ) {
    return answer(sock, {
      ok: false,
      code: 'EPROTO',
      error: `proto mismatch (server=${MERCURY_DAEMON_PROTO}, client=${
        typeof proto === 'number' ? proto : -1
      }) — daemon and CLI versions differ; restart Mercury`,
      serverProto: MERCURY_DAEMON_PROTO,
      serverVersion: currentVersion(),
    })
  }

  const auth = typeof raw.auth === 'string' ? raw.auth : undefined

  switch (op) {
    case 'list':
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      return answer(sock, { ok: true, op: 'list', jobs: deps.roster.list() })

    case 'has': {
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      const short = String(raw.short ?? '')
      const h = deps.roster.has(short)
      return answer(sock, { ok: true, op: 'has', ...h })
    }

    case 'status': {
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      const now = Date.now()
      const sup = deps.roster.getSupervisorState()
      return answer(sock, {
        ok: true,
        op: 'status',
        status: {
          pid: process.pid,
          version: currentVersion(),
          startedAt: deps.startedAt,
          uptimeSec: Math.floor((now - deps.startedAt) / 1000),
          dir: deps.dir,
          workersLive: Math.max(
            0,
            deps.roster.liveCount() - (deps.warmRunnerCount !== undefined ? deps.warmRunnerCount() : 0),
          ),
          workersTotal: Math.max(
            0,
            deps.roster.totalCount() - (deps.warmRunnerCount !== undefined ? deps.warmRunnerCount() : 0),
          ),
          maxInflight: deps.maxInflight,
          breakerOpen: deps.breaker.shouldSuppressFire(),
          leaseCount: leases.size,
          proto: MERCURY_DAEMON_PROTO,
          degraded: sup.degraded,
          degradedReason: sup.degraded ? sup.reason : undefined,
          ...(deps.warmRunnerCount !== undefined ? { warmRunners: deps.warmRunnerCount() } : {}),
        },
      })
    }

    case 'dispatch': {
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      const body = raw.d
      if (!body || typeof body !== 'object' || typeof (body as { prompt?: unknown }).prompt !== 'string') {
        return answer(sock, { ok: false, code: 'EUNKNOWN', error: 'dispatch requires { d: { prompt } }' })
      }
      const out = await deps.roster.dispatch(body as Parameters<TaskRoster['dispatch']>[0])
      if (!out.ok) {
        return answer(sock, {
          ok: false,
          code: out.code ?? 'EUNKNOWN',
          error: out.error ?? 'dispatch failed',
        })
      }
      return answer(sock, { ok: true, op: 'dispatch', ...pickDefined(out, WORKER_DISPATCH_WIRE_KEYS) })
    }

    case 'reply': {
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      const short = String(raw.short ?? '')
      const text = String(raw.text ?? '')
      const h = deps.roster.has(short)
      if (!h.present) {
        return answer(sock, { ok: false, code: 'ENOJOB', error: 'job not found — it may have already exited' })
      }
      const accepted = await deps.roster.reply(short, text)
      if (!accepted) {
        return answer(sock, {
          ok: false,
          code: 'ENOREPLY',
          error: "job isn't accepting replies — headless runs have no interactive stdin",
        })
      }
      return answer(sock, { ok: true, op: 'reply' })
    }

    case 'kill': {
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      const short = String(raw.short ?? '')
      const signal = (typeof raw.signal === 'string' ? raw.signal : 'SIGTERM') as NodeJS.Signals
      const killed = deps.roster.kill(short, signal)
      if (!killed) {
        return answer(sock, { ok: false, code: 'ENOJOB', error: 'job not found — it may have already exited' })
      }
      return answer(sock, { ok: true, op: 'kill' })
    }

    case 'envelope': {
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      const rawTo = String(raw.to ?? '')
      const team = typeof raw.team === 'string' && raw.team ? raw.team : 'default'
      const to = rawTo.trim()
      let env: ReturnType<typeof parseBusEnvelope> = null
      try {
        env = parseBusEnvelope(JSON.stringify(raw.env))
      } catch {
        env = null
      }
      if (!to || !env) {
        return answer(sock, { ok: false, code: 'EUNKNOWN', error: 'envelope requires { to, env: <bus envelope> }' })
      }
      if (
        (env.kind === 'dispatch' || env.kind === 'control' || env.kind === 'note') &&
        (!env.from || env.from === to)
      ) {
        return answer(sock, { ok: false, code: 'EUNKNOWN', error: `a ${env.kind} envelope must carry a dispatcher 'from', never the recipient itself` })
      }
      const journaled = await writeToMailbox(
        to,
        {
          from: env.from,
          text: JSON.stringify(env),
          timestamp: new Date().toISOString(),
          ...(typeof raw.color === 'string' && raw.color ? { color: raw.color } : {}),
        },
        team,
      )
      if (!journaled) {
        return answer(sock, { ok: false, code: 'EUNKNOWN', error: 'envelope journal write failed' })
      }
      try {
        deps.nudgeAgent?.(to)
      } catch (e) {
        logForDebugging(`[daemon] envelope nudge for ${to} threw (ignored): ${e}`)
      }
      return answer(sock, { ok: true, op: 'envelope', journaled })
    }

    case 'reconfigure': {
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      const short = String(raw.short ?? '')
      const model = typeof raw.model === 'string' ? raw.model : undefined
      const effort = typeof raw.effort === 'string' ? raw.effort : undefined
      if (!deps.roster.has(short).present) {
        return answer(sock, {
          ok: false,
          code: 'ENOJOB',
          error:
            'not a long-lived worker — reconfigure only retargets a supervised seat',
        })
      }
      const r = deps.roster.reconfigureLongLived(short, { model, effort })
      if (!r.ok) {
        return answer(sock, {
          ok: false,
          code: 'ENOJOB',
          error: r.error ?? 'not a long-lived worker — reconfigure only retargets a supervised seat',
        })
      }
      return answer(sock, { ok: true, op: 'reconfigure', ...pickDefined(r, RECONFIGURE_WIRE_KEYS) })
    }

    case 'crewSpawn': {
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      if (!deps.crewSpawn) {
        return answer(sock, { ok: false, code: 'ENOTSUP', error: 'this daemon does not host crew teammates' })
      }
      const name = String(raw.name ?? '')
      const modelKey = String(raw.model ?? '')
      if (!name || !modelKey) {
        return answer(sock, { ok: false, code: 'EUNKNOWN', error: 'crewSpawn requires { name, model }' })
      }
      const r = await deps.crewSpawn(name, modelKey)
      if (!r.ok) {
        return answer(sock, { ok: false, code: 'EUNKNOWN', error: r.error ?? 'crew spawn refused' })
      }
      return answer(sock, { ok: true, op: 'crewSpawn', ...pickDefined(r, CREW_SPAWN_WIRE_KEYS) })
    }

    case 'sessionAdmit': {
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      if (!deps.concourseAdmit) {
        return answer(sock, { ok: false, code: 'ENOTSUP', error: 'this daemon does not host the session concourse' })
      }
      const workspaceDir = String(raw.workspaceDir ?? '')
      if (!workspaceDir) {
        return answer(sock, { ok: false, code: 'EUNKNOWN', error: 'sessionAdmit requires { workspaceDir }' })
      }
      const isolation =
        raw.isolation === 'exclusive' || raw.isolation === 'shared' || raw.isolation === 'worktree-isolated' || raw.isolation === 'read-only'
          ? raw.isolation
          : undefined
      if (raw.runnerArgv !== undefined) {
        const refusal = refuseRunnerArgv(raw.runnerArgv)
        if (refusal !== null) return answer(sock, { ok: false, code: 'EUNKNOWN', error: `runnerArgv refused — ${refusal}` })
      }
      let kit: SessionKitV1 | undefined
      if (raw.kit !== undefined) {
        const verdict = validateSessionKit(raw.kit)
        if (!verdict.ok) return answer(sock, { ok: false, code: 'EUNKNOWN', error: `kit refused — ${verdict.reason}` })
        kit = verdict.kit
      }
      if (raw.kitPreset !== undefined && (typeof raw.kitPreset !== 'string' || raw.kitPreset === '')) {
        return answer(sock, { ok: false, code: 'EUNKNOWN', error: 'kitPreset must be a saved preset name (a non-empty string)' })
      }
      const r = await deps.concourseAdmit({
        workspaceDir,
        ...(isolation !== undefined ? { isolation } : {}),
        ...(typeof raw.model === 'string' && raw.model ? { modelKey: raw.model } : {}),
        ...(typeof raw.effort === 'string' && raw.effort ? { effort: raw.effort } : {}),
        ...(typeof raw.title === 'string' && raw.title ? { title: raw.title } : {}),
        ...(typeof raw.agentName === 'string' && raw.agentName ? { agentName: raw.agentName } : {}),
        ...(raw.seatsMax === 1 || raw.seatsMax === 2 ? { seatsMax: raw.seatsMax } : {}),
        ...(typeof raw.resumeSessionId === 'string' && raw.resumeSessionId ? { resumeSessionId: raw.resumeSessionId } : {}),
        ...(typeof raw.permissionMode === 'string' && raw.permissionMode ? { permissionMode: raw.permissionMode as never } : {}),
        ...(Array.isArray(raw.runnerArgv) && raw.runnerArgv.length > 0 ? { runnerArgv: raw.runnerArgv as string[] } : {}),
        ...(raw.bornBlank === true ? { bornBlank: true } : {}),
        ...(kit !== undefined ? { kit } : {}),
        ...(typeof raw.kitPreset === 'string' && raw.kitPreset !== '' ? { kitPreset: raw.kitPreset } : {}),
        ...(typeof raw.vacatingSessionId === 'string' && raw.vacatingSessionId !== '' ? { vacatingSessionId: raw.vacatingSessionId } : {}),
      })
      if (!r.ok) {
        return answer(sock, { ok: false, code: 'EUNKNOWN', error: r.error, refusal: r.code })
      }
      return answer(sock, {
        ok: true,
        op: requestedOp === 'concourseAdmit' ? 'concourseAdmit' : 'sessionAdmit',
        workerId: r.runnerId,
        ...pickDefined(r, ADMIT_WIRE_KEYS),
      })
    }

    case 'concourseWithdraw': {
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      if (!deps.concourseWithdraw) {
        return answer(sock, { ok: false, code: 'ENOTSUP', error: 'this daemon does not host the session concourse' })
      }
      const clientMessageId = String(raw.clientMessageId ?? '')
      if (!clientMessageId) {
        return answer(sock, { ok: false, code: 'EUNKNOWN', error: 'concourseWithdraw requires { clientMessageId }' })
      }
      const withdrawn = await deps.concourseWithdraw(clientMessageId)
      return answer(sock, { ok: true, op: 'concourseWithdraw', withdrawn })
    }

    case 'concourseWarm': {
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      if (!deps.concourseWarm) {
        return answer(sock, { ok: false, code: 'ENOTSUP', error: 'this daemon does not host the session concourse' })
      }
      const warmWorkspaceDir = String(raw.workspaceDir ?? '')
      if (!warmWorkspaceDir) {
        return answer(sock, { ok: false, code: 'EUNKNOWN', error: 'concourseWarm requires { workspaceDir }' })
      }
      let warmKit: SessionKitV1 | undefined
      if (raw.kit !== undefined) {
        const verdict = validateSessionKit(raw.kit)
        if (!verdict.ok) return answer(sock, { ok: false, code: 'EUNKNOWN', error: `kit refused — ${verdict.reason}` })
        warmKit = verdict.kit
      }
      const warm = await deps.concourseWarm({
        workspaceDir: warmWorkspaceDir,
        ...(typeof raw.retiring === 'string' && raw.retiring !== '' ? { retiring: raw.retiring } : {}),
        ...(raw.runnerOptionsPresent === true ? { bootCarriesRunnerOptions: true } : {}),
        ...(warmKit !== undefined ? { kit: warmKit } : {}),
      })
      return answer(sock, { ok: true, op: 'concourseWarm', ...pickDefined(warm, WARM_WIRE_KEYS) })
    }
    case 'sessionDispatch': {
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      if (!deps.concourseDispatch) {
        return answer(sock, { ok: false, code: 'ENOTSUP', error: 'this daemon does not host the session concourse' })
      }
      const clientMessageId = String(raw.clientMessageId ?? '')
      const prompt = String(raw.prompt ?? '')
      const workspaceDir = String(raw.workspaceDir ?? '')
      const targetSessionId = typeof raw.targetSessionId === 'string' && raw.targetSessionId ? raw.targetSessionId : undefined
      if (!clientMessageId || !prompt || (!workspaceDir && targetSessionId === undefined)) {
        return answer(sock, { ok: false, code: 'EUNKNOWN', error: 'sessionDispatch requires { clientMessageId, prompt, workspaceDir } (workspaceDir optional with targetSessionId)' })
      }
      const isolation =
        raw.isolation === 'exclusive' || raw.isolation === 'worktree-isolated' || raw.isolation === 'read-only'
          ? raw.isolation
          : undefined
      if (raw.isolation !== undefined && isolation === undefined) {
        return answer(sock, {
          ok: false,
          code: 'EUNKNOWN',
          error: `unknown isolation '${String(raw.isolation)}' — the closed vocabulary is exclusive | worktree-isolated | read-only`,
        })
      }
      if (raw.runnerArgv !== undefined) {
        const refusal = refuseRunnerArgv(raw.runnerArgv)
        if (refusal !== null) return answer(sock, { ok: false, code: 'EUNKNOWN', error: `runnerArgv refused — ${refusal}` })
      }
      if (raw.kitPreset !== undefined && (typeof raw.kitPreset !== 'string' || raw.kitPreset === '')) {
        return answer(sock, { ok: false, code: 'EUNKNOWN', error: 'kitPreset must be a saved preset name (a non-empty string)' })
      }
      const r = await deps.concourseDispatch({
        clientMessageId,
        prompt,
        workspaceDir,
        ...(isolation !== undefined ? { isolation } : {}),
        ...(typeof raw.model === 'string' && raw.model ? { modelKey: raw.model } : {}),
        ...(typeof raw.effort === 'string' && raw.effort ? { effort: raw.effort } : {}),
        ...(typeof raw.title === 'string' && raw.title ? { title: raw.title } : {}),
        ...(typeof raw.agentName === 'string' && raw.agentName ? { agentName: raw.agentName } : {}),
        ...(raw.seatsMax === 1 || raw.seatsMax === 2 ? { seatsMax: raw.seatsMax } : {}),
        ...(typeof raw.resumeSessionId === 'string' && raw.resumeSessionId ? { resumeSessionId: raw.resumeSessionId } : {}),
        ...(typeof raw.by === 'string' && raw.by ? { by: raw.by } : {}),
        ...(typeof raw.permissionMode === 'string' && raw.permissionMode ? { permissionMode: raw.permissionMode as never } : {}),
        ...(Array.isArray(raw.runnerArgv) && raw.runnerArgv.length > 0 ? { runnerArgv: raw.runnerArgv as string[] } : {}),
        ...(targetSessionId !== undefined ? { targetSessionId } : {}),
        ...(raw.mode === 'bash' || raw.mode === 'prompt' || raw.mode === 'task-notification' ? { mode: raw.mode } : {}),
        ...(raw.mode === 'task-notification' && typeof raw.agentId === 'string' && raw.agentId !== '' ? { agentId: raw.agentId } : {}),
        ...(raw.priority === 'now' || raw.priority === 'next' || raw.priority === 'later' ? { priority: raw.priority } : {}),
        ...(Array.isArray(raw.content) && raw.content.length > 0 ? { content: raw.content } : {}),
        ...(typeof raw.kitPreset === 'string' && raw.kitPreset !== '' ? { kitPreset: raw.kitPreset } : {}),
      })
      if (!r.ok) {
        return answer(sock, {
          ok: false,
          code: 'EUNKNOWN',
          error: r.error ?? 'dispatch refused',
          refusal: r.replay,
          ...pickDefined(r, DISPATCH_REFUSAL_WIRE_KEYS),
        })
      }
      return answer(sock, {
        ok: true,
        op: requestedOp === 'concourseDispatch' ? 'concourseDispatch' : 'sessionDispatch',
        workerId: r.runnerId,
        ...pickDefined(r, DISPATCH_WIRE_KEYS),
      })
    }

    case 'sessionControl': {
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      if (!deps.concourseControl) {
        return answer(sock, { ok: false, code: 'ENOTSUP', error: 'this daemon does not host the session concourse' })
      }
      const action =
        raw.action === 'pause' ||
        raw.action === 'resume' ||
        raw.action === 'interrupt' ||
        raw.action === 'attach' ||
        raw.action === 'detach' ||
        raw.action === 'grant-workflows' ||
        raw.action === 'revoke-workflows' ||
        raw.action === 'answer-permission' ||
        raw.action === 'stop' ||
        raw.action === 'set-model' ||
        raw.action === 'set-permission-mode' ||
        raw.action === 'session-facts' ||
        raw.action === 'set-title' ||
        raw.action === 'focus' ||
        raw.action === 'blur' ||
        raw.action === 'park' ||
        raw.action === 'park-all' ||
        raw.action === 'set-effort' ||
        raw.action === 'contract' ||
        raw.action === 'set-kit' ||
        raw.action === 'set-schedule' ||
        raw.action === 'set-spawn-switch'
          ? raw.action
          : undefined
      const sessionId = String(raw.sessionId ?? '')
      const by = String(raw.by ?? '')
      if (action === undefined || !sessionId || !by) {
        return answer(sock, { ok: false, code: 'EUNKNOWN', error: 'sessionControl requires { action: pause|resume|interrupt|attach|detach|grant-workflows|revoke-workflows|answer-permission|stop|set-model|set-permission-mode|session-facts|set-title|focus|blur|park|park-all|set-effort|contract|set-kit|set-schedule|set-spawn-switch, sessionId, by }' })
      }
      let spawnSwitch: { kind: 'subagents' | 'workflows'; on: boolean } | undefined
      if (raw.spawnSwitch !== undefined) {
        const rawSwitch =
          raw.spawnSwitch && typeof raw.spawnSwitch === 'object' && !Array.isArray(raw.spawnSwitch)
            ? (raw.spawnSwitch as Record<string, unknown>)
            : undefined
        const kind = rawSwitch?.kind === 'subagents' || rawSwitch?.kind === 'workflows' ? rawSwitch.kind : undefined
        if (kind === undefined || typeof rawSwitch?.on !== 'boolean') {
          return answer(sock, { ok: false, code: 'EUNKNOWN', error: 'spawnSwitch refused — { kind: subagents|workflows, on: boolean }' })
        }
        spawnSwitch = { kind, on: rawSwitch.on }
      }
      const rawAnswer = raw.answer && typeof raw.answer === 'object' && !Array.isArray(raw.answer) ? (raw.answer as Record<string, unknown>) : undefined
      const answerPayload =
        rawAnswer !== undefined
          ? {
              ...(rawAnswer.updatedInput && typeof rawAnswer.updatedInput === 'object' && !Array.isArray(rawAnswer.updatedInput)
                ? { updatedInput: rawAnswer.updatedInput as Record<string, unknown> }
                : {}),
              ...(Array.isArray(rawAnswer.permissionUpdates) ? { permissionUpdates: rawAnswer.permissionUpdates } : {}),
              ...(typeof rawAnswer.feedback === 'string' ? { feedback: rawAnswer.feedback.slice(0, 4000) } : {}),
              ...(rawAnswer.interrupt === true ? { interrupt: true } : {}),
            }
          : undefined
      const rawContract = raw.contract && typeof raw.contract === 'object' && !Array.isArray(raw.contract) ? (raw.contract as Record<string, unknown>) : undefined
      const contract =
        rawContract?.op === 'set' || rawContract?.op === 'ack' || rawContract?.op === 'amend' || rawContract?.op === 'close'
          ? {
              op: rawContract.op as 'set' | 'ack' | 'amend' | 'close',
              ...(typeof rawContract.text === 'string' ? { text: rawContract.text.slice(0, 20_000) } : {}),
            }
          : undefined
      let kitEdit: SessionKitEditV1 | undefined
      if (raw.kitEdit !== undefined) {
        const verdict = validateSessionKitEdit(raw.kitEdit)
        if (!verdict.ok) return answer(sock, { ok: false, code: 'EUNKNOWN', error: `kitEdit refused — ${verdict.reason}` })
        kitEdit = verdict.edit
      }
      let scheduleEdit: ScheduleOpRequestV1 | undefined
      if (raw.scheduleEdit !== undefined) {
        const rawSchedule =
          raw.scheduleEdit && typeof raw.scheduleEdit === 'object' && !Array.isArray(raw.scheduleEdit)
            ? (raw.scheduleEdit as Record<string, unknown>)
            : undefined
        const op =
          rawSchedule?.op === 'add' || rawSchedule?.op === 'remove' || rawSchedule?.op === 'pause' || rawSchedule?.op === 'resume'
            ? rawSchedule.op
            : undefined
        if (rawSchedule === undefined || op === undefined) {
          return answer(sock, { ok: false, code: 'EUNKNOWN', error: 'scheduleEdit refused — op must be add|remove|pause|resume' })
        }
        if (op === 'add') {
          const verdict = validateSaturnSubmission(rawSchedule.schedule)
          if (!verdict.ok) return answer(sock, { ok: false, code: 'EUNKNOWN', error: `scheduleEdit refused — ${verdict.reason}` })
          scheduleEdit = { op, schedule: rawSchedule.schedule }
        } else {
          const scheduleId = typeof rawSchedule.scheduleId === 'string' ? rawSchedule.scheduleId : ''
          if (!SATURN_ID_PATTERN.test(scheduleId)) {
            return answer(sock, { ok: false, code: 'EUNKNOWN', error: 'scheduleEdit refused — scheduleId must be eight hex characters' })
          }
          scheduleEdit = { op, scheduleId }
        }
      }
      const r = deps.concourseControl({
        action,
        sessionId,
        by,
        ...(typeof raw.reason === 'string' && raw.reason ? { reason: raw.reason } : {}),
        ...(typeof raw.requestId === 'string' && raw.requestId ? { requestId: raw.requestId.slice(0, 128) } : {}),
        ...(typeof raw.allow === 'boolean' ? { allow: raw.allow } : {}),
        ...(answerPayload !== undefined ? { answer: answerPayload } : {}),
        ...(typeof raw.model === 'string' && raw.model ? { model: raw.model.slice(0, 128) } : {}),
        ...(typeof raw.effort === 'string' && raw.effort ? { effort: raw.effort.slice(0, 32) } : {}),
        ...(typeof raw.mode === 'string' && raw.mode ? { mode: raw.mode.slice(0, 64) } : {}),
        ...(typeof raw.title === 'string' && raw.title ? { title: raw.title.slice(0, 200) } : {}),
        ...(raw.titleSource === 'operator' || raw.titleSource === 'minted' ? { titleSource: raw.titleSource } : {}),
        ...(contract !== undefined ? { contract } : {}),
        ...(kitEdit !== undefined ? { kitEdit } : {}),
        ...(scheduleEdit !== undefined ? { scheduleEdit } : {}),
        ...(spawnSwitch !== undefined ? { spawnSwitch } : {}),
        ...(typeof raw.clientOpId === 'string' && raw.clientOpId ? { clientOpId: raw.clientOpId.slice(0, 128) } : {}),
        ...(typeof raw.mintedAtMs === 'number' && Number.isFinite(raw.mintedAtMs) ? { mintedAtMs: raw.mintedAtMs } : {}),
      })
      return answer(sock, { ok: true, op: requestedOp === 'concourseControl' ? 'concourseControl' : 'sessionControl', ...pickDefined(r, CONTROL_WIRE_KEYS) })
    }

    case 'sessionRewind': {
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      if (!deps.sessionRewind) {
        return answer(sock, { ok: false, code: 'ENOTSUP', error: 'this daemon does not host the session concourse' })
      }
      const sessionId = String(raw.sessionId ?? '')
      const by = String(raw.by ?? '')
      const mode = raw.mode === 'code' || raw.mode === 'conversation' || raw.mode === 'both' ? raw.mode : undefined
      const userMessageId = typeof raw.userMessageId === 'string' ? raw.userMessageId.slice(0, 128) : ''
      if (!sessionId || !by || mode === undefined || !userMessageId) {
        return answer(sock, {
          ok: false,
          code: 'EUNKNOWN',
          error: 'sessionRewind requires { sessionId, by, mode: code|conversation|both, userMessageId }',
        })
      }
      const r = await deps.sessionRewind({
        sessionId,
        by,
        mode,
        userMessageId,
        ...(raw.dryRun === true ? { dryRun: true } : {}),
      })
      return answer(sock, { ok: true, op: 'sessionRewind', ...r })
    }

    case 'sessionList': {
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      if (!deps.concourseList) {
        return answer(sock, { ok: false, code: 'ENOTSUP', error: 'this daemon does not host the session concourse' })
      }
      return answer(sock, { ok: true, op: requestedOp === 'concourseList' ? 'concourseList' : 'sessionList', workers: deps.concourseList() })
    }

    case 'sessionRelease': {
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      if (!deps.concourseRelease) {
        return answer(sock, { ok: false, code: 'ENOTSUP', error: 'this daemon does not host the session concourse' })
      }
      const runnerId = String(raw.runnerId ?? raw.workerId ?? '')
      if (!runnerId) {
        return answer(sock, { ok: false, code: 'EUNKNOWN', error: 'sessionRelease requires { runnerId }' })
      }
      const r = deps.concourseRelease(runnerId)
      return answer(sock, { ok: true, op: requestedOp === 'concourseRelease' ? 'concourseRelease' : 'sessionRelease', ...pickDefined(r, RELEASE_WIRE_KEYS) })
    }

    case 'restart-when-idle': {
      if (!verifyControlAuth(auth, deps.controlKey)) return refuseAuth(sock, op)
      if (!deps.restartWhenIdle) {
        return answer(sock, { ok: false, code: 'ENOTSUP', error: 'this daemon cannot restart itself' })
      }
      const by = typeof raw.by === 'string' && raw.by !== '' ? raw.by.slice(0, 64) : 'client'
      const r = deps.restartWhenIdle(by)
      return answer(sock, {
        ok: true,
        op: 'restart-when-idle',
        state: r.state,
        live: r.live,
        ...(r.detail !== undefined ? { detail: r.detail } : {}),
      })
    }

    case 'attach': {
      const short = String(raw.short ?? '')
      const a = attachToJobPty(short)
      return answer(sock, { ok: false, code: 'ENOTSUP', error: a.ok ? '' : a.error })
    }

    default:
      return answer(sock, { ok: false, code: 'EUNKNOWN', error: `unknown op: ${String(op)}` })
  }
}

function refuseAuth(sock: net.Socket, op: string): void {
  answer(sock, {
    ok: false,
    code: 'EAUTH',
    error: `${op} rejected: this client didn't present the daemon control key`,
  })
}
