import type { Message } from '../../types/message.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import {
  isMercurySubstrateProfileOn,
} from '../../utils/config.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { groupMessagesByApiRound } from './grouping.js'


export const DEFAULT_KEEP_ROUNDS = 6

export const DEFAULT_TAIL_TOKEN_BUDGET = 15_000

export const MAX_FLOOR_ROUND_TOKENS = DEFAULT_TAIL_TOKEN_BUDGET * 2

export const MIN_HEAD_ROUNDS = 2

export function isMercuryCompactKeepTailEnabled(): boolean {
  
  const flag = flagEnv('MERCURY_COMPACT_KEEP_TAIL')
  if (flag === '0' || flag?.toLowerCase() === 'false') return false
  if (isEnvTruthy(flag)) return true
  return (
    isEnvTruthy(flagEnv('MERCURY_CTX_COMPACTION')) || isMercurySubstrateProfileOn()
  )
}

export type VerbatimTailResult = {
  keep: Message[]
  precedingUuid: Message['uuid'] | undefined
  roundsKept: number
}

function isNonPreservableTailMessage(m: Message): boolean {
  if (m.type === 'progress') return true
  if (
    m.type === 'system' &&
    (m as { subtype?: string }).subtype === 'compact_boundary'
  ) {
    return true
  }
  if (
    m.type === 'user' &&
    (m as { isCompactSummary?: boolean }).isCompactSummary === true
  ) {
    return true
  }
  return false
}

const IMAGE_DOC_BLOCK_TOKENS = 2000

function estimateMessageTokens(m: Message): number {
  const msg = (m as { message?: { content?: unknown } }).message
  const content = msg?.content
  if (content === undefined) {
    try {
      return Math.ceil(JSON.stringify(m).length / 4)
    } catch {
      return 0
    }
  }
  if (typeof content === 'string') return Math.ceil(content.length / 4)
  if (Array.isArray(content)) {
    let n = 0
    for (const block of content as Array<{ type?: string; content?: unknown }>) {
      const t = block?.type
      if (t === 'image' || t === 'document') {
        n += IMAGE_DOC_BLOCK_TOKENS
        continue
      }
      if (t === 'tool_result' && Array.isArray(block.content)) {
        for (const inner of block.content as Array<{ type?: string }>) {
          if (inner?.type === 'image' || inner?.type === 'document') {
            n += IMAGE_DOC_BLOCK_TOKENS
          } else {
            try {
              n += Math.ceil(JSON.stringify(inner).length / 4)
            } catch {
            }
          }
        }
        continue
      }
      try {
        n += Math.ceil(JSON.stringify(block).length / 4)
      } catch {
      }
    }
    return n
  }
  try {
    return Math.ceil(JSON.stringify(content).length / 4)
  } catch {
    return 0
  }
}

function estimateRoundTokens(group: Message[]): number {
  let n = 0
  for (const m of group) n += estimateMessageTokens(m)
  return n
}

export function computeVerbatimRecentTail(
  messages: Message[],
  opts?: { keepRounds?: number; tailTokenBudget?: number },
): VerbatimTailResult | null {
  const keepRounds = Math.max(1, opts?.keepRounds ?? DEFAULT_KEEP_ROUNDS)
  const budget = Math.max(0, opts?.tailTokenBudget ?? DEFAULT_TAIL_TOKEN_BUDGET)

  const groups = groupMessagesByApiRound(messages)
  if (groups.length < keepRounds + MIN_HEAD_ROUNDS) return null

  let tailGroups = groups.slice(-keepRounds)

  while (
    tailGroups.length > 1 &&
    tailGroups.reduce((s, g) => s + estimateRoundTokens(g), 0) > budget
  ) {
    tailGroups = tailGroups.slice(1)
  }

  if (
    tailGroups.length === 1 &&
    estimateRoundTokens(tailGroups[0]!) > MAX_FLOOR_ROUND_TOKENS
  ) {
    return null
  }

  const keep = tailGroups.flat().filter(m => !isNonPreservableTailMessage(m))
  if (keep.length === 0) return null

  const firstKeptIdx = messages.findIndex(m => m.uuid === keep[0]!.uuid)
  let precedingUuid: Message['uuid'] | undefined
  for (let j = firstKeptIdx - 1; j >= 0; j--) {
    const prev = messages[j]
    if (prev && prev.type !== 'progress') {
      precedingUuid = prev.uuid
      break
    }
  }

  return { keep, precedingUuid, roundsKept: tailGroups.length }
}
