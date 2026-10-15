import type { Message } from '../../types/message.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { isMercurySubstrateProfileOn } from '../../utils/config.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { groupMessagesByApiRound } from './grouping.js'
import { roughTokenCountEstimationForMessages } from '../tokenEstimation.js'

export const DEFAULT_KEEP_ROUNDS = 10
export const DEFAULT_TAIL_TOKEN_BUDGET = Infinity
export const MAX_FLOOR_ROUND_TOKENS = Infinity
export const MIN_HEAD_ROUNDS = 2

export function isMercuryCompactKeepTailEnabled(): boolean {
  const flag = flagEnv('MERCURY_COMPACT_KEEP_TAIL')
  if (flag === '0' || flag?.toLowerCase() === 'false') return false
  return isEnvTruthy(flag) || isEnvTruthy(flagEnv('MERCURY_CTX_COMPACTION')) || isMercurySubstrateProfileOn()
}

export type VerbatimTailResult = {
  keep: Message[]
  precedingUuid: Message['uuid'] | undefined
  roundsKept: number
  roundsRequested: number
  estimatedTokens: number
  reason: 'requested-rounds-fit' | 'available-rounds' | 'request-budget'
}

function preservable(row: Message): boolean {
  return row.type !== 'progress' && !(row.type === 'system' && row.subtype === 'compact_boundary') && !(row.type === 'user' && row.isCompactSummary)
}

export function closedTail(messages: readonly Message[]): boolean {
  const calls = new Set<string>()
  const results = new Set<string>()
  for (const row of messages) {
    if (row.type !== 'user' && row.type !== 'assistant') continue
    if (!Array.isArray(row.message.content)) continue
    for (const block of row.message.content) {
      if (block.type === 'tool_use') calls.add(block.id)
      if (block.type === 'tool_result') results.add(block.tool_use_id)
    }
  }
  return [...calls].every(id => results.has(id)) && [...results].every(id => calls.has(id))
}

export function computeVerbatimRecentTail(
  messages: Message[],
  opts?: { keepRounds?: number; tailTokenBudget?: number; fits?: (keep: Message[]) => boolean },
): VerbatimTailResult | null {
  const requested = Math.max(1, opts?.keepRounds ?? DEFAULT_KEEP_ROUNDS)
  const budget = Math.max(0, opts?.tailTokenBudget ?? DEFAULT_TAIL_TOKEN_BUDGET)
  const groups = groupMessagesByApiRound(messages)
  const available = Math.min(requested, groups.length - MIN_HEAD_ROUNDS)
  if (available <= 0) return null
  for (let n = available; n >= 1; n--) {
    const keep = groups.slice(-n).flat().filter(preservable)
    if (!closedTail(keep)) throw new Error('The recent round is incomplete; the original context is kept.')
    const estimatedTokens = roughTokenCountEstimationForMessages(keep)
    if (estimatedTokens > budget || opts?.fits?.(keep) === false) continue
    const first = messages.findIndex(row => row.uuid === keep[0]?.uuid)
    const precedingUuid = messages.slice(0, first).filter(row => row.type !== 'progress').at(-1)?.uuid
    return { keep, precedingUuid, roundsKept: n, roundsRequested: requested, estimatedTokens, reason: n < available ? 'request-budget' : available < requested ? 'available-rounds' : 'requested-rounds-fit' }
  }
  throw new Error('The latest complete round does not fit with the fold obligations; the original context is kept.')
}
