import type { UUID } from 'crypto'
import { getPlanSlugCache, getPromptId, getSessionId } from '../../../bootstrap/state.js'
import type { Entry, TranscriptMessage } from '../../../types/logs.js'
import type { SessionMeta } from '../sessionMeta.js'
import { promptLabel } from '../sessionIndex.js'
import { getCwd } from '../../cwd.js'
import { getBranch } from '../../git.js'
import { isCompactBoundaryMessage } from '../../messages/systemMessages.js'
import { getWorkload } from '../../workloadContext.js'
import { effortNotOnWire } from '../../effortStamp.js'
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
  ) {
    return this.needs.trackWrite(() => this.needs.serializeInsert(async () => {
      let parentUuid: UUID | null = startingParentUuid ?? null
      if (!isSidechain && (preferLiveLeaf || parentUuid === null)) {
        const leaf = this.project.currentSessionChainLeaf
        if (leaf !== undefined) parentUuid = leaf
      }

      if (
        this.project.sessionFile === null &&
        messages.some(m => m.type === 'user' || m.type === 'assistant')
      ) {
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

      for (const message of messages) {
        const isCompactBoundary = isCompactBoundaryMessage(message)

        let effectiveParentUuid = parentUuid
        if (
          message.type === 'user' &&
          'sourceToolAssistantUUID' in message &&
          message.sourceToolAssistantUUID
        ) {
          effectiveParentUuid = this.leafDescendsQuietly(parentUuid, message.sourceToolAssistantUUID) ? parentUuid : message.sourceToolAssistantUUID
        }

        const transcriptMessage: TranscriptMessage = {
          parentUuid: isCompactBoundary ? null : effectiveParentUuid,
          logicalParentUuid: isCompactBoundary
            ? (parentUuid ?? undefined)
            : undefined,
          isSidechain,
          promptId:
            message.type === 'user' ? (getPromptId() ?? undefined) : undefined,
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
        await this.project.appendEntry(transcriptMessage)
        if (isChainParticipant(message)) {
          this.noteChainLink(message.uuid as UUID, transcriptMessage.parentUuid, !isCompactBoundary && (message.type === 'attachment' || message.type === 'system'))
          parentUuid = message.uuid
          if (!isSidechain) this.project.currentSessionChainLeaf = message.uuid as UUID
        }
      }

      if (!isSidechain) {
        const text = getFirstMeaningfulUserMessageTextContent(messages)
        if (text) this.project.metadata.cache('lastPrompt', promptLabel(text))
      }
    }))
  }
}
