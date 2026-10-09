
import type { CompactMetadata, Message, RenderableMessage, TurnReceiptMessage } from '../../types/message.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { deriveUUID } from '../messages/identity.js'
import { isNotEmptyMessage } from '../messages/text.js'

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

function countHunkLines(hunks: unknown, c: TurnReceiptCounts): void {
  if (!Array.isArray(hunks)) return
  for (const hunk of hunks as Array<{ lines?: unknown }>) {
    if (!Array.isArray(hunk?.lines)) continue
    for (const line of hunk.lines as string[]) {
      if (typeof line !== 'string') continue
      if (line.startsWith('+')) c.adds += 1
      else if (line.startsWith('-')) c.dels += 1
    }
  }
}

export function createdLineCount(content: string): number {
  if (content === '') return 0
  const lines = content.split(/\r\n|\n/)
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length
}

function countFile(path: string, c: TurnReceiptCounts, tempRoot: string): void {
  if (isScratchpadPath(path, tempRoot)) c.scratchpadEdits += 1
  else c.fileEdits += 1
}

type ChangeViewResult = {
  outcome?: unknown
  state?: unknown
  applied?: unknown
  changeView?: { state?: unknown; files?: unknown }
}

function countChangeViewResult(r: ChangeViewResult, c: TurnReceiptCounts, tempRoot: string): boolean {
  const view = r.changeView
  if (!view || !Array.isArray(view.files)) return false
  if (view.state !== 'applied' && view.state !== 'recovered') return true
  const wrote =
    r.outcome === 'succeeded' ||
    r.outcome === 'indeterminate' ||
    (r.outcome === undefined && (r.state === 'applied' || r.applied === true))
  if (!wrote) return true
  for (const file of view.files as Array<{ file?: unknown; hunks?: unknown; added?: unknown; removed?: unknown }>) {
    if (typeof file?.file !== 'string') continue
    countFile(file.file, c, tempRoot)
    if (typeof file.added === 'number' && typeof file.removed === 'number') {
      c.adds += file.added
      c.dels += file.removed
    } else countHunkLines(file.hunks, c)
  }
  return true
}

function countEditResult(m: LooseMessage, c: TurnReceiptCounts, tempRoot: string): void {
  const r = m.toolUseResult as
    | ({ filePath?: unknown; structuredPatch?: unknown; noChange?: unknown; type?: unknown; content?: unknown } & ChangeViewResult)
    | undefined
  if (!r) return
  if (countChangeViewResult(r, c, tempRoot)) return
  if (typeof r.filePath !== 'string' || !Array.isArray(r.structuredPatch)) return
  if (r.noChange !== undefined || r.type === 'no-change') return
  countFile(r.filePath, c, tempRoot)
  if (r.type === 'create' && r.structuredPatch.length === 0 && typeof r.content === 'string') {
    c.adds += createdLineCount(r.content)
    return
  }
  countHunkLines(r.structuredPatch, c)
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
  const pending = new Map<string, NonNullable<CompactMetadata['work']>['receipts'][number]>()
  for (const receipt of compactWorkOf(messages)?.receipts ?? []) {
    pending.set(receipt.beforeUuid, receipt)
    pending.set(deriveUUID(receipt.beforeUuid as Message['uuid'], receipt.blockIndex ?? 0), receipt)
  }
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
      pending.delete(deriveUUID(carry.beforeUuid as Message['uuid'], carry.blockIndex ?? 0))
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
  const keptByUuid = new Map(kept.map(m => [m.uuid, m]))
  const receipts: NonNullable<CompactMetadata['work']>['receipts'] = []
  let start = 0
  walkTurnReceipts(messages, tempRoot, (counts, anchorUuid, end) => {
    const surviving = messages.slice(start, end).flatMap(m => keptByUuid.has(m.uuid) ? [keptByUuid.get(m.uuid)!] : [])
    start = end
    if (surviving.length === 0 && !(kept.length === 0 && end === messages.length)) return
    const retained = emptyCounts()
    for (const m of surviving) countMessage(m, retained, tempRoot)
    const missing = { ...counts }
    for (const key of Object.keys(missing) as Array<keyof TurnReceiptCounts>) missing[key] -= retained[key]
    let target: { beforeUuid: string; blockIndex?: number } | undefined
    for (const m of surviving) {
      if (m.type !== 'assistant' && m.type !== 'user') continue
      if (m.type === 'user' && (m.isMeta || m.isCompactSummary || m.isVisibleInTranscriptOnly)) continue
      const content = m.message.content
      const blockIndex = Array.isArray(content)
        ? content.findIndex(block => isNotEmptyMessage({ ...m, message: { ...m.message, content: [block] } } as Message))
        : isNotEmptyMessage(m) ? 0 : -1
      if (blockIndex < 0) continue
      target = { beforeUuid: m.uuid, ...(blockIndex > 0 ? { blockIndex } : {}) }
      break
    }
    if (target || kept.length === 0) receipts.push({ ...(target ?? { beforeUuid: summaryUuid }), anchorUuid, counts: missing })
  })
  return receipts
}
