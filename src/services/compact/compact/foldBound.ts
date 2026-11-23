import { logForDebugging } from '../../../utils/debug.js'
import { classifyModelRoute } from '../../providers/routeLaw.js'
import { COLD_INGEST_MS_PER_1K_TOKENS, firstByteBudgetMs, streamIdleTimeoutMsForRoute } from '../../providers/streamIdleBudget.js'
import { recordWireFoldRow, type WireFoldRow } from '../../api/dumpPrompts.js'
import { startTimeout, stopTimeout } from '../../../utils/timers.js'

const FOLD_STALL_MS = 120_000

export const ERROR_MESSAGE_FOLD_TIMEOUT =
  'The summary call stalled and was stopped; the conversation is unchanged. Try again, or start fresh with /clear.'

export type FoldBounds = { stallMs: number; ingestMsPer1kTokens: number }

let foldBoundsOverride: { stallMs: number; ingestMsPer1kTokens?: number } | null = null
export function setFoldBoundsForTests(bounds: { stallMs: number; ingestMsPer1kTokens?: number } | null): void {
  foldBoundsOverride = bounds
}

function foldBounds(): FoldBounds {
  return {
    stallMs: foldBoundsOverride?.stallMs ?? FOLD_STALL_MS,
    ingestMsPer1kTokens: foldBoundsOverride?.ingestMsPer1kTokens ?? COLD_INGEST_MS_PER_1K_TOKENS,
  }
}

export function foldStallMsFor(model: string, floorMs: number = FOLD_STALL_MS): number {
  const verdict = classifyModelRoute(model)
  return Math.max(floorMs, streamIdleTimeoutMsForRoute(verdict.kind === 'route' ? verdict.route : null))
}

function foldStallAfterFirstEventMs(model: string): number {
  return foldBoundsOverride === null ? foldStallMsFor(model) : foldBoundsOverride.stallMs
}

export function foldFirstByteAllowanceMs(estTokens: number, bounds: FoldBounds = foldBounds()): number {
  const tokens = Number.isFinite(estTokens) && estTokens > 0 ? estTokens : 0
  return bounds.stallMs + Math.round((tokens / 1000) * bounds.ingestMsPer1kTokens)
}

export type FoldCut = 'silence'

export type FoldBound = {
  controller: AbortController
  signal: AbortSignal
  touch(): void
  content(): void
  request(): void
  hitDeadline(): boolean
  cutBy(): FoldCut | null
  dispose(): void
}

export function armFoldBound(parent: AbortSignal, road: WireFoldRow['road'], estTokens: number, model: string, cold: boolean): FoldBound {
  const stallMs = foldStallAfterFirstEventMs(model)
  const transportFirstByteMs = foldBoundsOverride === null ? firstByteBudgetMs({ cold, promptTokens: estTokens, idleMs: stallMs }) : 0
  const firstByteMs = Math.max(stallMs, foldFirstByteAllowanceMs(estTokens), transportFirstByteMs)
  const controller = new AbortController()
  let timedOut = false
  let contentSeen = false
  const onParentAbort = (): void => controller.abort()
  if (parent.aborted) controller.abort()
  else parent.addEventListener('abort', onParentAbort, { once: true })
  const expire = (): void => {
    if (timedOut) return
    timedOut = true
    controller.abort()
  }
  let stall: NodeJS.Timeout | null = startTimeout(expire, firstByteMs)
  stall.unref?.()
  const rearm = (): void => {
    if (stall !== null) stopTimeout(stall)
    stall = startTimeout(expire, contentSeen ? stallMs : firstByteMs)
    stall.unref?.()
  }
  logForDebugging(`compact: ${road} lane bound armed — first-byte allowance ${firstByteMs} ms for ≈${Math.round(estTokens)} tokens, stall ${stallMs} ms after the first event (${cold ? 'cold' : 'warm'} prefix)`)
  return {
    controller,
    signal: controller.signal,
    touch: rearm,
    content(): void {
      contentSeen = true
      rearm()
    },
    request(): void {
      contentSeen = false
      rearm()
    },
    hitDeadline: () => timedOut,
    cutBy: () => timedOut ? 'silence' : null,
    dispose(): void {
      if (stall !== null) stopTimeout(stall)
      parent.removeEventListener('abort', onParentAbort)
    },
  }
}

export function foldCutWords(_bound: FoldBound): string {
  return 'silence on the wire'
}

export function shouldRideCacheSharingFork(model: string, _thinkingConfig?: { type: string }): boolean {
  const verdict = classifyModelRoute(model)
  if (verdict.kind === 'absence') return false
  if (verdict.kind === 'unrecognised') return true
  return verdict.route === 'anthropic'
}

export function foldFamilyOf(model: string): string {
  const verdict = classifyModelRoute(model)
  return verdict.kind === 'route' ? verdict.route : verdict.kind
}

export function recordFoldRoad(
  model: string,
  road: WireFoldRow['road'],
  startedAt: number,
  outcome: WireFoldRow['outcome'],
  detail?: string,
): void {
  recordWireFoldRow({
    family: foldFamilyOf(model),
    road,
    model,
    outcome,
    ms: Date.now() - startedAt,
    ...(detail !== undefined ? { detail } : {}),
  })
}
