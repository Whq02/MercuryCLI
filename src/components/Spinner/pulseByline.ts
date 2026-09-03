
import { stringWidth } from '../../ink/stringWidth.js'
import {
  computeDisplayPhase,
  type PhaseDetail,
  type TurnPhaseName,
  type TurnPhaseSnapshot,
} from '../../utils/pulse/index.js'

export const PHASE_DWELL_MS = 200

function phaseParts(
  phase: TurnPhaseName,
  detail: PhaseDetail,
  activeToolCount: number,
  verb: string | undefined,
): { heads: string[]; extras: string[] } | null {
  switch (phase) {
    case 'accepted':
      return { heads: ['Starting'], extras: [] }
    case 'preparing': {
      const label =
        detail.reason === 'hooks'
          ? 'Checking prompt hooks'
          : detail.reason === 'workspace'
            ? 'Collecting workspace context'
            : detail.reason === 'input'
              ? 'Reading input'
              : detail.reason === 'context'
                ? 'Preparing context'
                : 'Preparing'
      return { heads: [label, 'Preparing'], extras: [] }
    }
    case 'compacting':
      return { heads: ['Compacting context', 'Compacting'], extras: [] }
    case 'dispatching':
      return { heads: ['Sending request', 'Sending'], extras: [] }
    case 'waiting': {
      const who = detail.servedBy ? `${detail.servedBy} (fallback)` : detail.model
      const waitHeads = detail.wait ? [verb ? `${verb} · ${detail.wait}` : detail.wait] : []
      if (verb) {
        return {
          heads: who
            ? [...waitHeads, `${verb} · waiting for ${who}`, `${verb} · waiting`, verb]
            : [...waitHeads, `${verb} · waiting`, verb],
          extras: detail.effort ? [detail.effort] : [],
        }
      }
      return {
        heads: who ? [...waitHeads, `Waiting for ${who}`, 'Waiting'] : [...waitHeads, 'Waiting'],
        extras: detail.effort ? [detail.effort] : [],
      }
    }
    case 'thinking': {
      const extras = [
        ...(detail.servedBy ? [`${detail.servedBy} (fallback)`] : []),
        ...(detail.effort ? [detail.effort] : []),
      ]
      if (verb) {
        return { heads: [`${verb} · thinking`, verb], extras }
      }
      return { heads: ['Thinking'], extras }
    }
    case 'tool-work': {
      const n = detail.toolCount ?? activeToolCount
      if (n < 2) return null
      return { heads: [`Running ${n} tools`], extras: [] }
    }
    case 'settling':
      return { heads: ['Settling turn', 'Settling'], extras: [] }
    default:
      return null
  }
}

export type PhaseBylineInput = {
  phase: TurnPhaseName
  detail: PhaseDetail
  activeToolCount: number
  maxWidth: number
  verb?: string
}

export function composePhaseByline(input: PhaseBylineInput): string | null {
  const parts = phaseParts(input.phase, input.detail, input.activeToolCount, input.verb)
  if (!parts) return null
  for (const head of parts.heads) {
    for (let n = parts.extras.length; n >= 0; n--) {
      const candidate = [head, ...parts.extras.slice(0, n)].join(' · ')
      if (stringWidth(candidate) <= input.maxWidth) return candidate
    }
  }
  return parts.heads[parts.heads.length - 1]!
}


export const THINKING_LINGER_MS = 2000

export interface ThinkingSpanTracker {
  phase: TurnPhaseName
  since: number
  last: { endedAt: number; durationMs: number } | null
}

export const IDLE_THINKING_TRACKER: ThinkingSpanTracker = {
  phase: 'idle',
  since: 0,
  last: null,
}

export function nextThinkingSpan(
  prev: ThinkingSpanTracker,
  phase: TurnPhaseName,
  now: number,
): ThinkingSpanTracker {
  if (phase === prev.phase) return prev
  if (prev.phase === 'thinking') {
    return {
      phase,
      since: now,
      last: { endedAt: now, durationMs: Math.max(0, now - prev.since) },
    }
  }
  return { phase, since: now, last: prev.last }
}

export function thinkingPostscript(
  tracker: ThinkingSpanTracker,
  now: number,
): string | null {
  if (tracker.phase === 'thinking') return null
  const last = tracker.last
  if (last === null) return null
  if (now - last.endedAt >= THINKING_LINGER_MS) return null
  return `thought for ${Math.max(1, Math.round(last.durationMs / 1000))}s`
}

export function nextDisplayedPhase(
  prev: { generation: number; phase: TurnPhaseName },
  snap: TurnPhaseSnapshot,
  now: number,
  reducedMotion: boolean,
): TurnPhaseName {
  if (snap.generation === 0 || snap.phase === 'idle') return 'idle'
  if (reducedMotion) return snap.phase
  const prevPhase = prev.generation === snap.generation ? prev.phase : 'idle'
  return computeDisplayPhase(prevPhase, snap, now, PHASE_DWELL_MS)
}
