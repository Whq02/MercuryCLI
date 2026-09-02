// ============================================================================
//  turnReceipt — the per-turn work-receipt row (MERCURY_TURN_RECEIPT, fork
//  default-ON): after each completed turn that used tools, one dim rollup line
//  summarizes what the turn DID — `∙ 3 scratchpad edits +125 −19 · 2 files
//  read · 5 shell commands` — the at-a-glance receipt the raw tool cards and
//  collapse groups don't give.
//
//  PURE derive over the renderable-message stream (no I/O, no React): counts
//  come from two sources — assistant `tool_use` blocks (reads / searches /
//  commands, plus grouped_tool_use rows) and user tool-result rows whose
//  persisted `toolUseResult` carries `{ filePath, structuredPatch }` (edit
//  counts + line adds/dels; Write and Edit both produce that shape). Edits
//  under a `/scratchpad` path segment count as SCRATCHPAD edits, everything
//  else as file edits. A receipt row is injected BEFORE each visible user
//  prompt (the turn boundary) and at end-of-list; a turn with zero tool
//  activity injects nothing. OFF (`=0`) ⇒ the injector returns its input
//  array UNTOUCHED — byte-identical.
// ============================================================================

import type { RenderableMessage, TurnReceiptMessage } from '../../types/message.js'
import { flagEnv } from '../../substrate/flagRegistry.js'

/** Live env read (never latched) — the /authority feature-toggle lesson. */
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

// Plain string names, not tool-module imports: the prompt.ts constant graphs
// are heavy under bun-run (the proof drives this module directly) and the
// names are frozen public tool ids.
const READ_TOOLS = new Set(['Read', 'NotebookRead'])
const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'WebSearch', 'ProviderSearch', 'WebFetch'])
const COMMAND_TOOLS = new Set(['Bash'])
const EDIT_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])

/** Is this path a session-scratchpad file? (the `/scratchpad` dir segment) */
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

/** Count one assistant row's tool_use blocks into the accumulator. */
function countToolUses(m: LooseMessage, c: TurnReceiptCounts): void {
  for (const block of contentBlocks(m)) {
    if (block['type'] !== 'tool_use') continue
    const name = String(block['name'] ?? '')
    if (READ_TOOLS.has(name)) c.reads += 1
    else if (SEARCH_TOOLS.has(name)) c.searches += 1
    else if (COMMAND_TOOLS.has(name)) c.commands += 1
    // Edits are counted from their RESULT rows (which carry the diff stats
    // and the resolved filePath) — never here, or they'd double-count.
  }
}

/** Fold one user row's persisted toolUseResult (edit stats) into the accumulator. */
function countEditResult(m: LooseMessage, c: TurnReceiptCounts): void {
  const r = m.toolUseResult as
    | { filePath?: unknown; structuredPatch?: unknown; noChange?: unknown; type?: unknown }
    | undefined
  if (!r || typeof r.filePath !== 'string' || !Array.isArray(r.structuredPatch)) return
  // a truthful no-change result edited nothing — never a file
  // edit in the receipt.
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

/** A visible user PROMPT row = the turn boundary (tool-result rows are not).
 *  Exported: the render engine's cockpit ledger freezes settled rows by the
 *  same boundary. */
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

/**
 * Inject a receipt row before each completed turn's boundary (and at the end
 * of the list for the current/last turn). Runs on the post-grouping stream —
 * grouped_tool_use rows contribute their inner messages + results. Disabled ⇒
 * returns the INPUT ARRAY IDENTITY (byte-identical render path).
 */
export function injectTurnReceipts(messages: RenderableMessage[]): RenderableMessage[] {
  if (!isTurnReceiptEnabled()) return messages
  const out: RenderableMessage[] = []
  let counts = emptyCounts()
  // STABLE IDENTITY: a turn's receipt anchors to the uuid of the prompt that
  // OPENED the turn (its boundary), never the latest appended message — the
  // old lastUuid anchor re-keyed the live tail receipt on every append,
  // remounting the row once per message. The anchor is fixed for the whole
  // turn, so the receipt keeps ONE React identity while the turn streams and
  // after it completes (same key, same vertical slot).
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
