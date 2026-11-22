import { createHash } from 'node:crypto'
import type { Message } from '../../types/message.js'
import { operatorTextOf, steerTextOf } from '../../utils/compact/operatorMessages.js'
import { getRunSnapshot } from '../run/runCoordinator.js'
import type { OwnerKey } from '../../utils/run/ownerKey.js'
import { parseAnchor } from '../changeTransaction/snapshotAnchor.js'
import { notBuilt } from '../../pi/holes.js'

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
  return notBuilt('src/services/compact/foldLedger.ts:54')
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
