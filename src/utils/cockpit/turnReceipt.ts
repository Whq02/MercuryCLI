
import type { CompactMetadata, Message, RenderableMessage, TurnReceiptMessage } from '../../types/message.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { deriveUUID } from '../messages/identity.js'
import { NO_RESPONSE_REQUESTED } from '../messages/rejectionText.js'
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
  fetches: number
  commands: number
  browser: number
  agents: number
  delegatedTokens: number
  delegatedCostUSD: number
  delegatedUnpriced: number
  tools: Record<string, number>
}

function emptyCounts(): TurnReceiptCounts {
  return {
    scratchpadEdits: 0,
    fileEdits: 0,
    adds: 0,
    dels: 0,
    reads: 0,
    searches: 0,
    fetches: 0,
    commands: 0,
    browser: 0,
    agents: 0,
    delegatedTokens: 0,
    delegatedCostUSD: 0,
    delegatedUnpriced: 0,
    tools: {},
  }
}

function otherToolCalls(tools: Record<string, number> | undefined): number {
  let total = 0
  for (const n of Object.values(tools ?? {})) if (n > 0) total += n
  return total
}

export function hasActivity(c: TurnReceiptCounts): boolean {
  return (
    c.scratchpadEdits + c.fileEdits + c.reads + c.searches + c.fetches + c.commands + c.browser + c.agents + otherToolCalls(c.tools) > 0
  )
}

export const NO_TOOLS_RAN_WORDS = 'no tools ran this turn'
const OTHER_TOOLS_NAMED = 6

export function otherToolsLine(c: TurnReceiptCounts): string | null {
  const named = Object.entries(c.tools ?? {}).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  if (named.length === 0) return null
  const shown = named.slice(0, OTHER_TOOLS_NAMED).map(([name, n]) => `${name} ×${n}`)
  const rest = named.length - shown.length
  return rest > 0 ? `${shown.join(' · ')} · +${rest} more tools` : shown.join(' · ')
}

function isReplyRow(m: LooseMessage): boolean {
  if (m.type !== 'assistant' || m.isApiErrorMessage === true) return false
  return contentBlocks(m).some(b => b['type'] === 'text' && typeof b['text'] === 'string' && (b['text'] as string).trim() !== '' && (b['text'] as string).trim() !== NO_RESPONSE_REQUESTED)
}

const READ_TOOLS = new Set(['Read', 'NotebookRead'])
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'WebSearch', 'ProviderSearch'])
const FETCH_TOOLS = new Set(['WebFetch'])
const COMMAND_TOOLS = new Set(['Bash'])
const BROWSER_TOOLS = new Set(['Browser'])
const DELEGATE_TOOLS = new Set(['Crewmate'])

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
  isApiErrorMessage?: boolean
  uuid?: string
  message?: { content?: unknown; usage?: unknown }
  messages?: LooseMessage[]
  results?: LooseMessage[]
  toolUseResult?: unknown
}

export function promptTokensOf(usage: unknown): number | undefined {
  const u = usage as { input_tokens?: unknown; cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown } | null | undefined
  if (!u || typeof u.input_tokens !== 'number') return undefined
  const read = typeof u.cache_read_input_tokens === 'number' ? u.cache_read_input_tokens : 0
  const written = typeof u.cache_creation_input_tokens === 'number' ? u.cache_creation_input_tokens : 0
  return u.input_tokens + read + written
}

export function formatContextDelta(delta: number): string {
  return `ctx ${delta < 0 ? '−' : '+'}${formatDelegatedTokens(Math.abs(delta))}`
}

function contentBlocks(m: LooseMessage): Array<Record<string, unknown>> {
  const c = m.message?.content
  return Array.isArray(c) ? (c as Array<Record<string, unknown>>) : []
}

interface Tally {
  counts: TurnReceiptCounts
  pending: Map<string, string>
}

function emptyTally(): Tally {
  return { counts: emptyCounts(), pending: new Map() }
}

function settleTally(t: Tally): TurnReceiptCounts {
  for (const name of t.pending.values()) t.counts.tools[name] = (t.counts.tools[name] ?? 0) + 1
  t.pending.clear()
  return t.counts
}

function countToolUses(m: LooseMessage, t: Tally): void {
  const c = t.counts
  for (const block of contentBlocks(m)) {
    if (block['type'] !== 'tool_use') continue
    const name = String(block['name'] ?? '')
    if (READ_TOOLS.has(name)) c.reads += 1
    else if (SEARCH_TOOLS.has(name)) c.searches += 1
    else if (FETCH_TOOLS.has(name)) c.fetches += 1
    else if (COMMAND_TOOLS.has(name)) c.commands += 1
    else if (BROWSER_TOOLS.has(name)) c.browser += 1
    else if (DELEGATE_TOOLS.has(name)) c.agents += 1
    else if (typeof block['id'] === 'string' && !t.pending.has(block['id'])) t.pending.set(block['id'], name)
    else c.tools[name] = (c.tools[name] ?? 0) + 1
  }
}

function resultToolUseId(m: LooseMessage): string | undefined {
  const id = contentBlocks(m).find(b => b['type'] === 'tool_result')?.['tool_use_id']
  return typeof id === 'string' ? id : undefined
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

function countEditResult(m: LooseMessage, c: TurnReceiptCounts, tempRoot: string): boolean {
  const before = c.fileEdits + c.scratchpadEdits
  const r = m.toolUseResult as
    | ({ filePath?: unknown; structuredPatch?: unknown; noChange?: unknown; type?: unknown; content?: unknown } & ChangeViewResult)
    | undefined
  if (!r) return false
  if (countChangeViewResult(r, c, tempRoot)) return c.fileEdits + c.scratchpadEdits > before
  if (typeof r.filePath !== 'string' || !Array.isArray(r.structuredPatch)) return false
  if (r.noChange !== undefined || r.type === 'no-change') return false
  countFile(r.filePath, c, tempRoot)
  if (r.type === 'create' && r.structuredPatch.length === 0 && typeof r.content === 'string') {
    c.adds += createdLineCount(r.content)
    return true
  }
  countHunkLines(r.structuredPatch, c)
  return true
}

function countResult(m: LooseMessage, t: Tally, tempRoot: string): void {
  const wrote = countEditResult(m, t.counts, tempRoot)
  countDelegatedResult(m, t.counts)
  const id = resultToolUseId(m)
  if (wrote && id !== undefined) t.pending.delete(id)
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

function makeReceipt(counts: TurnReceiptCounts, anchorUuid: string, contextDelta?: number): TurnReceiptMessage {
  const tools: Record<string, number> = {}
  for (const [name, n] of Object.entries(counts.tools ?? {}).sort((a, b) => a[0].localeCompare(b[0]))) if (n > 0) tools[name] = n
  return { type: 'turn_receipt', uuid: `${anchorUuid}-turn-receipt`, counts: { ...counts, tools }, ...(contextDelta !== undefined ? { contextDelta } : {}) }
}

function addCounts(target: TurnReceiptCounts, source: Partial<TurnReceiptCounts> | undefined, sign: 1 | -1): void {
  if (!source) return
  for (const key of Object.keys(target) as Array<keyof TurnReceiptCounts>) {
    if (key === 'tools') continue
    target[key] += sign * (typeof source[key] === 'number' ? source[key] : 0)
  }
  for (const [name, n] of Object.entries(source.tools ?? {})) target.tools[name] = (target.tools[name] ?? 0) + sign * n
}

export function injectTurnReceipts(messages: RenderableMessage[], tempRoot: string): RenderableMessage[] {
  if (!isTurnReceiptEnabled()) return messages
  const out: RenderableMessage[] = []
  let start = 0
  walkTurnReceipts(messages, tempRoot, (counts, anchorUuid, end, replied, contextDelta) => {
    for (let index = start; index < end; index++) out.push(messages[index]!)
    if (hasActivity(counts) || (replied && anchorUuid !== 'turn-0')) out.push(makeReceipt(counts, anchorUuid, contextDelta))
    start = end
  })
  return out
}

export function compactWorkOf(messages: readonly LooseMessage[]): CompactMetadata['work'] {
  return messages.find(m => m.type === 'system' && m.subtype === 'compact_boundary')?.compactMetadata?.work
}

function countMessage(m: LooseMessage, t: Tally, tempRoot: string): void {
  if (m.type === 'assistant') countToolUses(m, t)
  else if (m.type === 'user') countResult(m, t, tempRoot)
  else if (m.type === 'grouped_tool_use') {
    for (const inner of m.messages ?? []) countToolUses(inner, t)
    for (const res of m.results ?? []) countResult(res, t, tempRoot)
  }
}

function walkTurnReceipts(
  messages: readonly LooseMessage[],
  tempRoot: string,
  visit: (counts: TurnReceiptCounts, anchorUuid: string, end: number, replied: boolean, contextDelta: number | undefined) => void,
): void {
  const pending = new Map<string, NonNullable<CompactMetadata['work']>['receipts'][number]>()
  for (const receipt of compactWorkOf(messages)?.receipts ?? []) {
    pending.set(receipt.beforeUuid, receipt)
    pending.set(deriveUUID(receipt.beforeUuid as Message['uuid'], receipt.blockIndex ?? 0), receipt)
  }
  let tally = emptyTally()
  let anchorUuid = 'turn-0'
  let replied = false
  let previousPrompt: number | undefined
  let turnPrompt: number | undefined
  let preFoldTail: string | undefined
  const settleDelta = (): number | undefined => {
    if (turnPrompt === undefined) return undefined
    const delta = turnPrompt - (previousPrompt ?? 0)
    previousPrompt = turnPrompt
    turnPrompt = undefined
    return delta
  }
  for (let index = 0; index < messages.length; index++) {
    const m = messages[index]!
    if (isTurnBoundary(m)) {
      visit(settleTally(tally), anchorUuid, index, replied, settleDelta())
      tally = emptyTally()
      replied = false
      if (typeof m.uuid === 'string') anchorUuid = m.uuid
    }
    if (m.type === 'system' && m.subtype === 'compact_boundary') {
      previousPrompt = m.compactMetadata?.postTokens
      turnPrompt = undefined
      preFoldTail = m.compactMetadata?.preservedSegment?.tailUuid
    }
    if (preFoldTail === undefined) {
      for (const row of [m, ...(m.messages ?? [])]) {
        const prompt = row.type === 'assistant' ? promptTokensOf(row.message?.usage) : undefined
        if (prompt !== undefined) turnPrompt = prompt
      }
    } else if ([m, ...(m.messages ?? []), ...(m.results ?? [])].some(row => row.uuid === preFoldTail)) {
      preFoldTail = undefined
    }
    if (isReplyRow(m)) replied = true
    for (const row of [m, ...(m.messages ?? []), ...(m.results ?? [])]) {
      const carry = row.uuid === undefined ? undefined : pending.get(row.uuid)
      if (!carry) continue
      addCounts(tally.counts, carry.counts, 1)
      anchorUuid = carry.anchorUuid
      pending.delete(carry.beforeUuid)
      pending.delete(deriveUUID(carry.beforeUuid as Message['uuid'], carry.blockIndex ?? 0))
    }
    countMessage(m, tally, tempRoot)
  }
  visit(settleTally(tally), anchorUuid, messages.length, replied, settleDelta())
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
    const retained = emptyTally()
    for (const m of surviving) countMessage(m, retained, tempRoot)
    const missing = { ...counts, tools: { ...counts.tools } }
    addCounts(missing, settleTally(retained), -1)
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
