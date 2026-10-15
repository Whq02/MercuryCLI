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
  sourceDigest: string
  operator: Array<{ sourceId: string; bytes: number; sha256: string }>
  tools: Array<{ id: string; sourceId: string; name: string; argumentDigest: string; command?: string; file?: string; resultId: string | null; resultBytes: number; outcome: 'pending' | 'background' | 'ok' | 'error'; rc: number | null }>
  files: Array<{ sourceId: string; file: string; anchor: string; startLine: number | null; lines: number | null; freshness: 'observed-not-rechecked' }>
  run: { objective: string; deliverables: Array<{ id: string; title: string; state: string }>; nextAction: string; blocker: unknown; verification: unknown; pendingTools: unknown[] } | null
  openAsks: Array<{ sourceId: string; state: 'not-inferred-from-summary' }>
}

export const foldContentWitness = (text: string): string => createHash('sha256').update(text).digest('hex')

export function buildFoldLedger(messages: readonly Message[], owner: OwnerKey, epoch: number): FoldLedger {
  const previous = [...messages].reverse().find(row => row.type === 'system' && row.subtype === 'compact_boundary' && row.compactMetadata.ledger)
  const prior = previous?.type === 'system' && previous.subtype === 'compact_boundary' ? previous.compactMetadata.ledger : undefined
  const records = new Set(prior?.sourceRecordIds ?? [])
  const operator = new Map((prior?.operator ?? []).map(entry => [entry.sourceId, entry]))
  const tools = new Map((prior?.tools ?? []).map(entry => [entry.id, { ...entry }]))
  const files = new Map((prior?.files ?? []).map(entry => [entry.sourceId, entry]))
  for (const row of messages) {
    records.add(row.uuid)
    const text = row.type === 'attachment' ? steerTextOf(row.attachment) : operatorTextOf(row)
    if (text !== null) {
      const sourceId = row.type === 'attachment' && row.attachment.type === 'queued_command' ? row.attachment.source_uuid ?? row.uuid : row.uuid
      operator.set(sourceId, { sourceId, bytes: Buffer.byteLength(text), sha256: foldContentWitness(text) })
    }
    if (row.type === 'assistant' && Array.isArray(row.message.content)) {
      for (const block of row.message.content) {
        if (block.type !== 'tool_use') continue
        if (tools.has(block.id)) continue
        const input = (block.input && typeof block.input === 'object' ? block.input : {}) as Record<string, unknown>
        tools.set(block.id, { id: block.id, sourceId: row.uuid, name: block.name, argumentDigest: foldContentWitness(JSON.stringify(input)),
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
        files.set(row.uuid, { sourceId: row.uuid, file: file.filePath, anchor: file.anchor,
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
    version: 1, epoch, sourceRecordIds, sourceDigest: foldContentWitness(JSON.stringify({ previous: prior?.sourceDigest, rows: messages.map(row => ({ id: row.uuid, body: row.type === 'assistant' || row.type === 'user' ? row.message.content : row.type === 'attachment' ? row.attachment : null })) })),
    operator: [...operator.values()], tools: [...tools.values()], files: [...files.values()],
    run: snap?.substantive ? { objective: snap.objective, deliverables: snap.deliverables.map(d => ({ ...d })), nextAction: snap.nextAction, blocker: snap.blocker, verification: snap.verification, pendingTools: [...snap.pendingTools] } : null,
    openAsks: [...operator.values()].map(entry => ({ sourceId: entry.sourceId, state: 'not-inferred-from-summary' })),
  }
}

export function renderFoldLedger(ledger: FoldLedger): string {
  const index = {
    version: ledger.version, epoch: ledger.epoch,
    source: { records: ledger.sourceRecordIds.length, first: ledger.sourceRecordIds[0], last: ledger.sourceRecordIds.at(-1), sha256: ledger.sourceDigest },
    operator: { messages: ledger.operator.length, bytes: ledger.operator.reduce((n, row) => n + row.bytes, 0) },
    tools: ledger.tools.map(({ argumentDigest, ...receipt }) => receipt), files: ledger.files,
    run: ledger.run, openAsks: ledger.openAsks,
    witnessesInBoundary: { sourceIds: ledger.sourceRecordIds.length, operatorHashes: ledger.operator.length, argumentHashes: ledger.tools.length },
  }
  return `## Fold ledger\nSource facts below are deterministic; generated summary text does not change them. The full witness index is in this epoch's boundary record in the transcript. An observed file anchor is not permission to edit unread content. Missing command exit codes are unknown. Open operator asks are not marked complete by a summary.\n\n${JSON.stringify(index)}`
}
