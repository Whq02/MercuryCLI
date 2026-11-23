import { createHash } from 'node:crypto'
import type { Message } from '../message-shapes/message.js'
import { operatorTextOf, steerTextOf } from '../compaction-window/operatorMessages.js'
import { getRunSnapshot } from '../run/runCoordinator.js'
import type { OwnerKey } from '../run-owner/ownerKey.js'
import { parseAnchor } from '../../tools/engines/change-transaction/snapshotAnchor.js'

type LedgerRows = {
  epoch: number
  sourceRecordIds: string[]
  priorRecords: number
  sourceDigest: string
  operator: Array<{ sourceId: string; epoch: number; bytes: number; sha256: string }>
  tools: Array<{ id: string; sourceId: string; epoch: number; name: string; argumentDigest: string; command?: string; file?: string; resultId: string | null; resultBytes: number; outcome: 'pending' | 'background' | 'ok' | 'error'; rc: number | null }>
  files: Array<{ sourceId: string; epoch: number; file: string; anchor: string; startLine: number | null; lines: number | null; freshness: 'observed-not-rechecked' }>
  run: { objective: string; deliverables: Array<{ id: string; title: string; state: string }>; nextAction: string; blocker: unknown; verification: unknown; pendingTools: unknown[] } | null
}

type LedgerTotals = {
  records: number
  operator: { messages: number; bytes: number }
  tools: number
  files: number
  deniedFilePaths: number
}

type StretchLedger = LedgerRows & {
  version: 2
  totals: LedgerTotals
  keptRecordIds: string[]
  keptSteerIds?: string[]
  carriedTools: LedgerRows['tools']
}

export type FoldLedger = (LedgerRows & { version: 1 }) | StretchLedger

function totalsThrough(ledger?: FoldLedger): LedgerTotals {
  if (ledger?.version === 2) return ledger.totals
  return {
    records: ledger?.sourceRecordIds.length ?? 0,
    operator: { messages: ledger?.operator.length ?? 0, bytes: ledger?.operator.reduce((n, row) => n + row.bytes, 0) ?? 0 },
    tools: ledger?.tools.length ?? 0, files: ledger?.files.length ?? 0,
    deniedFilePaths: ledger?.tools.filter(tool => tool.outcome === 'error' && tool.file).length ?? 0,
  }
}

export function withKeptLedgerRows(ledger: StretchLedger, kept: readonly Message[] | undefined): StretchLedger {
  const keptSteerIds = kept?.flatMap(row => row.type === 'attachment' && row.attachment.type === 'queued_command' && row.attachment.source_uuid && steerTextOf(row.attachment) !== null ? [row.attachment.source_uuid] : [])
  return { ...ledger, keptRecordIds: kept?.map(row => row.uuid) ?? [], ...(keptSteerIds?.length ? { keptSteerIds } : {}) }
}

export const foldContentWitness = (text: string): string => createHash('sha256').update(text).digest('hex')

export function buildFoldLedger(messages: readonly Message[], owner: OwnerKey, epoch: number): StretchLedger {
  const previous = messages.findLast(row => row.type === 'system' && row.subtype === 'compact_boundary' && row.compactMetadata.ledger)
  const prior = previous?.type === 'system' && previous.subtype === 'compact_boundary' ? previous.compactMetadata.ledger : undefined
  const earlier = totalsThrough(prior)
  const seen = new Set<string>(prior?.version === 2 ? prior.keptRecordIds : [])
  const earlierOperatorIds = new Set<string>(seen)
  if (prior?.version === 1) {
    const candidates = new Set<string>(messages.map(row => row.uuid))
    for (const id of prior.sourceRecordIds) if (candidates.has(id)) seen.add(id)
    for (const row of prior.operator) earlierOperatorIds.add(row.sourceId)
  } else {
    for (const id of prior?.keptSteerIds ?? []) earlierOperatorIds.add(id)
  }
  const sourceRecordIds: string[] = []
  const operator = new Map<string, LedgerRows['operator'][number]>()
  const tools = new Map<string, LedgerRows['tools'][number]>()
  const carried = new Map<string, LedgerRows['tools'][number]>()
  for (const entries of [prior?.tools ?? [], prior?.version === 2 ? prior.carriedTools : []]) {
    for (const tool of entries) {
      if (tool.outcome === 'pending' || tool.outcome === 'background') carried.set(tool.id, { ...tool })
    }
  }
  const files = new Map<string, LedgerRows['files'][number]>()
  for (const row of messages) {
    if (seen.has(row.uuid)) continue
    seen.add(row.uuid)
    sourceRecordIds.push(row.uuid)
    const text = row.type === 'attachment' ? steerTextOf(row.attachment) : operatorTextOf(row)
    if (text !== null) {
      const sourceId = row.type === 'attachment' && row.attachment.type === 'queued_command' ? row.attachment.source_uuid ?? row.uuid : row.uuid
      if (!earlierOperatorIds.has(sourceId) && !operator.has(sourceId)) operator.set(sourceId, { sourceId, epoch, bytes: Buffer.byteLength(text), sha256: foldContentWitness(text) })
    }
    if (row.type === 'assistant' && Array.isArray(row.message.content)) {
      for (const block of row.message.content) {
        if (block.type !== 'tool_use') continue
        if (tools.has(block.id) || carried.has(block.id)) continue
        const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>
        tools.set(block.id, { id: block.id, sourceId: row.uuid, epoch, name: block.name, argumentDigest: foldContentWitness(JSON.stringify(input)),
          ...(block.name === 'Bash' && typeof input.command === 'string' ? { command: input.command } : {}),
          ...(typeof input.file_path === 'string' ? { file: input.file_path } : {}),
          resultId: null, resultBytes: 0, outcome: 'pending', rc: null,
        })
      }
    }
    if (row.type !== 'user' || !Array.isArray(row.message.content)) continue
    const results = row.message.content.filter(block => block.type === 'tool_result')
    const data = results.length === 1 && row.toolUseResult && typeof row.toolUseResult === 'object' ? row.toolUseResult as Record<string, unknown> : {}
    for (const result of results) {
      const tool = tools.get(result.tool_use_id) ?? carried.get(result.tool_use_id)
      if (!tool) continue
      tool.resultId = row.uuid
      tool.resultBytes = Buffer.byteLength(typeof result.content === 'string' ? result.content : JSON.stringify(result.content ?? []))
      tool.outcome = result.is_error ? 'error' : typeof data.backgroundTaskId === 'string' ? 'background' : 'ok'
      tool.rc = tool.name === 'Bash' && typeof data.code === 'number' && Number.isInteger(data.code) ? data.code : tool.rc
      const file = data.file as Record<string, unknown> | undefined
      if (tool.name === 'Read' && file && typeof file.anchor === 'string' && parseAnchor(file.anchor) && typeof file.filePath === 'string') {
        files.set(row.uuid, { sourceId: row.uuid, epoch, file: file.filePath, anchor: file.anchor,
          startLine: typeof file.startLine === 'number' ? file.startLine : null,
          lines: typeof file.numLines === 'number' ? file.numLines : null,
          freshness: 'observed-not-rechecked',
        })
      }
    }
  }
  const snap = getRunSnapshot(owner)
  const asks = [...operator.values()]
  const calls = [...tools.values()]
  const carriedTools = [...carried.values()]
  const denied = (rows: LedgerRows['tools']) => rows.filter(tool => tool.outcome === 'error' && tool.file).length
  return {
    version: 2, epoch, sourceRecordIds, priorRecords: earlier.records, sourceDigest: foldContentWitness(JSON.stringify({ previous: prior?.sourceDigest, rows: messages.map(row => ({ id: row.uuid, body: row.type === 'assistant' || row.type === 'user' ? row.message.content : row.type === 'attachment' ? row.attachment : null })) })),
    operator: asks, tools: calls, files: [...files.values()], carriedTools, keptRecordIds: [],
    totals: {
      records: earlier.records + sourceRecordIds.length,
      operator: { messages: earlier.operator.messages + asks.length, bytes: asks.reduce((n, row) => n + row.bytes, earlier.operator.bytes) },
      tools: earlier.tools + calls.length, files: earlier.files + files.size,
      deniedFilePaths: earlier.deniedFilePaths + denied(calls) + denied(carriedTools),
    },
    run: snap?.substantive ? { objective: snap.objective, deliverables: snap.deliverables.map(d => ({ ...d })), nextAction: snap.nextAction, blocker: snap.blocker, verification: snap.verification, pendingTools: [...snap.pendingTools] } : null,
  }
}

const FOLD_INDEX_PAGE = 40

export function renderFoldLedger(ledger: FoldLedger): string {
  const stretch = <T extends { epoch: number }>(rows: T[]): T[] => ledger.version === 2 ? rows : rows.filter(row => row.epoch === ledger.epoch)
  const operator = stretch(ledger.operator)
  const tools = stretch(ledger.tools)
  const files = stretch(ledger.files)
  const records = ledger.version === 2 ? ledger.sourceRecordIds : ledger.sourceRecordIds.slice(ledger.priorRecords)
  const totals = totalsThrough(ledger)
  const toolPage = tools.slice(-FOLD_INDEX_PAGE)
  const filePage = files.slice(-FOLD_INDEX_PAGE)
  const byName = new Map<string, { calls: number; failed: number; unknownRc: number }>()
  for (const tool of tools) {
    const row = byName.get(tool.name) ?? { calls: 0, failed: 0, unknownRc: 0 }
    row.calls += 1
    if (tool.outcome === 'error') row.failed += 1
    if (tool.name === 'Bash' && tool.rc === null) row.unknownRc += 1
    byName.set(tool.name, row)
  }
  const index = {
    version: 1, epoch: ledger.epoch,
    stretch: { records: records.length, first: records[0], last: records.at(-1), sha256: ledger.sourceDigest, tools: tools.length, files: files.length, byTool: Object.fromEntries(byName) },
    page: { newestTools: toolPage.length, olderToolsOmitted: tools.length - toolPage.length, newestFiles: filePage.length, olderFilesOmitted: files.length - filePage.length, carriedBy: 'this epoch\'s boundary record, whole' },
    earlierFolds: { records: ledger.priorRecords, operatorMessages: totals.operator.messages - operator.length, tools: totals.tools - tools.length, files: totals.files - files.length, carriedBy: 'their own boundary records, whole' },
    operator: { messages: operator.length, bytes: operator.reduce((n, row) => n + row.bytes, 0) },
    tools: toolPage.map(({ argumentDigest, epoch, file, ...receipt }) => ({ ...receipt, ...(file && receipt.outcome !== 'error' ? { file } : {}) })),
    files: filePage.map(({ epoch, ...file }) => file),
    run: ledger.run,
    witnessesInBoundary: { sourceIds: totals.records, operatorHashes: totals.operator.messages, argumentHashes: totals.tools, deniedFilePaths: totals.deniedFilePaths },
  }
  return `## Fold ledger\nSource facts below are deterministic; generated summary text does not change them. This index covers the stretch folded now, its newest ${FOLD_INDEX_PAGE} tool receipts and file anchors whole and the older ones by count; the earlier folds' receipts are counted here. Each fold's receipts are carried whole in its own boundary record in the transcript. An observed file anchor is not permission to edit unread content. Missing command exit codes are unknown. Open operator asks are not marked complete by a summary.\n\n${JSON.stringify(index)}`
}
