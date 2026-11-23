
import type { ProcessSweepDaemonAnswer, ProcessSweepEntry } from '../process-sweep/processSweep.js'
import type { SessionKitEditV1, SessionKitV1 } from '../session-seat/sessionKit.js'
import { DAEMON_VERB_BORN_AT, type DaemonOpFor, type SessionControlAction } from '../runner-wire/sessionVerbs.js'

export const MERCURY_DAEMON_PROTO = 19

export const MIN_PROTO = 1

export { DAEMON_VERB_BORN_AT }
export type BoardPostRequestV1 = { clientOpId: string; channel: 'general' | 'team' | 'whisper'; target?: string; text: string }

export function verbBornAt(op: string, action?: string): number {
  if (action !== undefined) {
    const own = DAEMON_VERB_BORN_AT[`${op}/${action}`]
    if (own !== undefined) return own
  }
  return DAEMON_VERB_BORN_AT[op] ?? MIN_PROTO
}

export const CONTROL_FRAME_CAP = 1 << 20

type DaemonErrorCode =
  | 'ENOCONN'
  | 'ETIMEOUT'
  | 'EUNCONFIRMED'
  | 'ESTARTING'
  | 'ENOJOB'
  | 'EALIVE'
  | 'ESTALE'
  | 'EAUTH'
  | 'EPROTO'
  | 'ETOOLARGE'
  | 'EPEERUID'
  | 'ENOREPLY'
  | 'EBADMSG'
  | 'ENOTSUP'
  | 'EREFUSED'
  | 'EUNKNOWN'

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

export type SessionFileRestoreRequest = { userMessageId: string; dryRun?: boolean } & (
  | { action: 'restore'; filePath: string }
  | { action: 'undo' }
)

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

export type McpToolLoadingV1 = 'deferred' | 'listed' | 'held'

export interface McpToolEntryV1 {
  name: string
  registeredAs: string
  description: string
  descriptionCut?: true
  inputSchema: Record<string, unknown>
  schemaWithheldBytes?: number
  loading: McpToolLoadingV1
}

export type McpToolsStateV1 = 'connected' | 'needs-auth' | 'failed' | 'disabled' | 'pending' | 'absent' | 'unavailable'

export interface McpToolsV1 {
  server: string
  state: McpToolsStateV1
  tools: readonly McpToolEntryV1[]
  omitted: number
  detail?: string
}

export type DaemonRequest =
  | { op: 'ping'; proto?: number }
  | { op: 'nudge'; proto?: number }
  | { op: 'shutdown'; proto?: number; reapWorkers?: boolean }
  | { op: 'leases'; proto?: number }
  | { op: 'list'; proto?: number; auth?: string }
  | { op: 'has'; proto?: number; auth?: string; short: string }
  | { op: 'status'; proto?: number; auth?: string }
  | { op: 'dispatch'; proto?: number; auth?: string; d: DispatchBody }
  | { op: 'reply'; proto?: number; auth?: string; short: string; text: string }
  | {
      op: 'kill'
      proto?: number
      auth?: string
      short: string
      signal?: NodeJS.Signals
    }
  | {
      op: 'reconfigure'
      proto?: number
      auth?: string
      short: string
      model?: string
      effort?: string
    }
  | {
      op: DaemonOpFor<'sessionAdmit'>
      proto?: number
      auth?: string
      workspaceDir: string
      isolation?: 'exclusive' | 'shared' | 'worktree-isolated' | 'read-only'
      model?: string
      effort?: string
      permissionMode?: string
      permissionModeTyped?: true
      title?: string
      resumeSessionId?: string
      bornBlank?: true
      kit?: SessionKitV1
      kitPreset?: string
      bypassConsent?: true
      birthKey?: string
      waitForSeatMs?: number
      by?: string
      restartReason?: 'update'
      runnerArgv?: string[]
      vacatingSessionId?: string
    }
  | { op: DaemonOpFor<'sessionList'>; proto?: number; auth?: string }
  | { op: DaemonOpFor<'concourseWithdraw'>; proto?: number; auth?: string; clientMessageId: string }
  | { op: DaemonOpFor<'sessionRelease'>; proto?: number; auth?: string; runnerId: string }
  | {
      op: DaemonOpFor<'concourseWarm'>
      proto?: number
      auth?: string
      workspaceDir: string
      retiring?: string
      runnerOptionsPresent?: boolean
      kit?: SessionKitV1
      bypassConsent?: true
    }
  | {
      op: DaemonOpFor<'sessionControl'>
      proto?: number
      auth?: string
      action: SessionControlAction
      sessionId: string
      by: string
      reason?: string
      paused?: boolean
      boardPost?: BoardPostRequestV1
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
      effort?: string
      mode?: string
      title?: string
      titleSource?: 'operator' | 'minted'
      kitEdit?: SessionKitEditV1
      mcpAction?: { name: string; action: 'authenticate' | 'reconnect' | 'cancel-auth' }
      mcpServer?: string
      scheduleEdit?: import('../saturn/saturn.js').ScheduleOpRequestV1
      spawnSwitch?: { kind: 'subagents' | 'workflows'; on: boolean }
      terminalApplication?: { identity: string; name: string; windowId?: string | null; tty?: string | null } | null
      agentId?: string
      note?: string
      clientOpId?: string
      clientMessageId?: string
      mintedAtMs?: number
    }
  | {
      op: DaemonOpFor<'sendWords'>
      origin?: import('../../engine/message-shapes/outsideReport.js').OutsideReportOrigin
      proto?: number
      auth?: string
      clientMessageId: string
      prompt: string
      workspaceDir: string
      targetSessionId?: string
      isolation?: 'exclusive' | 'worktree-isolated' | 'read-only'
      model?: string
      effort?: string
      title?: string
      agentName?: string
      seatsMax?: 1 | 2
      resumeSessionId?: string
      by?: string
      mode?: 'prompt' | 'bash'
      priority?: 'now' | 'next' | 'later'
      content?: unknown[]
      sentAt?: string
      kitPreset?: string
    }
  | {
      op: DaemonOpFor<'hello'>
      proto?: number
      clientVersion?: string
      clientBuildTree?: string | null
      clientPid?: number
      clientKind?: 'screen' | 'client'
    }
  | {
      op: DaemonOpFor<'restartWhenIdle'>
      proto?: number
      auth?: string
      by?: string
    }
  | {
      op: DaemonOpFor<'rewind'>
      proto?: number
      auth?: string
      sessionId: string
      by: string
      mode: SessionRewindMode
      userMessageId: string
      dryRun?: boolean
    }
  | ({ op: DaemonOpFor<'fileRestore'>; proto?: number; auth?: string; sessionId: string; by: string } & SessionFileRestoreRequest)
  | {
      op: DaemonOpFor<'signIns'>
      proto?: number
      auth?: string
      refresh?: true
    }
  | {
      op: DaemonOpFor<'processSweep'>
      proto?: number
      auth?: string
      action: 'facts' | 'end'
      expected?: ProcessSweepEntry
    }
export interface SignInFamilyViewV1 {
  family: string
  credentialed: boolean
  label?: string
  usable: boolean
  row?: string
  why?: string
  unfetched?: boolean
  catalogueReadAt?: number
  signedInAt?: number | null
  refused?: { status: 401 | 403; at: number }
}

export interface DaemonSignInViewV1 {
  home: string
  store: string
  defaultFamily: string | null
  readAt: number
  refreshed: boolean
  families: SignInFamilyViewV1[]
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
  predecessorPid?: number | null
  predecessorPids?: number[]
}

export interface WireRosterEntry {
  warm?: boolean
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
  turnStartedAt?: number
  turnOpenedAt?: number
  model?: string
  effort?: string
  pendingModel?: string
  pendingEffort?: string
  respawns?: number
  contextPct?: number
  busy?: boolean
  turnActive?: boolean
  turnElapsedMs?: number
  cwd?: string
  worktree?: string
  paused?: { why: string; words: string; resumesAtMs?: number }
  maxRespawns?: number
  ready?: boolean
  spawnedAt?: number
  crashedAt?: number
  lastError?: string
}

export interface LeaseClient {
  label?: string
  cwd?: string
}

export type DaemonReply =
  | { ok: true; op: 'ping'; version: string; proto: number; working?: number }
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
  | { ok: true; op: 'kill' }
  | { ok: true; op: 'reconfigure'; respawned: boolean; pending: boolean; note?: string }
  | {
      ok: true
      op: DaemonOpFor<'sessionAdmit'>
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
  | { ok: true; op: DaemonOpFor<'sessionList'>; workers: ReadonlyArray<Record<string, unknown>> }
  | {
      ok: true
      op: DaemonOpFor<'sendWords'>
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
  | { ok: true; op: DaemonOpFor<'sessionRelease'>; settled: boolean; killed: boolean }
  | { ok: true; op: DaemonOpFor<'sessionControl'>; outcome: 'applied' | 'noop' | 'refused' | 'draining' | 'queued'; detail?: string; respawned?: true; withdrawn?: boolean; text?: string; reason?: 'taken' | 'unknown'; mcpTools?: McpToolsV1 }
  | ({ ok: true; op: DaemonOpFor<'rewind'> } & SessionRewindOutcomeV1)
  | ({ ok: true; op: DaemonOpFor<'fileRestore'> } & SessionRewindOutcomeV1)
  | { ok: true; op: DaemonOpFor<'concourseWithdraw'>; withdrawn: boolean }
  | { ok: true; op: DaemonOpFor<'concourseWarm'>; state: 'warmed' | 'kept' | 'refused'; detail?: string }
  | ({ ok: true; op: DaemonOpFor<'hello'>; proto: number; minProto: number; ready: boolean } & DaemonHelloFacts)
  | { ok: true; op: DaemonOpFor<'restartWhenIdle'>; state: 'restarting' | 'armed' | 'refused'; live: number; detail?: string }
  | { ok: true; op: DaemonOpFor<'signIns'>; view: DaemonSignInViewV1 }
  | { ok: true; op: DaemonOpFor<'processSweep'>; action: 'facts'; facts: ProcessSweepDaemonAnswer }
  | { ok: true; op: DaemonOpFor<'processSweep'>; action: 'end'; ended: boolean; road: 'daemon' | 'none'; reason: string }
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

export type DaemonReplyTo<Op extends DaemonRequest['op'], Reply = DaemonReply> = Reply extends { ok: true; op: infer Answered }
  ? Op extends Answered
    ? Reply
    : never
  : Reply

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
