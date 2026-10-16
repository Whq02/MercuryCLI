import { createHash } from 'node:crypto'
import type { Message } from '../../types/message.js'
import { operatorTextOf, steerTextOf } from './operatorMessages.js'
import { getRunSnapshot } from '../run/runCoordinator.js'
import type { OwnerKey } from '../run/ownerKey.js'
import { parseAnchor } from '../changeTransaction/snapshotAnchor.js'

export type FoldLedger = {
  version: 1
  epoch: number
  sourceRecordIds: string[]
  priorRecords: number
  sourceDigest: string
  operator: Array<{ sourceId: string; epoch: number; bytes: number; sha256: string }>
  tools: Array<{ id: string; sourceId: string; epoch: number; name: string; argumentDigest: string; command?: string; file?: string; resultId: string | null; resultBytes: number; outcome: 'pending' | 'background' | 'ok' | 'error'; rc: number | null }>
  files: Array<{ sourceId: string; epoch: number; file: string; anchor: string; startLine: number | null; lines: number | null; freshness: 'observed-not-rechecked' }>
  run: { objective: string; deliverables: Array<{ id: string; title: string; state: string }>; nextAction: string; blocker: unknown; verification: unknown; pendingTools: unknown[] } | null
}

export const foldContentWitness = (text: string): string => createHash('sha256').update(text).digest('hex')

export function buildFoldLedger(messages: readonly Message[], owner: OwnerKey, epoch: number): FoldLedger {
  const previous = [...messages].reverse().find(row => row.type === 'system' && row.subtype === 'compact_boundary' && row.compactMetadata.ledger)
  const prior = previous?.type === 'system' && previous.subtype === 'compact_boundary' ? previous.compactMetadata.ledger : undefined
  const records = new Set(prior?.sourceRecordIds ?? [])
  const priorRecords = records.size
  const operator = new Map((prior?.operator ?? []).map(entry => [entry.sourceId, entry]))
  const tools = new Map((prior?.tools ?? []).map(entry => [entry.id, { ...entry }]))
  const files = new Map((prior?.files ?? []).map(entry => [entry.sourceId, entry]))
  for (const row of messages) {
    if (records.has(row.uuid)) continue
    records.add(row.uuid)
    const text = row.type === 'attachment' ? steerTextOf(row.attachment) : operatorTextOf(row)
    if (text !== null) {
      const sourceId = row.type === 'attachment' && row.attachment.type === 'queued_command' ? row.attachment.source_uuid ?? row.uuid : row.uuid
      if (!operator.has(sourceId)) operator.set(sourceId, { sourceId, epoch, bytes: Buffer.byteLength(text), sha256: foldContentWitness(text) })
    }
    if (row.type === 'assistant' && Array.isArray(row.message.content)) {
      for (const block of row.message.content) {
        if (block.type !== 'tool_use') continue
        if (tools.has(block.id)) continue
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
      const tool = tools.get(result.tool_use_id)
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
  const sourceRecordIds = [...records]
  return {
    version: 1, epoch, sourceRecordIds, priorRecords, sourceDigest: foldContentWitness(JSON.stringify({ previous: prior?.sourceDigest, rows: messages.map(row => ({ id: row.uuid, body: row.type === 'assistant' || row.type === 'user' ? row.message.content : row.type === 'attachment' ? row.attachment : null })) })),
    operator: [...operator.values()], tools: [...tools.values()], files: [...files.values()],
    run: snap?.substantive ? { objective: snap.objective, deliverables: snap.deliverables.map(d => ({ ...d })), nextAction: snap.nextAction, blocker: snap.blocker, verification: snap.verification, pendingTools: [...snap.pendingTools] } : null,
  }
}

export const FOLD_INDEX_PAGE = 40

export function renderFoldLedger(ledger: FoldLedger): string {
  const stretch = <T extends { epoch: number }>(rows: T[]): T[] => rows.filter(row => row.epoch === ledger.epoch)
  const operator = stretch(ledger.operator)
  const tools = stretch(ledger.tools)
  const files = stretch(ledger.files)
  const records = ledger.sourceRecordIds.slice(ledger.priorRecords)
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
    version: ledger.version, epoch: ledger.epoch,
    stretch: { records: records.length, first: records[0], last: records.at(-1), sha256: ledger.sourceDigest, tools: tools.length, files: files.length, byTool: Object.fromEntries(byName) },
    page: { newestTools: toolPage.length, olderToolsOmitted: tools.length - toolPage.length, newestFiles: filePage.length, olderFilesOmitted: files.length - filePage.length, carriedBy: 'this epoch\'s boundary record, whole' },
    earlierFolds: { records: ledger.priorRecords, operatorMessages: ledger.operator.length - operator.length, tools: ledger.tools.length - tools.length, files: ledger.files.length - files.length, carriedBy: 'this epoch\'s boundary record, whole' },
    operator: { messages: operator.length, bytes: operator.reduce((n, row) => n + row.bytes, 0) },
    tools: toolPage.map(({ argumentDigest, epoch, file, ...receipt }) => ({ ...receipt, ...(file && receipt.outcome !== 'error' ? { file } : {}) })),
    files: filePage.map(({ epoch, ...file }) => file),
    run: ledger.run,
    witnessesInBoundary: { sourceIds: ledger.sourceRecordIds.length, operatorHashes: ledger.operator.length, argumentHashes: ledger.tools.length, deniedFilePaths: ledger.tools.filter(tool => tool.outcome === 'error' && tool.file).length },
  }
  return `## Fold ledger\nSource facts below are deterministic; generated summary text does not change them. This index covers the stretch folded now, its newest ${FOLD_INDEX_PAGE} tool receipts and file anchors whole and the older ones by count; the earlier folds' receipts are counted here. Every receipt is carried whole in this epoch's boundary record in the transcript. An observed file anchor is not permission to edit unread content. Missing command exit codes are unknown. Open operator asks are not marked complete by a summary.\n\n${JSON.stringify(index)}`
}
