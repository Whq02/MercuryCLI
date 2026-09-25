import { flagEnv } from '../../substrate/flagRegistry.js'
import { extractConnectionErrorDetails } from './errorUtils.js'
import { outageSpentLine, outageWaitWords, type OutageWaitFacts } from './recoveryBudget.js'
import { APIConnectionError, APIConnectionTimeoutError } from './sdkErrors.js'
import { deepestErrorDetail, isStaleSocketCode, recentTransportFailure } from './transportEvidence.js'

export const RECONNECT_FIRST_WAIT_MS = 5_000
export const RECONNECT_WAIT_CEILING_MS = 60_000
export const RECONNECT_BUDGET_DEFAULT_MINUTES = 10
export const RECONNECT_BUDGET_MAX_MINUTES = 24 * 60
export const CONNECT_TIMEOUT_RING_WINDOW_MS = 2_000

export function reconnectBudgetMs(): number {
  const raw = flagEnv('MERCURY_RECONNECT_BUDGET_MINUTES')
  const pinned = raw === undefined || raw.trim() === '' ? Number.NaN : Number.parseFloat(raw)
  const minutes = Number.isFinite(pinned) && pinned >= 0 ? Math.min(pinned, RECONNECT_BUDGET_MAX_MINUTES) : RECONNECT_BUDGET_DEFAULT_MINUTES
  return minutes === 0 ? Infinity : minutes * 60_000
}

export function reconnectScale(): number {
  const raw = flagEnv('MERCURY_RECONNECT_SCALE')
  const parsed = raw === undefined || raw.trim() === '' ? Number.NaN : Number.parseFloat(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 1
}

const OUTAGE_WORDS: ReadonlyMap<string, string> = new Map([
  ['ENOTFOUND', 'host not found'],
  ['EAI_AGAIN', 'host not found'],
  ['EAI_FAIL', 'host not found'],
  ['EAI_NONAME', 'host not found'],
  ['EAI_NODATA', 'host not found'],
  ['ECONNREFUSED', 'connection refused'],
  ['ConnectionRefused', 'connection refused'],
  ['ENETUNREACH', 'no route to the host'],
  ['EHOSTUNREACH', 'no route to the host'],
  ['EHOSTDOWN', 'no route to the host'],
  ['ENETDOWN', 'the network is down'],
  ['ENETRESET', 'the network is down'],
  ['EADDRNOTAVAIL', 'no local address to connect from'],
])

const CONNECT_TIMEOUT_WORDS = 'connect timed out'
const CONNECT_TIMEOUT_CODES: ReadonlySet<string> = new Set(['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT'])

export interface OutageCause {
  code: string
  words: string
}

function isSdkConnectionError(error: unknown): boolean {
  if (error instanceof APIConnectionError) return true
  if (!(error instanceof Error)) return false
  const className = error.constructor?.name
  return className === 'APIConnectionError' || className === 'APIConnectionTimeoutError'
}

function isSdkTimeout(error: unknown): boolean {
  if (error instanceof APIConnectionTimeoutError) return true
  return error instanceof Error && error.constructor?.name === 'APIConnectionTimeoutError'
}

function connectTimeoutCause(code: string, syscall: string | undefined): OutageCause | null {
  if (!CONNECT_TIMEOUT_CODES.has(code)) return null
  if (code === 'ETIMEDOUT' && syscall !== undefined && syscall !== 'connect') return null
  return { code, words: CONNECT_TIMEOUT_WORDS }
}

export function connectTimeoutFromTransportRing(nowMs: number = Date.now()): OutageCause | null {
  const recent = recentTransportFailure(CONNECT_TIMEOUT_RING_WINDOW_MS)
  if (recent === undefined || recent.code === undefined || nowMs - recent.ts > CONNECT_TIMEOUT_RING_WINDOW_MS) return null
  return connectTimeoutCause(recent.code, recent.syscall)
}

function outageCauseOfChain(error: unknown): OutageCause | null {
  const deep = deepestErrorDetail(error)
  if (deep.code === undefined || isStaleSocketCode(deep.code)) return null
  if (extractConnectionErrorDetails(error)?.isSSLError === true) return null
  const timedOut = connectTimeoutCause(deep.code, deep.syscall)
  if (timedOut !== null) return timedOut
  const words = OUTAGE_WORDS.get(deep.code)
  return words === undefined ? null : { code: deep.code, words }
}

export function outageCauseOf(error: unknown): OutageCause | null {
  if (!isSdkConnectionError(error)) return null
  if (typeof (error as { status?: unknown }).status === 'number') return null
  if (isSdkTimeout(error)) return deepestErrorDetail(error).code === undefined ? connectTimeoutFromTransportRing() : null
  return outageCauseOfChain(error)
}

export function outageCauseOfFetchFailure(error: unknown): OutageCause | null {
  if (!(error instanceof Error)) return null
  if (typeof (error as { status?: unknown }).status === 'number') return null
  return outageCauseOfChain(error)
}

export function outageCauseWords(cause: OutageCause): string {
  return `network unreachable (${cause.words})`
}

export interface ReconnectLadder {
  readonly capMs: number
  readonly startedAtMs: number
  readonly firstWaitMs: number
  readonly ceilingMs: number
  reconnects: number
  cause: OutageCause
}

export function openReconnectLadder(nowMs: number, cause: OutageCause, capMs: number = reconnectBudgetMs(), scale: number = reconnectScale()): ReconnectLadder {
  return {
    capMs,
    startedAtMs: nowMs,
    firstWaitMs: Math.max(1, Math.round(RECONNECT_FIRST_WAIT_MS * scale)),
    ceilingMs: Math.max(1, Math.round(RECONNECT_WAIT_CEILING_MS * scale)),
    reconnects: 0,
    cause,
  }
}

export function reconnectRungMs(ladder: Pick<ReconnectLadder, 'firstWaitMs' | 'ceilingMs'>, reconnect: number): number {
  return Math.min(ladder.firstWaitMs * 2 ** Math.max(0, reconnect - 1), ladder.ceilingMs)
}

export function reconnectsWithin(ladder: Pick<ReconnectLadder, 'firstWaitMs' | 'ceilingMs'>, fromReconnect: number, leftMs: number): number {
  if (!Number.isFinite(leftMs) || leftMs <= 0) return 0
  let count = 0
  let remaining = leftMs
  for (let rung = fromReconnect; remaining > 0; rung++) {
    const rungMs = reconnectRungMs(ladder, rung)
    if (rungMs >= ladder.ceilingMs) return count + Math.ceil(remaining / ladder.ceilingMs)
    count++
    remaining -= rungMs
  }
  return count
}

export function nextReconnect(ladder: ReconnectLadder, cause: OutageCause, nowMs: number): OutageWaitFacts {
  ladder.cause = cause
  const words = outageCauseWords(cause)
  const left = ladder.capMs - Math.max(0, nowMs - ladder.startedAtMs)
  if (left <= 0) {
    return {
      cause: words,
      code: cause.code,
      reconnect: ladder.reconnects,
      of: ladder.reconnects,
      waitMs: 0,
      rungMs: reconnectRungMs(ladder, ladder.reconnects + 1),
      capMs: ladder.capMs,
      leftMs: 0,
      spent: true,
      sinceMs: ladder.startedAtMs,
    }
  }
  const reconnect = ladder.reconnects + 1
  const rungMs = reconnectRungMs(ladder, reconnect)
  const waitMs = Math.min(rungMs, left)
  const leftMs = left - waitMs
  ladder.reconnects = reconnect
  return {
    cause: words,
    code: cause.code,
    reconnect,
    of: ladder.capMs === Infinity ? reconnect : reconnect + reconnectsWithin(ladder, reconnect + 1, leftMs),
    waitMs,
    rungMs,
    capMs: ladder.capMs,
    leftMs,
    spent: leftMs <= 0,
    sinceMs: ladder.startedAtMs,
  }
}

export class NetworkOutageError extends Error {
  readonly networkOutage = true as const
  readonly outage: OutageWaitFacts
  readonly code: string
  constructor(outage: OutageWaitFacts, cause: unknown) {
    super(outageWaitWords(outage), cause instanceof Error ? { cause } : undefined)
    this.name = 'NetworkOutageError'
    this.outage = outage
    this.code = outage.code
  }
}

export class ReconnectBudgetSpentError extends Error {
  readonly reconnectBudgetSpent = true as const
  readonly capMs: number
  readonly reconnects: number
  readonly elapsedMs: number
  readonly lastCause: string
  constructor(ladder: ReconnectLadder, nowMs: number, cause: unknown) {
    const elapsedMs = Math.max(0, nowMs - ladder.startedAtMs)
    super(outageSpentLine({ cause: outageCauseWords(ladder.cause), reconnects: ladder.reconnects, capMs: ladder.capMs, elapsedMs }, 'turn'), cause instanceof Error ? { cause } : undefined)
    this.name = 'ReconnectBudgetSpentError'
    this.capMs = ladder.capMs
    this.reconnects = ladder.reconnects
    this.elapsedMs = elapsedMs
    this.lastCause = outageCauseWords(ladder.cause)
  }
}
