
export interface LongLivedSupervisorConfig {
  maxRespawns: number
  backoffBaseMs: number
  backoffCapMs: number
  healthyResetMs?: number
  maxLifetimeCrashes?: number
}

export const DEFAULT_HEALTHY_RESET_MS = 5 * 60 * 1000
export const DEFAULT_MAX_LIFETIME_CRASHES = 20

export const DEFAULT_LONG_LIVED_CONFIG: LongLivedSupervisorConfig = {
  maxRespawns: 5,
  backoffBaseMs: 1000,
  backoffCapMs: 60_000,
  healthyResetMs: DEFAULT_HEALTHY_RESET_MS,
  maxLifetimeCrashes: DEFAULT_MAX_LIFETIME_CRASHES,
}

export const LONG_LIVED_FEEDS_SHARED_BREAKER = false

export function longLivedBackoffMs(
  respawns: number,
  cfg: LongLivedSupervisorConfig = DEFAULT_LONG_LIVED_CONFIG,
): number {
  const n = Math.max(1, respawns)
  return Math.min(cfg.backoffCapMs, cfg.backoffBaseMs * 2 ** (n - 1))
}

export type RespawnDecision =
  | { action: 'respawn'; delayMs: number; respawns: number }
  | { action: 'degrade'; reason: string; respawns: number }

export function decideRespawn(
  respawns: number,
  cfg: LongLivedSupervisorConfig = DEFAULT_LONG_LIVED_CONFIG,
  lifetimeCrashes?: number,
): RespawnDecision {
  const lifetimeCap = cfg.maxLifetimeCrashes ?? DEFAULT_MAX_LIFETIME_CRASHES
  if (lifetimeCrashes !== undefined && lifetimeCrashes > lifetimeCap) {
    return {
      action: 'degrade',
      reason: `long-lived worker exceeded ${lifetimeCap} lifetime crashes (slow crash-loop)`,
      respawns,
    }
  }
  if (respawns > cfg.maxRespawns) {
    return {
      action: 'degrade',
      reason: `long-lived worker exceeded ${cfg.maxRespawns} respawns`,
      respawns,
    }
  }
  return { action: 'respawn', delayMs: longLivedBackoffMs(respawns, cfg), respawns }
}

export function normalizeStreamJsonFrame(frame: string): string {
  return frame.endsWith('\n') ? frame : `${frame}\n`
}


export const DEFAULT_RECONFIGURE_IDLE_MS = 15_000

export function workerIsIdle(
  lastDeliveredAt: number | undefined,
  now: number,
  idleMs: number = DEFAULT_RECONFIGURE_IDLE_MS,
): boolean {
  return lastDeliveredAt === undefined || now - lastDeliveredAt > idleMs
}

export type StreamJsonUsage = {
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  output_tokens: number
}

export function parseStreamJsonFrame(line: string): Record<string, unknown> | null {
  const t = line.trim()
  if (!t || t[0] !== '{') return null
  try {
    const parsed = JSON.parse(t) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export function parseUsageFromStreamJsonLine(line: string): StreamJsonUsage | null {
  return usageOfStreamJsonFrame(parseStreamJsonFrame(line))
}

export function usageOfStreamJsonFrame(frame: Record<string, unknown> | null): StreamJsonUsage | null {
  if (frame === null) return null
  if (frame.type === 'result') return null
  const msg = frame.message as Record<string, unknown> | undefined
  const u = (frame.usage ?? msg?.usage) as Record<string, unknown> | undefined
  if (!u || typeof u !== 'object') return null
  if (
    u.input_tokens === undefined &&
    u.cache_read_input_tokens === undefined &&
    u.cache_creation_input_tokens === undefined
  ) {
    return null
  }
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    input_tokens: n(u.input_tokens),
    cache_creation_input_tokens: n(u.cache_creation_input_tokens),
    cache_read_input_tokens: n(u.cache_read_input_tokens),
    output_tokens: n(u.output_tokens),
  }
}


export type WireSpecView = {
  model: string
  effort: string
  pendingModel?: string
  pendingEffort?: string
}

export function deriveWireSpec(args: {
  running: { model: string; effort: string } | undefined
  spec: { model: string; effort: string }
  pendingReconfigure?: boolean
  reconfiguring?: boolean
}): WireSpecView {
  const model = args.running?.model ?? args.spec.model
  const effort = args.running?.effort ?? args.spec.effort
  const owed = args.pendingReconfigure === true || args.reconfiguring === true
  return {
    model,
    effort,
    ...(owed && args.spec.model !== model ? { pendingModel: args.spec.model } : {}),
    ...(owed && args.spec.effort !== effort ? { pendingEffort: args.spec.effort } : {}),
  }
}

export type ReconfigureDecision = { respawn: boolean; pending: boolean }

export function decideReconfigure(args: {
  lastDeliveredAt: number | undefined
  now: number
  idleMs?: number
}): ReconfigureDecision {
  const idle = workerIsIdle(args.lastDeliveredAt, args.now, args.idleMs ?? DEFAULT_RECONFIGURE_IDLE_MS)
  return idle ? { respawn: true, pending: false } : { respawn: false, pending: true }
}


export const DEFAULT_MAX_TURN_MS = 20 * 60 * 1000

export function getMaxTurnMs(env: string | undefined): number {
  const n = env ? parseInt(env, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_TURN_MS
}

export function isTurnResultFrame(line: string): boolean {
  return isTurnResultParsedFrame(parseStreamJsonFrame(line))
}

export function isTurnResultParsedFrame(frame: Record<string, unknown> | null): boolean {
  return frame !== null && frame.type === 'result'
}

export {
  TURN_STARTED_SUBTYPE,
  turnStartedFrame,
  isTurnStartedParsedFrame,
  MISSION_UPDATED_SUBTYPE,
  missionUpdatedFrame,
  isMissionUpdatedParsedFrame,
  SAMPLES_UPDATED_SUBTYPE,
  samplesUpdatedFrame,
  isSamplesUpdatedParsedFrame,
} from './runnerFrames.js'
export type { TurnStartedFrame, MissionUpdatedFrame, SamplesUpdatedFrame } from './runnerFrames.js'

export function errorTextOfResultFrame(line: string): string | undefined {
  return errorTextOfParsedResultFrame(parseStreamJsonFrame(line))
}

export function errorTextOfParsedResultFrame(frame: Record<string, unknown> | null): string | undefined {
  if (frame === null || frame.type !== 'result' || frame.is_error !== true) return undefined
  const text = typeof frame.result === 'string' ? frame.result : JSON.stringify(frame.result)
  return (text ?? 'unknown error').slice(0, 240)
}

export type WorkerBusyDecision = { busy: boolean; basis: 'turn' | 'turn-capped' | 'delivery-clock' }

export function decideWorkerBusy(args: {
  turnActive: boolean | undefined
  turnStartedAt: number | undefined
  now: number
  lastDeliveredAt: number | undefined
  idleMs?: number
  maxTurnMs?: number
}): WorkerBusyDecision {
  if (args.turnActive === true) {
    const cap = args.maxTurnMs ?? DEFAULT_MAX_TURN_MS
    if (args.turnStartedAt !== undefined && args.now - args.turnStartedAt > cap) {
      return { busy: false, basis: 'turn-capped' }
    }
    return { busy: true, basis: 'turn' }
  }
  if (args.turnActive === false) return { busy: false, basis: 'turn' }
  return { busy: !workerIsIdle(args.lastDeliveredAt, args.now, args.idleMs), basis: 'delivery-clock' }
}

export type DispatchBackPressure = { hold: boolean; reason: 'busy' | 'idle' | 'unknown' }

export function decideDispatchBackPressure(args: {
  lastDeliveredAt: number | undefined
  now: number
  idleMs?: number
  maxInFlight?: number
}): DispatchBackPressure {
  if (args.lastDeliveredAt === undefined) return { hold: false, reason: 'unknown' }
  const idle = workerIsIdle(args.lastDeliveredAt, args.now, args.idleMs ?? DEFAULT_RECONFIGURE_IDLE_MS)
  if (idle) return { hold: false, reason: 'idle' }
  return { hold: (args.maxInFlight ?? 1) <= 1, reason: 'busy' }
}
