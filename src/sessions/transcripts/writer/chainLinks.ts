import type { UUID } from 'crypto'
import { getPlanSlugCache, getPromptId, getSessionId } from '../../../boot/process-state/processState.js'
import type { Entry, TranscriptMessage } from '../transcriptEntries.js'
import type { SessionMeta } from '../sessionMeta.js'
import { promptLabel } from '../sessionIndex.js'
import { getCwd } from '../../../platform/files/cwd.js'
import { getBranch } from '../../../platform/git/git.js'
import { isFoldBoundaryMessage } from '../../../engine/message-shapes/systemMessages.js'
import { getWorkload } from '../../../models/roads/workloadContext.js'
import { effortNotOnWire } from '../../../models/effort/effortStamp.js'
import { getFirstMeaningfulUserMessageTextContent, type Transcript } from '../chain.js'
import { getEntrypoint, isChainParticipant } from '../paths.js'
import type { QueuePart } from './queue.js'

const VERSION = typeof MACRO !== 'undefined' ? MACRO.VERSION : 'unknown'

const RECENT_CHAIN_LINKS = 512

interface ChainProject {
  currentSessionChainLeaf: UUID | undefined
  readonly sessionFile: string | null
  readonly metadata: SessionMeta
  appendEntry(entry: Entry): Promise<void>
}

interface ChainNeeds {
  trackWrite: QueuePart['trackWrite']
  serializeInsert: QueuePart['serializeInsert']
  materializeSessionFile(): Promise<void>
}

function* beforeSealing(messages: Transcript): Generator<Transcript[number]> {
  let moved: Set<UUID> | undefined
  for (const [i, message] of messages.entries()) {
    if (moved?.has(message.uuid)) continue
    const ids = isFoldBoundaryMessage(message) ? message.compactMetadata?.preservedSegment?.keptUuids : undefined
    if (Array.isArray(ids) && i + 1 < messages.length) {
      const kept = new Set(ids)
      for (let j = i + 1; j < messages.length; j++) {
        const row = messages[j]!
        if (!kept.delete(row.uuid) || moved?.has(row.uuid)) continue
        moved ??= new Set()
        moved.add(row.uuid)
        yield row
      }
    }
    yield message
  }
}

export class ChainPart {
  private readonly recentChainLinks = new Map<UUID, { parent: UUID | null; quiet: boolean }>()

  constructor(
    private readonly project: ChainProject,
    private readonly needs: ChainNeeds,
  ) {}

  private noteChainLink(uuid: UUID, parent: UUID | null, quiet: boolean): void {
    this.recentChainLinks.set(uuid, { parent, quiet })
    while (this.recentChainLinks.size > RECENT_CHAIN_LINKS) {
      const oldest = this.recentChainLinks.keys().next().value
      if (oldest === undefined) break
      this.recentChainLinks.delete(oldest)
    }
  }

  private leafDescendsQuietly(leaf: UUID | null, source: UUID): boolean {
    let cursor = leaf
    for (let steps = 0; cursor !== null && steps < RECENT_CHAIN_LINKS; steps++) {
      if (cursor === source) return true
      const link = this.recentChainLinks.get(cursor)
      if (link === undefined || !link.quiet) return false
      cursor = link.parent
    }
    return false
  }

  async insertMessageChain(
    messages: Transcript,
    isSidechain: boolean = false,
    agentId?: string,
    startingParentUuid?: UUID | null,
    preferLiveLeaf: boolean = false,
  ): Promise<void> {
    await this.needs.trackWrite(() =>
      this.needs.serializeInsert(async () => {
        let parentUuid: UUID | null = startingParentUuid ?? null
        if (!isSidechain && (preferLiveLeaf || parentUuid === null) && this.project.currentSessionChainLeaf !== undefined) {
          parentUuid = this.project.currentSessionChainLeaf
        }
        if (this.project.sessionFile === null && messages.some(m => m.type === 'user' || m.type === 'assistant')) {
          await this.needs.materializeSessionFile()
        }
        let gitBranch: string | undefined
        try {
          gitBranch = await getBranch()
        } catch {
          gitBranch = undefined
        }
        const sessionId = getSessionId()
        const slug = getPlanSlugCache().get(sessionId)

        for (const message of isSidechain ? messages : beforeSealing(messages)) {
          const sourceAssistantUuid = message.type === 'user' ? message.sourceToolAssistantUUID : undefined
          const effectiveParentUuid =
            sourceAssistantUuid && !this.leafDescendsQuietly(parentUuid, sourceAssistantUuid)
              ? sourceAssistantUuid
              : parentUuid
          const isCompactBoundary = isFoldBoundaryMessage(message)
          const entryParentUuid = isCompactBoundary ? null : effectiveParentUuid
          const logicalParentUuid = isCompactBoundary ? (parentUuid ?? undefined) : undefined

          const entry: TranscriptMessage = {
            parentUuid: entryParentUuid,
            logicalParentUuid,
            isSidechain,
            promptId: getPromptId() ?? undefined,
            workload: message.type === 'assistant' ? getWorkload() : undefined,
            agentId,
            ...(message.type === 'assistant' ? { effort: effortNotOnWire() } : {}),
            ...message,
            entrypoint: getEntrypoint(),
            cwd: getCwd(),
            sessionId,
            version: VERSION,
            gitBranch,
            slug,
          }

          await this.project.appendEntry(entry)

          if (isChainParticipant(message)) {
            const quiet = !isCompactBoundary && (message.type === 'attachment' || message.type === 'system')
            this.noteChainLink(message.uuid, entry.parentUuid, quiet)
            parentUuid = message.uuid
            if (!isSidechain) {
              this.project.currentSessionChainLeaf = message.uuid
            }
          }
        }

        if (!isSidechain) {
          const firstText = getFirstMeaningfulUserMessageTextContent(messages)
          if (firstText) {
            this.project.metadata.cache('lastPrompt', promptLabel(firstText))
          }
        }
      }),
    )
  }
}
