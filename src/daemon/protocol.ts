
import type { SDKControlSetEffortRequest } from '../entrypoints/sdk/controlTypes.js'
import type { SessionKitEditV1, SessionKitV1 } from './sessionKit.js'

export const MERCURY_DAEMON_PROTO = 6

export const MIN_PROTO = 1

export const DAEMON_PROTO_SHAPE = 'sha256:24e4456f6195d853497e746fc89136503c3a0d49f113d9768538a8ae084b9d5e'

export const CONTROL_FRAME_CAP = 1 << 20

export type DaemonErrorCode =
  | 'ENOCONN'
  | 'ETIMEOUT'
  | 'ESTARTING'
  | 'ENOJOB'
  | 'EALIVE'
  | 'ESTALE'
  | 'EAUTH'
  | 'EPROTO'
  | 'ETOOLARGE'
  | 'EPEERUID'
  | 'ENOREPLY'
  | 'ENOTSUP'
  | 'EUNKNOWN'

export type DaemonOp =
  | 'ping'
  | 'nudge'
  | 'shutdown'
  | 'leases'
  | 'list'
  | 'has'
  | 'status'
  | 'dispatch'
  | 'reply'
  | 'kill'
  | 'reconfigure'
  | 'envelope'
  | 'crewSpawn'
  | 'concourseAdmit'
  | 'concourseDispatch'
  | 'concourseList'
  | 'concourseRelease'
  | 'concourseControl'
  | 'concourseWithdraw'
  | 'concourseWarm'
  | 'hello'
  | 'restart-when-idle'
  | 'sessionAdmit'
  | 'sessionDispatch'
  | 'sessionList'
  | 'sessionRelease'
  | 'sessionControl'
  | 'sessionRewind'

export type DispatchSource = 'user' | 'cron' | 'dispatch'

export interface DispatchBody {
  short?: string
  prompt: string
  cwd?: string
  source?: DispatchSource
  model?: string
  workflow?: string
}


export type SessionRewindMode = 'code' | 'conversation' | 'both'

export type RewindRefusalKind =
  | 'turn-active'
  | 'not-found'
  | 'capture-off'
  | 'no-checkpoint'
  | 'drift'
  | 'backup-missing'
  | 'before-compaction'
  | 'restore-failed'
  | 'runner-older'
  | 'daemon-older'
  | 'unknown-session'
  | 'no-channel'
  | 'no-answer'
  | 'no-chat'

export interface SessionRewindOutcomeV1 {
  outcome: 'applied' | 'refused' | 'noop'
  mode: SessionRewindMode
  refusal?: RewindRefusalKind
  detail?: string
  dryRun?: boolean
  code?: {
    filesChanged: string[]
    insertions: number
    deletions: number
  }
  conversation?: {
    turnUuid: string
    removed: number
  }
}

export type DaemonRequest =
  | { op: 'ping'; proto?: number }
  | { op: 'nudge'; proto?: number }
  | { op: 'shutdown'; proto?: number; reapWorkers?: boolean }
  | { op: 'leases'; proto?: number }
  | { op: 'list'; proto: number; auth?: string }
  | { op: 'has'; proto: number; auth?: string; short: string }
  | { op: 'status'; proto: number; auth?: string }
  | { op: 'dispatch'; proto: number; auth?: string; d: DispatchBody }
  | { op: 'reply'; proto: number; auth?: string; short: string; text: string }
  | {
      op: 'kill'
      proto: number
      auth?: string
      short: string
      signal?: NodeJS.Signals
    }
  | {
      op: 'envelope'
      proto: number
      auth?: string
      to: string
      team?: string
      env: unknown
      color?: string
    }
  | {
      op: 'reconfigure'
      proto: number
      auth?: string
      short: string
      model?: string
      effort?: string
    }
  | {
      op: 'crewSpawn'
      proto: number
      auth?: string
      name: string
      model: string
    }
  | {
      op: 'sessionAdmit'
      proto: number
      auth?: string
      workspaceDir: string
      isolation?: 'exclusive' | 'shared' | 'worktree-isolated' | 'read-only'
      model?: string
      effort?: string
      title?: string
      resumeSessionId?: string
      bornBlank?: true
      kit?: SessionKitV1
      kitPreset?: string
    }
  | { op: 'sessionList'; proto: number; auth?: string }
  | { op: 'concourseWithdraw'; proto: number; auth?: string; clientMessageId: string }
  | { op: 'sessionRelease'; proto: number; auth?: string; runnerId: string }
  | {
      op: 'concourseWarm'
      proto: number
      auth?: string
      workspaceDir: string
      retiring?: string
      runnerOptionsPresent?: boolean
      kit?: SessionKitV1
    }
  | {
      op: 'sessionControl'
      proto: number
      auth?: string
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
      hard?: boolean
      requestId?: string
      allow?: boolean
      answer?: {
        updatedInput?: Record<string, unknown>
        permissionUpdates?: unknown[]
        feedback?: string
        interrupt?: boolean
      }
      model?: string
      effort?: SDKControlSetEffortRequest['effort']
      mode?: string
      title?: string
      titleSource?: 'operator' | 'minted'
      contract?: { op: 'set' | 'ack' | 'amend' | 'close'; text?: string }
      kitEdit?: SessionKitEditV1
      scheduleEdit?: import('./saturn.js').ScheduleOpRequestV1
      spawnSwitch?: { kind: 'subagents' | 'workflows'; on: boolean }
      clientOpId?: string
    }
  | {
      op: 'sessionDispatch'
      proto: number
      auth?: string
      clientMessageId: string
      prompt: string
      workspaceDir: string
      targetSessionId?: string
      isolation?: 'exclusive' | 'worktree-isolated' | 'read-only'
      model?: string
      title?: string
      agentName?: string
      seatsMax?: 1 | 2
      resumeSessionId?: string
      by?: string
      mode?: 'prompt' | 'bash'
      priority?: 'now' | 'next' | 'later'
      content?: unknown[]
      kitPreset?: string
    }
  | {
      op: 'hello'
      proto?: number
      clientVersion?: string
      clientBuildTree?: string | null
    }
  | {
      op: 'restart-when-idle'
      proto: number
      auth?: string
      by?: string
    }
  | {
      op: 'sessionRewind'
      proto: number
      auth?: string
      sessionId: string
      by: string
      mode: SessionRewindMode
      userMessageId: string
      dryRun?: boolean
    }

export interface DaemonHelloFacts {
  version: string
  buildTree: string | null
  pid: number
  startedAt: number
  ownerPid: number | null
  foreground: boolean
  live: number
  liveSessions: number
  warm: number
  restartArmed: boolean
}

export interface WireRosterEntry {
  short: string
  sessionId: string
  prompt: string
  source: DispatchSource
  state: string
  pid?: number
  startedAt: number
  cliVersion: string
  outcome?: string
  via?: string
  model?: string
  effort?: string
  pendingModel?: string
  pendingEffort?: string
  respawns?: number
  contextPct?: number
  busy?: boolean
  turnActive?: boolean
  turnElapsedMs?: number
}

export interface LeaseClient {
  label?: string
  cwd?: string
}

export type DaemonReply =
  | { ok: true; op: 'ping'; version: string; proto: number }
  | { ok: true; op: 'nudge'; restarting: boolean; version: string }
  | {
      ok: true
      op: 'shutdown'
      reaped: number
      workers?: Array<{ short: string; kind: 'long-lived' | 'one-shot'; purpose: string; pid?: number }>
    }
  | { ok: true; op: 'leases'; clients: LeaseClient[] }
  | { ok: true; op: 'list'; jobs: WireRosterEntry[] }
  | { ok: true; op: 'has'; alive: boolean; present: boolean; ready: boolean }
  | { ok: true; op: 'status'; status: WireStatus }
  | { ok: true; op: 'dispatch'; short: string; pid?: number; via?: string }
  | { ok: true; op: 'reply' }
  | { ok: true; op: 'envelope'; journaled: boolean }
  | { ok: true; op: 'kill' }
  | { ok: true; op: 'reconfigure'; respawned: boolean; pending: boolean; note?: string }
  | { ok: true; op: 'crewSpawn'; pid?: number }
  | {
      ok: true
      op: 'sessionAdmit' | 'concourseAdmit'
      runnerId: string
      workerId: string
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
  | { ok: true; op: 'sessionList' | 'concourseList'; workers: ReadonlyArray<Record<string, unknown>> }
  | {
      ok: true
      op: 'sessionDispatch' | 'concourseDispatch'
      clientMessageId: string
      state: string
      stateRevision: number
      runnerId?: string
      workerId?: string
      sessionId?: string
      replay?: string
      kitSource?: 'carried' | 'derived' | 'preset'
      presetName?: string
      presetNote?: string
    }
  | { ok: true; op: 'sessionRelease' | 'concourseRelease'; settled: boolean; killed: boolean }
  | { ok: true; op: 'sessionControl' | 'concourseControl'; outcome: 'applied' | 'noop' | 'refused' | 'draining' | 'queued'; detail?: string }
  | ({ ok: true; op: 'sessionRewind' } & SessionRewindOutcomeV1)
  | { ok: true; op: 'concourseWithdraw'; withdrawn: boolean }
  | { ok: true; op: 'concourseWarm'; state: 'warmed' | 'kept' | 'refused'; detail?: string }
  | ({ ok: true; op: 'hello'; proto: number; minProto: number; ready: boolean } & DaemonHelloFacts)
  | { ok: true; op: 'restart-when-idle'; state: 'restarting' | 'armed' | 'refused'; live: number; detail?: string }
  | {
      ok: false
      code: DaemonErrorCode
      error: string
      refusal?: string
      state?: string
      stateRevision?: number
      heldReason?: string
      heldByTitle?: string
      moves?: Array<{ verb: string; label: string }>
      serverProto?: number
      serverVersion?: string
    }

export interface WireStatus {
  pid: number
  version: string
  startedAt: number
  uptimeSec: number
  dir: string
  workersLive: number
  workersTotal: number
  maxInflight: number
  breakerOpen: boolean
  leaseCount: number
  proto: number
  degraded?: boolean
  degradedReason?: string
  warmRunners?: number
}


export function encodeFrame(obj: unknown): string {
  return JSON.stringify(obj) + '\n'
}

export function readControlFrame(
  sock: import('net').Socket,
  onFrame: (line: string) => void,
  onTooLarge: () => void,
): void {
  const pending: Buffer[] = []
  let byteCount = 0
  const onData = (chunk: Buffer) => {
    pending.push(chunk)
    byteCount += chunk.length
    const whole = Buffer.concat(pending, byteCount)
    const cut = whole.indexOf(10)
    if (cut < 0) {
      if (byteCount > CONTROL_FRAME_CAP) {
        sock.off('data', onData)
        onTooLarge()
      }
      return
    }
    sock.off('data', onData)
    onFrame(whole.subarray(0, cut).toString('utf8'))
  }
  sock.on('data', onData)
}
