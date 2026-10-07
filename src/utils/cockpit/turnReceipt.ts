
import type { CompactMetadata, Message, RenderableMessage, TurnReceiptMessage } from '../../types/message.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

export function isTurnReceiptEnabled(): boolean {
  return flagEnv('MERCURY_TURN_RECEIPT') !== '0'
}

export interface TurnReceiptCounts {
  scratchpadEdits: number
  fileEdits: number
  adds: number
  dels: number
  reads: number
  searches: number
  commands: number
  agents: number
  delegatedTokens: number
  delegatedCostUSD: number
  delegatedUnpriced: number
}

function emptyCounts(): TurnReceiptCounts {
  return {
    scratchpadEdits: 0,
    fileEdits: 0,
    adds: 0,
    dels: 0,
    reads: 0,
    searches: 0,
    commands: 0,
    agents: 0,
    delegatedTokens: 0,
    delegatedCostUSD: 0,
    delegatedUnpriced: 0,
  }
}

function hasActivity(c: TurnReceiptCounts): boolean {
  return (
    c.scratchpadEdits + c.fileEdits + c.reads + c.searches + c.commands + c.agents > 0
  )
}

const READ_TOOLS = new Set(['Read', 'NotebookRead'])
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'WebSearch', 'ProviderSearch', 'WebFetch'])
const COMMAND_TOOLS = new Set(['Bash'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])
const DELEGATE_TOOLS = new Set(['Agent'])

export function formatDelegatedTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}

export function formatDelegatedCost(usd: number): string {
  if (usd > 0 && usd < 0.01) return '<$0.01'
  return `$${usd.toFixed(2)}`
}

export function delegatedSpendLine(c: TurnReceiptCounts): string | null {
  if (c.agents === 0 && c.delegatedTokens === 0) return null
  const parts = [`${c.agents} crewmate${c.agents === 1 ? '' : 's'}`]
  if (c.delegatedTokens > 0) parts.push(`${formatDelegatedTokens(c.delegatedTokens)} tokens`)
  if (c.delegatedCostUSD > 0) parts.push(formatDelegatedCost(c.delegatedCostUSD))
  const unpriced = c.delegatedUnpriced > 0 ? ` (${c.delegatedUnpriced} unpriced)` : ''
  return `${parts.join(' · ')}${unpriced}`
}

export function isScratchpadPath(p: string, tempRoot: string): boolean {
  const slashes = (value: string): string => value.replace(/\\/g, '/')
  const root = slashes(tempRoot).replace(/\/+$/, '') + '/'
  const path = slashes(p)
  if (!path.startsWith(root)) return false
  return /\/scratchpad(\/|$)/.test(path.slice(root.length - 1))
}

type LooseMessage = {
  type?: string
  subtype?: string
  compactMetadata?: CompactMetadata
  isMeta?: boolean
  uuid?: string
  message?: { content?: unknown }
  messages?: LooseMessage[]
  results?: LooseMessage[]
  toolUseResult?: unknown
}

function contentBlocks(m: LooseMessage): Array<Record<string, unknown>> {
  const c = m.message?.content
  return Array.isArray(c) ? (c as Array<Record<string, unknown>>) : []
}

function countToolUses(m: LooseMessage, c: TurnReceiptCounts): void {
  for (const block of contentBlocks(m)) {
    if (block['type'] !== 'tool_use') continue
    const name = String(block['name'] ?? '')
    if (READ_TOOLS.has(name)) c.reads += 1
    else if (SEARCH_TOOLS.has(name)) c.searches += 1
    else if (COMMAND_TOOLS.has(name)) c.commands += 1
    else if (DELEGATE_TOOLS.has(name)) c.agents += 1
  }
}

function countDelegatedResult(m: LooseMessage, c: TurnReceiptCounts): void {
  const r = m.toolUseResult as { agentId?: unknown; totalTokens?: unknown; costUSD?: unknown } | undefined
  if (!r || typeof r.agentId !== 'string' || typeof r.totalTokens !== 'number') return
  c.delegatedTokens += r.totalTokens
  if (typeof r.costUSD === 'number') c.delegatedCostUSD += r.costUSD
  else c.delegatedUnpriced += 1
}

function countEditResult(m: LooseMessage, c: TurnReceiptCounts, tempRoot: string): void {
  const r = m.toolUseResult as
    | { filePath?: unknown; structuredPatch?: unknown; noChange?: unknown; type?: unknown }
    | undefined
  if (!r || typeof r.filePath !== 'string' || !Array.isArray(r.structuredPatch)) return
  if (r.noChange !== undefined || r.type === 'no-change') return
  if (isScratchpadPath(r.filePath, tempRoot)) c.scratchpadEdits += 1
  else c.fileEdits += 1
  for (const hunk of r.structuredPatch as Array<{ lines?: unknown }>) {
    if (!Array.isArray(hunk?.lines)) continue
    for (const line of hunk.lines as string[]) {
      if (typeof line !== 'string') continue
      if (line.startsWith('+')) c.adds += 1
      else if (line.startsWith('-')) c.dels += 1
    }
  }
}

export function isTurnBoundary(m: LooseMessage): boolean {
  if (m.type !== 'user' || m.isMeta === true) return false
  const c = m.message?.content
  if (typeof c === 'string') return c.trim() !== ''
  const blocks = contentBlocks(m)
  if (blocks.some(b => b['type'] === 'tool_result')) return false
  return blocks.some(
    b => b['type'] === 'text' && typeof b['text'] === 'string' && (b['text'] as string).trim() !== '',
  )
}

function makeReceipt(counts: TurnReceiptCounts, anchorUuid: string): TurnReceiptMessage {
  return { type: 'turn_receipt', uuid: `${anchorUuid}-turn-receipt`, counts }
}

export function injectTurnReceipts(messages: RenderableMessage[], tempRoot: string): RenderableMessage[] {
  if (!isTurnReceiptEnabled()) return messages
  const out: RenderableMessage[] = []
  let start = 0
  walkTurnReceipts(messages, tempRoot, (counts, anchorUuid, end) => {
    for (let index = start; index < end; index++) out.push(messages[index]!)
    if (hasActivity(counts)) out.push(makeReceipt(counts, anchorUuid))
    start = end
  })
  return out
}

export function compactWorkOf(messages: readonly LooseMessage[]): CompactMetadata['work'] {
  return messages.find(m => m.type === 'system' && m.subtype === 'compact_boundary')?.compactMetadata?.work
}

function countMessage(m: LooseMessage, counts: TurnReceiptCounts, tempRoot: string): void {
  if (m.type === 'assistant') countToolUses(m, counts)
  else if (m.type === 'user') {
    countEditResult(m, counts, tempRoot)
    countDelegatedResult(m, counts)
  } else if (m.type === 'grouped_tool_use') {
    for (const inner of m.messages ?? []) countToolUses(inner, counts)
    for (const res of m.results ?? []) {
      countEditResult(res, counts, tempRoot)
      countDelegatedResult(res, counts)
    }
  }
}

function walkTurnReceipts(
  messages: readonly LooseMessage[],
  tempRoot: string,
  visit: (counts: TurnReceiptCounts, anchorUuid: string, end: number) => void,
): void {
  const pending = new Map((compactWorkOf(messages)?.receipts ?? []).map(receipt => [receipt.beforeUuid, receipt]))
  let counts = emptyCounts()
  let anchorUuid = 'turn-0'
  for (let index = 0; index < messages.length; index++) {
    const m = messages[index]!
    if (isTurnBoundary(m)) {
      visit(counts, anchorUuid, index)
      counts = emptyCounts()
      if (typeof m.uuid === 'string') anchorUuid = m.uuid
    }
    for (const row of [m, ...(m.messages ?? []), ...(m.results ?? [])]) {
      const carry = row.uuid === undefined ? undefined : pending.get(row.uuid)
      if (!carry) continue
      for (const key of Object.keys(counts) as Array<keyof TurnReceiptCounts>) counts[key] += carry.counts[key]
      anchorUuid = carry.anchorUuid
      pending.delete(carry.beforeUuid)
    }
    countMessage(m, counts, tempRoot)
  }
  visit(counts, anchorUuid, messages.length)
}

export function foldedTurnReceipts(
  messages: Message[],
  kept: Message[],
  summaryUuid: string,
  tempRoot: string,
): NonNullable<CompactMetadata['work']>['receipts'] {
  const keptIds = new Set(kept.map(m => m.uuid))
  const receipts: NonNullable<CompactMetadata['work']>['receipts'] = []
  let start = 0
  walkTurnReceipts(messages, tempRoot, (counts, anchorUuid, end) => {
    const surviving = messages.slice(start, end).filter(m => keptIds.has(m.uuid))
    start = end
    if (surviving.length === 0 && !(kept.length === 0 && end === messages.length)) return
    const retained = emptyCounts()
    for (const m of surviving) countMessage(m, retained, tempRoot)
    const missing = { ...counts }
    for (const key of Object.keys(missing) as Array<keyof TurnReceiptCounts>) missing[key] -= retained[key]
    receipts.push({ beforeUuid: surviving[0]?.uuid ?? summaryUuid, anchorUuid, counts: missing })
  })
  return receipts
}
