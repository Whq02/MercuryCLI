import { EMPTY_USAGE, type NonNullableUsage } from '../../request-parts/emptyUsage.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../../../tools/kit/names/syntheticOutput.js'
import type { AssistantMessage, Message } from '../../message-shapes/message.js'
import type { FileStateCache } from '../../../platform/files/fileStateCache.js'
import { reconstructContentReplacementState, type ContentReplacementState } from '../../tool-dispatch/toolResultStorage.js'
import { logError } from '../../../platform/logs/errorLog.js'
import { recordTranscript } from '../../../sessions/transcripts/sessionStorage.js'
import { recordTurnStart } from '../../../sessions/transcripts/writer.js'
import type { Denial } from '../vocabulary.js'
import type { ConversationConfig } from '../turn.js'

export class ConversationState {
  readonly config: ConversationConfig
  readonly mutableMessages: Message[]
  readonly readFileState: FileStateCache
  readonly contentReplacementState: ContentReplacementState
  readonly abortController: AbortController
  userSpecifiedModel: string | undefined
  readonly loadedNestedMemoryPaths = new Set<string>()
  readonly discoveredSkillNames = new Set<string>()
  readonly denials: Denial[] = []
  readonly unansweredAsks = new Set<string>()
  accumulatedUsage: NonNullableUsage = { ...EMPTY_USAGE }
  readonly streamFoldedIds = new Set<string>()
  readonly settledUsageById = new Map<string, NonNullableUsage>()
  turnOrdinal = 0
  recordCursor = 0
  recordChain: Promise<string | null> = Promise.resolve(null)
  turnToOpen: string | undefined
  structuredOutput: unknown

  constructor(config: ConversationConfig) {
    this.config = config
    this.mutableMessages = [...(config.initialMessages ?? [])]
    this.readFileState = config.readFileState
    this.contentReplacementState = config.contentReplacementState ?? reconstructContentReplacementState(this.mutableMessages, [])
    this.abortController = config.abortController ?? new AbortController()
    this.userSpecifiedModel = config.userSpecifiedModel
  }

  recordDelta(turnMessages: Message[]): Promise<string | null> {
    const pending = turnMessages.slice(this.recordCursor)
    this.recordCursor = turnMessages.length
    if (pending.length === 0) return this.recordChain
    const opening = this.turnToOpen
    this.turnToOpen = undefined
    this.recordChain = this.recordChain.then(hint =>
      (opening === undefined ? Promise.resolve() : recordTurnStart(opening)).then(() => recordTranscript(pending, (hint ?? undefined) as Parameters<typeof recordTranscript>[1], turnMessages)).catch((error: unknown) => {
        logError(error)
        return null
      }),
    )
    return this.recordChain
  }

  countSyntheticOutputCalls(): number {
    let count = 0
    for (const message of this.mutableMessages) {
      if (message.type !== 'assistant') continue
      const content = (message as AssistantMessage).message.content
      if (!Array.isArray(content)) continue
      for (const block of content) {
        const typed = block as { type?: string; name?: string }
        if (typed.type === 'tool_use' && typed.name === SYNTHETIC_OUTPUT_TOOL_NAME) count++
      }
    }
    return count
  }
}
