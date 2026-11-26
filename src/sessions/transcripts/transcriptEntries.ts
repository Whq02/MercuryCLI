import type { UUID } from 'crypto'
import type { Message } from '../../engine/message-shapes/message.js'
import type { ContentReplacementRecord } from '../../engine/tool-dispatch/toolResultStorage.js'
import type { FileHistorySnapshot } from './fileHistory.js'
import type { StorageRowKind, StorageRowOf, StoredRow, WorktreeBinding } from '../../engine/rows/storage.js'
import { compareSessionRecency } from './sessionIndex.js'
type Flattened<T> = { [K in keyof T]: T[K] }
type StoredPayload<K extends StorageRowKind> = Flattened<StorageRowOf<K>>

export type Entry = StoredRow

type WriteEnvelope = { cwd: string; sessionId: UUID; version: string } & Partial<Record<'entrypoint' | 'gitBranch' | 'slug', string>>
export type SerializedMessage = Message & WriteEnvelope

type ChainLinks = { parentUuid: UUID | null; isSidechain: boolean; logicalParentUuid?: UUID }
type ChainAuthor = Partial<Record<'agentId' | 'agentName' | 'agentColor' | 'promptId' | 'workload', string>>
export type TranscriptMessage = SerializedMessage & ChainLinks & ChainAuthor

export type PersistedWorktreeSession = Flattened<WorktreeBinding>
export type ContentReplacementEntry = StoredPayload<'content-replacement'>
export type FileHistorySnapshotEntry = StoredPayload<'file-history-snapshot'>
export type AttributionSnapshotEntry = StoredPayload<'attribution-snapshot'>
export type ContextCollapseCommitEntry = StoredPayload<'context-collapse-commit'>
export type ContextCollapseSnapshotEntry = StoredPayload<'context-collapse-snapshot'>

type ListingCore = {
  date: string
  value: number
  firstPrompt: string
  isSidechain: boolean
  messages: SerializedMessage[]
  created: Date
  modified: Date
}
type ListingFile = Partial<{ fullPath: string; fileSize: number; messageCount: number; isLite: boolean; sessionId: string; lastUsedAt: number }>
type ListingLabels = Partial<{
  summary: string
  customTitle: string
  tag: string
  leafUuid: UUID
  agentName: string
  agentColor: string
  agentSetting: string
  brief: string
  briefAdd: string
}>
type ListingPlace = Partial<{
  gitBranch: string
  projectPath: string
  prNumber: number
  prUrl: string
  prRepository: string
  worktreeSession: PersistedWorktreeSession | null
}>
export type TurnEnded = { turnId: string; status: string; trailing: UUID[] }
type ListingRun = { endedOnError?: boolean; mode?: 'coordinator' | 'normal'; advisor?: boolean; swarm?: boolean; model?: string; turnEnd?: TurnEnded; turnOpen?: boolean }
type ListingRecords = Partial<{
  fileHistorySnapshots: FileHistorySnapshot[]
  attributionSnapshots: AttributionSnapshotEntry[]
  contextCollapseCommits: ContextCollapseCommitEntry[]
  contextCollapseSnapshot: ContextCollapseSnapshotEntry
  contentReplacements: ContentReplacementRecord[]
}>
export type SessionListing = Flattened<ListingCore & ListingFile & ListingLabels & ListingPlace & ListingRun & ListingRecords>

const newestDate = (a: SessionListing, b: SessionListing): number => {
  const ta = Date.parse(a.date)
  const tb = Date.parse(b.date)
  if (Number.isFinite(ta) && Number.isFinite(tb) && tb !== ta) return tb - ta
  return b.date.localeCompare(a.date)
}

export function compareSessionListings(a: SessionListing, b: SessionListing): number {
  return compareSessionRecency(
    { lastUsedMs: a.lastUsedAt ?? null, mtimeMs: new Date(a.modified).getTime(), createdMs: a.created ? new Date(a.created).getTime() : undefined, sessionId: a.sessionId },
    { lastUsedMs: b.lastUsedAt ?? null, mtimeMs: new Date(b.modified).getTime(), createdMs: b.created ? new Date(b.created).getTime() : undefined, sessionId: b.sessionId },
  )
}

export function sortSessionListings(logs: SessionListing[]): SessionListing[] {
  return logs.sort((a, b) => compareSessionListings(a, b) || newestDate(a, b))
}
