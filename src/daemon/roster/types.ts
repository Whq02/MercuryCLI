import type { ChildProcess } from 'node:child_process'
import type { LooseRow } from '../../engine/rows/read.js'
import type { PermissionRequestParams, SessionAppliedParams } from '../runner-wire/methods.js'
import type { HeldAsk, RunnerConnection } from '../runner-link/runnerConnection.js'
import type { DaemonBreaker } from '../control/daemonBreaker.js'
import type { RunnerChildSpec } from '../runner-link/headlessRun.js'
import type { LongLivedRespawnConfig } from './longLivedRespawn.js'
import type { DispatchSource } from '../control/protocol.js'

type RosterState =
  | 'spawning'
  | 'running'
  | 'retiring'
  | 'settled'
  | 'crashed'

export interface RosterEntry {
  short: string
  sessionId: string
  prompt: string
  source: DispatchSource
  state: RosterState
  pid?: number
  startedAt: number
  cliVersion: string
  outcome?: string
  via?: string
  cwd?: string
  worktree?: string
}

export interface LongLivedSeat {
  spec: RunnerChildSpec
  cfg: LongLivedRespawnConfig
  respawns: number
  lifetimeCrashes: number
  lastSpawnAt: number
  intentionalStop: boolean
  respawnTimer?: ReturnType<typeof setTimeout>
  reconfiguring?: boolean
  pendingReconfigure?: boolean
  lastDeliveredAt?: number
  contextPct?: number
  turnActive?: boolean
  turnStartedAt?: number
  waitingOnAgents?: number
  turnEdges: number
  seenDispatchIds?: Set<string>
  clearInFlight?: boolean
  spawnGeneration: number
  lastErrorText?: string
  stderrTail?: Buffer
  connection?: RunnerConnection
  stormNotified?: boolean
  running?: { model: string; effort: string }
  paused?: SeatPause
  ready?: boolean
  claimedAt?: number
  crashedAt?: number
}

export type SeatPause = { why: string; words: string; resumesAtMs?: number }

export interface WorkerHandle {
  entry: RosterEntry
  child?: ChildProcess
  done: Promise<void>
  longLived?: LongLivedSeat
}

export interface RosterOptions {
  dir: string
  breaker: DaemonBreaker
  maxInflight: number
  onDegraded?: (reason: string, short?: string) => void
  onIdle?: (short: string) => void
  onAsk?: (short: string, params: PermissionRequestParams) => HeldAsk
  onRow?: (short: string, row: LooseRow) => void
  onApplied?: (short: string, params: SessionAppliedParams) => void
  onScheduleEdit?: (short: string, params: import('../runner-wire/methods.js').ParamsOf<'schedule/edit'>) => import('../runner-wire/methods.js').ResultOf<'schedule/edit'> | Promise<import('../runner-wire/methods.js').ResultOf<'schedule/edit'>>
  onChildRelaunched?: (short: string, pid: number) => void
  onChildReady?: (short: string) => void
  onChildCrashed?: (short: string) => void
  platform?: NodeJS.Platform
  runnerAskBoundMs?: number
}

export interface DispatchOutcome {
  ok: boolean
  short: string
  pid?: number
  via?: string
  code?: 'EALIVE' | 'ENOCONN'
  error?: string
}
