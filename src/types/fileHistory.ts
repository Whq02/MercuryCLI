import type { UUID } from 'node:crypto'

export type FileHistoryBackup = {
  backupFileName: string | null
  version: number
  backupTime: Date
  sourceSize?: number
  sourceMtimeMs?: number
  sourceMode?: number
}

export type FileHistorySnapshot = {
  messageId: UUID
  trackedFileBackups: Record<string, FileHistoryBackup>
  timestamp: Date
}

export type FileHistoryState = {
  snapshots: FileHistorySnapshot[]
  trackedFiles: Set<string>
  snapshotSequence: number
  rewindUndo?: FileHistorySnapshot & { restoredDigests: Record<string, string | null> }
}
