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
export const LANDING_ROOM_FLOOR_TOKENS = 20_000
export const LANDING_ROOM_MAX_SHARE = 2
export const FOLDED_RESULT_KEY = '[result folded into the summary above'

export function isMercuryCompactKeepTailEnabled(): boolean {
  const flag = flagEnv('MERCURY_COMPACT_KEEP_TAIL')
  if (flag === '0' || flag?.toLowerCase() === 'false') return false
  return isEnvTruthy(flag) || isEnvTruthy(flagEnv('MERCURY_CTX_COMPACTION')) || isMercurySubstrateProfileOn()
}

type VerbatimTailResult = {
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

function closedTail(messages: readonly Message[]): boolean {
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
  opts?: { keepRounds?: number; tailTokenBudget?: number; fits?: (keep: Message[]) => boolean; minRounds?: number },
): VerbatimTailResult | null {
  const requested = Math.max(1, opts?.keepRounds ?? DEFAULT_KEEP_ROUNDS)
  const budget = Math.max(0, opts?.tailTokenBudget ?? DEFAULT_TAIL_TOKEN_BUDGET)
  const groups = groupMessagesByApiRound(messages)
  const available = Math.min(requested, groups.length - MIN_HEAD_ROUNDS)
  if (available <= 0) return null
  const floor = Math.max(1, Math.min(available, opts?.minRounds ?? 1))
  for (let n = available; n >= floor; n--) {
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

export function foldLandingCeiling(threshold: number, messages: readonly Message[], ratio = 1, residuals: readonly number[] = []): number {
  let largest = 0
  for (const group of groupMessagesByApiRound(messages as Message[])) {
    largest = Math.max(largest, roughTokenCountEstimationForMessages(group.filter(preservable)))
  }
  const scale = Number.isFinite(ratio) && ratio > 0 ? ratio : 1
  const uncertainty = Math.max(0, ...residuals.filter(Number.isFinite))
  const room = Math.min(Math.max(Math.ceil(largest * scale + uncertainty), LANDING_ROOM_FLOOR_TOKENS), Math.floor(threshold / LANDING_ROOM_MAX_SHARE))
  return Math.max(1, threshold - room)
}

type FoldableResult = { toolUseId: string; name: string; file: string | null; bytes: number }

export function foldedResultPlaceholder(result: FoldableResult): string {
  const where = result.file === null ? result.name : `${result.name} ${result.file}`
  return `${FOLDED_RESULT_KEY}: ${result.bytes.toLocaleString('en-US')} bytes from ${where}; the summary carries what it said — run the tool again for the content]`
}

export function foldableResults(keep: readonly Message[]): FoldableResult[] {
  const calls = new Map<string, { name: string; file: string | null }>()
  for (const row of keep) {
    if (row.type !== 'assistant' || !Array.isArray(row.message.content)) continue
    for (const block of row.message.content) {
      if (block.type !== 'tool_use') continue
      const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>
      calls.set(block.id, { name: block.name, file: typeof input.file_path === 'string' ? input.file_path : null })
    }
  }
  const out: FoldableResult[] = []
  for (const row of keep) {
    if (row.type !== 'user' || !Array.isArray(row.message.content)) continue
    for (const block of row.message.content) {
      if (block.type !== 'tool_result') continue
      const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '')
      if (text.startsWith(FOLDED_RESULT_KEY)) continue
      const call = calls.get(block.tool_use_id)
      if (call === undefined) continue
      out.push({ toolUseId: block.tool_use_id, name: call.name, file: call.file, bytes: Buffer.byteLength(text) })
    }
  }
  return out.sort((a, b) => b.bytes - a.bytes)
}

export function withFoldedResults(keep: readonly Message[], replacements: ReadonlyMap<string, string>): Message[] {
  if (replacements.size === 0) return [...keep]
  return keep.map(row => {
    if (row.type !== 'user' || !Array.isArray(row.message.content)) return row
    if (!row.message.content.some(block => block.type === 'tool_result' && replacements.has(block.tool_use_id))) return row
    return {
      ...row,
      message: {
        ...row.message,
        content: row.message.content.map(block =>
          block.type === 'tool_result' && replacements.has(block.tool_use_id) ? { ...block, content: replacements.get(block.tool_use_id)! } : block,
        ),
      },
    } as Message
  })
}
