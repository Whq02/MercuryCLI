import type { CompactMetadata } from '../../types/message.js'
import { formatTokens } from '../../utils/format.js'

export type FoldReceipt = {
  trigger: CompactMetadata['trigger']
  before: number | null
  after: { tokens: number; source: 'estimate' } | null
  landing: { tokens: number; source: 'provider' } | null
  rounds: { kept: number; requested: number; reason: string } | null
  operator: { messages: number; bytes: number } | null
  memory: { state: 'committed' | 'pending' | 'failed'; id: string | null; reason: string | null } | null
  prunedBodies: 0 | null
}

const ROUND_REASONS: Readonly<Record<string, string>> = {
  'requested-rounds-fit': 'all requested',
  'available-rounds': 'all there were',
  'request-budget': 'the request budget',
  'no-complete-tail': 'no complete round',
  disabled: 'tail disabled',
}

export function foldReceipt(meta: CompactMetadata, landing?: { input: number } | null): FoldReceipt {
  const typed = meta.ledger !== undefined || meta.recentRounds !== undefined || meta.memory !== undefined
  return {
    trigger: meta.trigger,
    before: typeof meta.preTokens === 'number' && meta.preTokens > 0 ? meta.preTokens : null,
    after: typeof meta.postTokens === 'number' && meta.postTokens >= 0 ? { tokens: meta.postTokens, source: 'estimate' } : null,
    landing: landing && landing.input > 0 ? { tokens: landing.input, source: 'provider' } : null,
    rounds: meta.recentRounds ? { kept: meta.recentRounds.kept, requested: meta.recentRounds.requested, reason: meta.recentRounds.reason } : null,
    operator: meta.ledger ? { messages: meta.ledger.operator.length, bytes: meta.ledger.operator.reduce((n, row) => n + row.bytes, 0) } : null,
    memory: meta.memory
      ? meta.memory.state === 'committed'
        ? { state: 'committed', id: meta.memory.pointer.id, reason: null }
        : { state: meta.memory.state, id: null, reason: meta.memory.reason }
      : null,
    prunedBodies: typed ? 0 : null,
  }
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`

export function foldReceiptWords(receipt: FoldReceipt): string[] {
  const words: string[] = []
  if (receipt.rounds) {
    const { kept, requested, reason } = receipt.rounds
    const why = ROUND_REASONS[reason] ?? reason
    if (kept === 0) words.push(`no recent rounds kept whole (${why})`)
    else if (kept >= requested) words.push(`last ${plural(kept, 'round')} kept whole`)
    else words.push(`last ${kept} of ${requested} rounds kept whole (${why})`)
  }
  if (receipt.operator && receipt.operator.messages > 0) words.push(`${plural(receipt.operator.messages, 'operator message')} kept whole`)
  if (receipt.memory) {
    words.push(receipt.memory.state === 'committed' ? `1 fact moved to memory [${receipt.memory.id}]` : `nothing moved to memory (${receipt.memory.reason})`)
  }
  if (receipt.prunedBodies === 0) words.push('nothing pruned')
  if (receipt.before !== null) {
    const after = receipt.landing ?? receipt.after
    words.push(after === null ? `folded ${formatTokens(receipt.before)} tokens of history` : `${formatTokens(receipt.before)} → ${formatTokens(after.tokens)} tokens (${after.source})`)
  }
  return words
}
