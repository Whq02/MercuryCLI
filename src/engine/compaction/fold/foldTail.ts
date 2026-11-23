import type { UUID } from 'node:crypto'
import type { CompactMetadata, Message } from '../../message-shapes/message.js'
import { logForDebugging } from '../../../platform/logs/debugLog.js'
import { stripThinkingFromIndex } from '../../messages/apiFilters.js'
import { computeVerbatimRecentTail, isMercuryCompactKeepTailEnabled } from '../verbatimTail.js'
import type { FitsUnder } from './foldSummary.js'

export type TailSelector = (opts: Parameters<typeof computeVerbatimRecentTail>[1]) => ReturnType<typeof computeVerbatimRecentTail>

interface TailNeeds {
  selectTail: TailSelector
  fitsUnder: FitsUnder
  prose: string
  memoryText: string
  landing: number | undefined
  ceiling: number | undefined
}

export function chooseFoldTail({ selectTail, fitsUnder, prose, memoryText, landing, ceiling }: TailNeeds): { messagesToKeep: Message[] | undefined; tailPrecedingUuid: UUID | undefined; recentRounds: CompactMetadata['recentRounds']; foldTarget: number | undefined } {
  let messagesToKeep: Message[] | undefined
  let tailPrecedingUuid: UUID | undefined
  let recentRounds: CompactMetadata['recentRounds']
  let foldTarget: number | undefined
  if (isMercuryCompactKeepTailEnabled()) {
    const fits = (limit: number | undefined, resultsFolded = false) => fitsUnder(limit, resultsFolded, prose, memoryText)
    let tail: ReturnType<typeof computeVerbatimRecentTail>
    try {
      tail = selectTail({ fits: fits(landing) })
    } catch (error) {
      if (landing === undefined) throw error
      try {
        tail = selectTail({ fits: fits(ceiling) })
      } catch {
        try {
          tail = selectTail({ fits: fits(landing, true) })
          foldTarget = landing
        } catch {
          tail = selectTail({ fits: fits(ceiling, true) })
          foldTarget = ceiling
        }
      }
    }
    if (tail !== null && tail.keep.length > 0) {
      messagesToKeep = stripThinkingFromIndex(tail.keep, 0)
      tailPrecedingUuid = tail.precedingUuid
      recentRounds = { requested: tail.roundsRequested, kept: tail.roundsKept, tokens: tail.estimatedTokens, reason: tail.reason }
      logForDebugging(`compact: verbatim tail keeps ${tail.roundsKept} rounds (${tail.keep.length} messages)`)
    }
  }
  return { messagesToKeep, tailPrecedingUuid, recentRounds, foldTarget }
}
