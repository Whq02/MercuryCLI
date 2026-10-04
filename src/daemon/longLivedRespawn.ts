import { isOutcome, mainThreadStep, outcomeErrorText, outcomeFailed, turnOpened, type LooseRow } from '../rows/read.js'

export interface LongLivedRespawnConfig {
  maxRespawns: number
  backoffBaseMs: number
  backoffCapMs: number
  healthyResetMs?: number
  maxLifetimeCrashes?: number
}

export const DEFAULT_HEALTHY_RESET_MS = 5 * 60 * 1000
export const DEFAULT_MAX_LIFETIME_CRASHES = 20

export const DEFAULT_LONG_LIVED_CONFIG: LongLivedRespawnConfig = {
  maxRespawns: 5,
  backoffBaseMs: 1000,
  backoffCapMs: 60_000,
  healthyResetMs: DEFAULT_HEALTHY_RESET_MS,
  maxLifetimeCrashes: DEFAULT_MAX_LIFETIME_CRASHES,
}

export function longLivedBackoffMs(
  respawns: number,
  cfg: LongLivedRespawnConfig = DEFAULT_LONG_LIVED_CONFIG,
): number {
  const n = Math.max(1, respawns)
  if (n === 1) return 0
  return Math.min(cfg.backoffCapMs, cfg.backoffBaseMs * 2 ** (n - 1))
}

export type RespawnDecision =
  | { action: 'respawn'; delayMs: number; respawns: number }
  | { action: 'degrade'; reason: string; respawns: number }

export function decideRespawn(
  respawns: number,
  cfg: LongLivedRespawnConfig = DEFAULT_LONG_LIVED_CONFIG,
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


export const DEFAULT_RECONFIGURE_IDLE_MS = 15_000

export function workerIsIdle(
  lastDeliveredAt: number | undefined,
  now: number,
  idleMs: number = DEFAULT_RECONFIGURE_IDLE_MS,
): boolean {
  return lastDeliveredAt === undefined || now - lastDeliveredAt > idleMs
}

export type RowUsage = {
  input_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
  output_tokens: number
}

export function occupancyOfRow(row: LooseRow | null): RowUsage | null {
  if (!mainThreadStep(row)) return null
  const usage = (row as { usage?: Record<string, unknown> }).usage
  if (!usage || typeof usage !== 'object') return null
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  const cached = n(usage.cached_input_tokens)
  const written = n(usage.cache_write_input_tokens)
  return {
    input_tokens: Math.max(0, n(usage.input_tokens) - cached - written),
    cache_creation_input_tokens: written,
    cache_read_input_tokens: cached,
    output_tokens: n(usage.output_tokens),
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


export const DEFAULT_MAX_TURN_MS = 20 * 60 * 1000

export function getMaxTurnMs(env: string | undefined): number {
  const n = env ? parseInt(env, 10) : NaN
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_TURN_MS
}

export function isOutcomeRow(row: LooseRow | null): boolean {
  return isOutcome(row)
}

export function isTurnOpenRow(row: LooseRow | null): boolean {
  return turnOpened(row)
}

export const ERROR_TEXT_CAP = 240

export function errorTextOfOutcome(row: LooseRow | null): string | undefined {
  if (!isOutcome(row) || !outcomeFailed(row)) return undefined
  const message = outcomeErrorText(row)
  const detail = (row as { error?: { detail?: unknown } }).error?.detail
  const listed = [message ?? '', ...(Array.isArray(detail) ? detail.filter((entry): entry is string => typeof entry === 'string') : [])]
    .map(entry => entry.replace(/\s+/g, ' ').trim())
    .filter(entry => entry !== '')
  return (listed.length > 0 ? listed.join('; ') : `the turn ended ${String((row as { status?: unknown }).status ?? 'without an answer')}`).slice(0, ERROR_TEXT_CAP)
}

export const STDERR_TAIL_BYTES = 4096

export function keepStderrTail(tail: Buffer | undefined, chunk: Buffer): Buffer {
  const joined = Buffer.concat(tail === undefined ? [chunk] : [tail, chunk])
  return joined.length > STDERR_TAIL_BYTES ? Buffer.from(joined.subarray(joined.length - STDERR_TAIL_BYTES)) : joined
}

export function lastStderrLine(tail: Buffer | undefined): string | undefined {
  if (tail === undefined) return undefined
  const lines = tail.toString('utf8').split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (line !== '') return line.slice(0, ERROR_TEXT_CAP)
  }
  return undefined
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
