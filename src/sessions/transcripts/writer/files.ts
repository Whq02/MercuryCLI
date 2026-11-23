import type { UUID } from 'crypto'
import { stat } from 'fs/promises'
import { getSessionId } from '../../../boot/process-state/processState.js'
import type { Entry } from '../transcriptEntries.js'
import { isFsInaccessible } from '../../../platform/errors/errors.js'
import { logError } from '../../../platform/logs/errorLog.js'
import { getTranscriptPath, getTranscriptPathForSession } from '../paths.js'

interface FilesProject {
  sessionFile: string | null
  reAppendSessionMetadata(): void
  appendEntry(entry: Entry): Promise<void>
}

interface FilesNeeds {
  shouldSkipPersistence(): boolean
}

export class FilesPart {
  pendingEntries: Entry[] = []

  constructor(
    private readonly project: FilesProject,
    private readonly needs: FilesNeeds,
  ) {}

  async materializeSessionFile(): Promise<void> {
    if (this.needs.shouldSkipPersistence()) return
    this.ensureCurrentSessionFile()
    this.project.reAppendSessionMetadata()
    for (const entry of this.pendingEntries.splice(0)) await this.project.appendEntry(entry)
  }

  async sessionFileFor(sessionId: UUID, entry: Entry): Promise<string | null> {
    if (sessionId === (getSessionId() as UUID)) {
      if (this.project.sessionFile !== null) return this.project.sessionFile
      this.pendingEntries.push(entry)
      return null
    }
    const existing = await this.getExistingSessionFile(sessionId)
    if (!existing) {
      logError(
        new Error(
          `An append for session ${sessionId} found no transcript file for it`,
        ),
      )
      return null
    }
    return existing
  }

  private ensureCurrentSessionFile(): string {
    if (this.project.sessionFile === null) {
      this.project.sessionFile = getTranscriptPath()
    }
    return this.project.sessionFile
  }

  private existingSessionFiles = new Map<string, string>()
  private async getExistingSessionFile(
    sessionId: UUID,
  ): Promise<string | null> {
    const known = this.existingSessionFiles.get(sessionId)
    if (known) return known
    const candidate = getTranscriptPathForSession(sessionId)
    const present = await stat(candidate).then(
      () => true,
      (error: unknown) => {
        if (isFsInaccessible(error)) return false
        throw error
      },
    )
    if (!present) return null
    this.existingSessionFiles.set(sessionId, candidate)
    return candidate
  }
}
