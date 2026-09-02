
import type { RenderableMessage, TurnReceiptMessage } from '../../types/message.js'
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
}

function emptyCounts(): TurnReceiptCounts {
  return { scratchpadEdits: 0, fileEdits: 0, adds: 0, dels: 0, reads: 0, searches: 0, commands: 0 }
}

function hasActivity(c: TurnReceiptCounts): boolean {
  return (
    c.scratchpadEdits + c.fileEdits + c.reads + c.searches + c.commands > 0
  )
}

const READ_TOOLS = new Set(['Read', 'NotebookRead'])
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'WebSearch', 'ProviderSearch', 'WebFetch'])
const COMMAND_TOOLS = new Set(['Bash'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])

export function isScratchpadPath(p: string): boolean {
  return /(^|\/)scratchpad(\/|$)/.test(p)
}

type LooseMessage = {
  type?: string
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
  }
}

function countEditResult(m: LooseMessage, c: TurnReceiptCounts): void {
  const r = m.toolUseResult as
    | { filePath?: unknown; structuredPatch?: unknown; noChange?: unknown; type?: unknown }
    | undefined
  if (!r || typeof r.filePath !== 'string' || !Array.isArray(r.structuredPatch)) return
  if (r.noChange !== undefined || r.type === 'no-change') return
  if (isScratchpadPath(r.filePath)) c.scratchpadEdits += 1
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

export function injectTurnReceipts(messages: RenderableMessage[]): RenderableMessage[] {
  if (!isTurnReceiptEnabled()) return messages
  const out: RenderableMessage[] = []
  let counts = emptyCounts()
  let anchorUuid = 'turn-0'
  for (const raw of messages) {
    const m = raw as unknown as LooseMessage
    if (isTurnBoundary(m)) {
      if (hasActivity(counts)) out.push(makeReceipt(counts, anchorUuid) as unknown as RenderableMessage)
      counts = emptyCounts()
      if (typeof m.uuid === 'string') anchorUuid = m.uuid
    }
    out.push(raw)
    if (m.type === 'assistant') countToolUses(m, counts)
    else if (m.type === 'user') countEditResult(m, counts)
    else if (m.type === 'grouped_tool_use') {
      for (const inner of m.messages ?? []) countToolUses(inner, counts)
      for (const res of m.results ?? []) countEditResult(res, counts)
    }
  }
  if (hasActivity(counts)) out.push(makeReceipt(counts, anchorUuid) as unknown as RenderableMessage)
  return out
}
