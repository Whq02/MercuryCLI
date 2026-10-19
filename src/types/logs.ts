import type { UUID } from 'crypto'
import type { Message } from './message.js'
import type { ContentReplacementRecord } from '../utils/toolResultStorage.js'
import type { FileHistorySnapshot } from '../utils/fileHistory.js'
import type { FileAttribution, StorageRowKind, StorageRowOf, StoredRow, WorktreeBinding } from '../rows/storage.js'

type Flattened<T> = { [K in keyof T]: T[K] }
type StoredPayload<K extends StorageRowKind> = Flattened<StorageRowOf<K>>

export type Entry = StoredRow

type WriteEnvelope = { cwd: string; sessionId: UUID; version: string } & Partial<Record<'entrypoint' | 'gitBranch' | 'slug', string>>
export type SerializedMessage = Message & WriteEnvelope

type ChainLinks = { parentUuid: UUID | null; isSidechain: boolean; logicalParentUuid?: UUID }
type ChainAuthor = Partial<Record<'agentId' | 'agentName' | 'agentColor' | 'promptId' | 'workload', string>>
export type TranscriptMessage = SerializedMessage & ChainLinks & ChainAuthor

export type PersistedWorktreeSession = Flattened<WorktreeBinding>
export type FileAttributionState = Flattened<FileAttribution>
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
type ListingFile = Partial<{ fullPath: string; fileSize: number; messageCount: number; isLite: boolean; sessionId: string }>
type ListingLabels = Partial<{
  summary: string
  customTitle: string
  tag: string
  leafUuid: UUID
  agentName: string
  agentColor: string
  agentSetting: string
}>
type ListingPlace = Partial<{
  gitBranch: string
  projectPath: string
  prNumber: number
  prUrl: string
  prRepository: string
  worktreeSession: PersistedWorktreeSession | null
}>
type ListingRun = { endedOnError?: boolean; mode?: 'coordinator' | 'normal'; advisor?: boolean; model?: string }
type ListingRecords = Partial<{
  fileHistorySnapshots: FileHistorySnapshot[]
  attributionSnapshots: AttributionSnapshotEntry[]
  contextCollapseCommits: ContextCollapseCommitEntry[]
  contextCollapseSnapshot: ContextCollapseSnapshotEntry
  contentReplacements: ContentReplacementRecord[]
}>
export type SessionListing = Flattened<ListingCore & ListingFile & ListingLabels & ListingPlace & ListingRun & ListingRecords>

const newestFirst =
  (when: (log: SessionListing) => Date) =>
  (a: SessionListing, b: SessionListing): number =>
    when(b).getTime() - when(a).getTime()

const newestDate = (a: SessionListing, b: SessionListing): number => {
  const ta = Date.parse(a.date)
  const tb = Date.parse(b.date)
  if (Number.isFinite(ta) && Number.isFinite(tb) && tb !== ta) return tb - ta
  return b.date.localeCompare(a.date)
}

const LISTING_ORDER = [newestFirst(log => log.modified), newestFirst(log => log.created), newestDate]

export function sortSessionListings(logs: SessionListing[]): SessionListing[] {
  return logs.sort((a, b) => LISTING_ORDER.reduce((order, compare) => order || compare(a, b), 0))
}
