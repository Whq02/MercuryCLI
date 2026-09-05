import type { CompactProgressEvent } from '../../Tool.js'
import { COMPACT_MAX_OUTPUT_TOKENS } from '../../utils/context.js'
import { formatDuration, formatTokens } from '../../utils/format.js'

export type FoldStage = 'session-memory' | 'micro-compaction' | 'summarising' | 'restoring'
export const FOLD_STAGE_ORDER: readonly FoldStage[] = ['session-memory', 'micro-compaction', 'summarising', 'restoring']
export type FoldTrigger = 'manual' | 'auto'
export type FoldExit = 'landed' | 'cancelled' | 'failed'

export interface FoldStatusV1 {
  schema: 1
  trigger: FoldTrigger
  startedAtMs: number
  stages: FoldStage[]
  stage: FoldStage | null
  fill: number | null
  summaryTokens: number
  summaryCapTokens: number
  attempt: number
  exit?: FoldExit
  endedAtMs?: number
}

export const FOLD_ROW_HEAD = 'compacting context'
export const FOLD_STAGE_WORDS: Readonly<Record<FoldStage, string>> = {
  'session-memory': 'session memory',
  'micro-compaction': 'micro-compaction',
  summarising: 'summarising',
  restoring: 'restoring',
}
export const FOLD_EXIT_WORDS: Readonly<Record<FoldExit, string>> = {
  landed: 'compacted',
  cancelled: 'cancelled',
  failed: 'failed',
}
export const FOLD_BAR_CELLS_PER_STAGE = 3
export const FOLD_EXIT_LINGER_MS = 1500
export const FOLD_STAMP_THROTTLE_MS = 250

export function beginFoldStatus(facts: {
  trigger: FoldTrigger
  startedAtMs: number
  sessionMemory: boolean
  microcompaction: boolean
}): FoldStatusV1 {
  const stages: FoldStage[] = []
  if (facts.sessionMemory) stages.push('session-memory')
  if (facts.microcompaction) stages.push('micro-compaction')
  stages.push('summarising', 'restoring')
  return {
    schema: 1,
    trigger: facts.trigger,
    startedAtMs: facts.startedAtMs,
    stages,
    stage: null,
    fill: null,
    summaryTokens: 0,
    summaryCapTokens: COMPACT_MAX_OUTPUT_TOKENS,
    attempt: 1,
  }
}

function advanceStage(status: FoldStatusV1, stage: FoldStage): FoldStatusV1 {
  const next = status.stages.indexOf(stage)
  if (next === -1) return status
  const current = status.stage === null ? -1 : status.stages.indexOf(status.stage)
  if (next <= current) return status
  return { ...status, stage, fill: null }
}

export function foldStatusOnEvent(status: FoldStatusV1, event: CompactProgressEvent): FoldStatusV1 {
  if (status.exit !== undefined) return status
  switch (event.type) {
    case 'stage':
      return advanceStage(status, event.stage)
    case 'compact_start':
      return advanceStage(status, 'summarising')
    case 'summary_progress': {
      const summarisingAt = status.stages.indexOf('summarising')
      const currentAt = status.stage === null ? -1 : status.stages.indexOf(status.stage)
      if (currentAt > summarisingAt) return status
      const tokens = Math.max(0, Math.floor(event.chars / 4))
      const measured = status.summaryCapTokens > 0 ? Math.min(1, tokens / status.summaryCapTokens) : 0
      const fill = Math.max(status.fill ?? 0, measured)
      const advanced = advanceStage(status, 'summarising')
      return { ...advanced, fill, summaryTokens: tokens }
    }
    case 'retry':
      return { ...status, attempt: Math.max(status.attempt, event.attempt) }
    case 'hooks_start':
      return event.hookType === 'pre_compact' ? status : advanceStage(status, 'restoring')
    case 'compact_end':
      return status
    default:
      return status
  }
}

export function foldStatusExit(status: FoldStatusV1, exit: FoldExit, endedAtMs: number): FoldStatusV1 {
  return { ...status, exit, endedAtMs }
}

const STAGE_WORDS = new Set<string>(FOLD_STAGE_ORDER)
const EXIT_WORDS = new Set<string>(['landed', 'cancelled', 'failed'])
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

export function decodeFoldStatus(raw: unknown): FoldStatusV1 | null {
  if (raw === null || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (r.schema !== 1) return null
  if (r.trigger !== 'manual' && r.trigger !== 'auto') return null
  if (!finite(r.startedAtMs)) return null
  if (!Array.isArray(r.stages) || r.stages.length === 0 || !r.stages.every(s => typeof s === 'string' && STAGE_WORDS.has(s))) return null
  const stages = r.stages as FoldStage[]
  if (r.stage !== null && !(typeof r.stage === 'string' && stages.includes(r.stage as FoldStage))) return null
  if (r.fill !== null && !finite(r.fill)) return null
  if (!finite(r.summaryTokens) || !finite(r.summaryCapTokens) || !finite(r.attempt)) return null
  if (r.exit !== undefined && !(typeof r.exit === 'string' && EXIT_WORDS.has(r.exit))) return null
  if (r.endedAtMs !== undefined && !finite(r.endedAtMs)) return null
  return {
    schema: 1,
    trigger: r.trigger,
    startedAtMs: r.startedAtMs,
    stages: [...stages],
    stage: (r.stage as FoldStage | null) ?? null,
    fill: r.fill === null ? null : Math.min(1, Math.max(0, r.fill as number)),
    summaryTokens: Math.max(0, Math.floor(r.summaryTokens)),
    summaryCapTokens: Math.max(0, Math.floor(r.summaryCapTokens)),
    attempt: Math.max(1, Math.floor(r.attempt)),
    ...(r.exit !== undefined ? { exit: r.exit as FoldExit } : {}),
    ...(r.endedAtMs !== undefined ? { endedAtMs: r.endedAtMs as number } : {}),
  }
}

export type FoldBarCell = 'done' | 'fill' | 'pulse' | 'empty'
export function foldBarCells(status: FoldStatusV1): FoldBarCell[] {
  const per = FOLD_BAR_CELLS_PER_STAGE
  const cells: FoldBarCell[] = []
  const push = (kind: FoldBarCell, count: number): void => {
    for (let i = 0; i < count; i++) cells.push(kind)
  }
  if (status.exit === 'landed') {
    push('done', status.stages.length * per)
    return cells
  }
  const live = status.exit === undefined
  const current = status.stage === null ? -1 : status.stages.indexOf(status.stage)
  status.stages.forEach((_, index) => {
    if (index < current) {
      push('done', per)
      return
    }
    if (index > current) {
      if (live && current === -1 && index === 0) {
        push('pulse', 1)
        push('empty', per - 1)
      } else {
        push('empty', per)
      }
      return
    }
    const filled = status.fill === null ? 0 : Math.min(per, Math.round(status.fill * per))
    if (filled === 0) {
      push(live ? 'pulse' : 'empty', 1)
      push('empty', per - 1)
      return
    }
    push('fill', filled)
    push('empty', per - filled)
  })
  return cells
}

export function foldBarText(cells: readonly FoldBarCell[]): string {
  return cells.map(cell => (cell === 'empty' ? '░' : cell === 'pulse' ? '◐' : '█')).join('')
}

export function foldElapsedMs(status: FoldStatusV1, nowMs: number): number {
  const end = status.endedAtMs ?? nowMs
  return Math.max(0, end - status.startedAtMs)
}

export function foldRowWords(status: FoldStatusV1, nowMs: number): { head: string; stage: string | null; tokens: string | null; bar: string; elapsed: string; line: string } {
  const head = status.trigger === 'auto' ? `${FOLD_ROW_HEAD} (auto)` : FOLD_ROW_HEAD
  const stage =
    status.exit !== undefined
      ? FOLD_EXIT_WORDS[status.exit]
      : status.stage === null
        ? null
        : `${FOLD_STAGE_WORDS[status.stage]}${status.attempt > 1 ? ` · retry ${status.attempt}` : ''}`
  const tokens = status.exit === undefined && status.stage === 'summarising' && status.summaryTokens > 0 ? `↓ ${formatTokens(status.summaryTokens)} tokens` : null
  const bar = foldBarText(foldBarCells(status))
  const elapsed = formatDuration(foldElapsedMs(status, nowMs), { mostSignificantOnly: true })
  const line = [head, stage, tokens, bar, elapsed].filter((part): part is string => part !== null).join(' · ')
  return { head, stage, tokens, bar, elapsed, line }
}

export function foldRowVisible(
  status: FoldStatusV1 | null,
  facts: { sentHere: boolean; sendUnlanded: boolean; nowMs: number },
): boolean {
  if (status === null) return false
  if (status.exit === undefined) {
    return !(status.trigger === 'manual' && facts.sentHere && !facts.sendUnlanded)
  }
  return facts.sendUnlanded && facts.nowMs - (status.endedAtMs ?? status.startedAtMs) < FOLD_EXIT_LINGER_MS
}

export const FOLD_COMMAND_SEND = /^\/compact(\s|$)/
