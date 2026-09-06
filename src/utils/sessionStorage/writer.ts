
import type { UUID } from 'crypto'
import {
  closeSync,
  fstatSync,
  ftruncateSync,
  openSync,
  readFileSync,
  readSync,
  writeFileSync,
  writeSync,
} from 'fs'
import { appendFile as fsAppendFile, mkdir, readFile, stat } from 'fs/promises'
import { basename, dirname } from 'path'
import memoize from 'lodash-es/memoize.js'
import {
  getPlanSlugCache,
  getPromptId,
  getSessionId,
  isSessionPersistenceDisabled,
} from '../../bootstrap/state.js'
import { type AgentId, asAgentId } from '../../types/ids.js'
import type {
  ContentReplacementEntry,
  Entry,
  FileHistorySnapshotMessage,
  PersistedWorktreeSession,
  TranscriptMessage,
} from '../../types/logs.js'
import type { AttributionSnapshotMessage } from '../../types/logs.js'
import type { Message } from '../../types/message.js'
import type { QueueOperationMessage } from '../../types/messageQueueTypes.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { registerExitCliffSeam } from '../exitCliffDrain.js'
import { getCwd } from '../cwd.js'
import { logForDebugging } from '../debug.js'
import { isEnvTruthy } from '../envUtils.js'
import { isFsInaccessible } from '../errors.js'
import type { FileHistorySnapshot } from '../fileHistory.js'
import { formatFileSize } from '../format.js'
import { getFsImplementation } from '../fsOperations.js'
import { getBranch } from '../git.js'
import { isShuttingDown } from '../gracefulShutdown.js'
import { logError } from '../log.js'
import { isCompactBoundaryMessage } from '../messages.js'
import {
  extractLastJsonStringField,
  LITE_READ_BUF_SIZE,
} from '../sessionStoragePortable.js'
import { getSettings_DEPRECATED } from '../settings/settings.js'
import { jsonParse, jsonStringify } from '../slowOperations.js'
import type { ContentReplacementRecord } from '../toolResultStorage.js'
import {
  cleanMessagesForLogging,
  getFirstMeaningfulUserMessageTextContent,
  type Transcript,
} from './chain.js'
import { loadSessionFile } from './loading.js'
import {
  getAgentTranscriptPath,
  getEntrypoint,
  getNodeEnv,
  getTranscriptPath,
  getTranscriptPathForSession,
  isChainParticipant,
  isTranscriptMessage,
} from './paths.js'
import {
  encodeTranscriptLine,
  resetTranscriptFormatCacheForTesting,
} from './vnext.js'

const VERSION = typeof MACRO !== 'undefined' ? MACRO.VERSION : 'unknown'

const MAX_TOMBSTONE_REWRITE_BYTES = 50 * 1024 * 1024

export const getSessionMessages = memoize(
  async (sessionId: UUID): Promise<Set<UUID>> => {
    const { messages } = await loadSessionFile(sessionId)
    return new Set(messages.keys())
  },
  (sessionId: UUID) => sessionId,
)

export type TranscriptStoreHealth = { failing: boolean; sentence: string | null }
let storeHealth: TranscriptStoreHealth = { failing: false, sentence: null }
const storeHealthListeners = new Set<() => void>()
function setStoreHealth(next: TranscriptStoreHealth): void {
  if (storeHealth.failing === next.failing && storeHealth.sentence === next.sentence) return
  storeHealth = next
  for (const listener of storeHealthListeners) listener()
}
export function transcriptStoreHealth(): TranscriptStoreHealth {
  return storeHealth
}
export function subscribeTranscriptStoreHealth(listener: () => void): () => void {
  storeHealthListeners.add(listener)
  return () => storeHealthListeners.delete(listener)
}

const agentTranscriptDestinations = new Map<string, string>()

export function registerAgentTranscriptDestination(
  agentId: string,
  filePath: string,
): void {
  agentTranscriptDestinations.set(agentId, filePath)
}

export const getAgentFileMessages = memoize(
  async (filePath: string): Promise<Set<string>> => {
    let raw: string
    try {
      raw = await readFile(filePath, 'utf8')
    } catch {
      return new Set()
    }
    const set = new Set<string>()
    for (const line of raw.split('\n')) {
      if (!line) continue
      try {
        const e = JSON.parse(line) as {
          annotations?: { uuid?: string }
        }
        const uuid = e.annotations?.uuid
        if (typeof uuid === 'string') set.add(uuid)
      } catch {
      }
    }
    return set
  },
  (filePath: string) => filePath,
)

let project: Project | null = null
let cleanupRegistered = false

export function getProject(): Project {
  if (!project) {
    project = new Project()

    if (!cleanupRegistered) {
      registerCleanup(async () => {
        await project?.flush()
        try {
          project?.reAppendSessionMetadata()
        } catch {
        }
      })
      registerExitCliffSeam({
        name: 'transcript-writer',
        phase: 1,
        settle: () => project?.flush() ?? Promise.resolve(),
      })
      cleanupRegistered = true
    }
  }
  return project
}

export function peekProject(): Project | null {
  return project
}

export function resetProjectFlushStateForTesting(): void {
  project?._resetFlushState()
}

export function resetProjectForTesting(): void {
  resetTranscriptFormatCacheForTesting()
  project = null
}

export function setSessionFileForTesting(path: string): void {
  getProject().sessionFile = path
}

type InternalEventWriter = (
  eventType: string,
  payload: Record<string, unknown>,
  options?: { isCompaction?: boolean; agentId?: string },
) => Promise<void>

export function setInternalEventWriter(writer: InternalEventWriter): void {
  getProject().setInternalEventWriter(writer)
}

type InternalEventReader = () => Promise<
  { payload: Record<string, unknown>; agent_id?: string }[] | null
>

export function setInternalEventReader(
  reader: InternalEventReader,
  subagentReader: InternalEventReader,
): void {
  getProject().setInternalEventReader(reader)
  getProject().setInternalSubagentEventReader(subagentReader)
}

export function setRemoteIngressUrlForTesting(url: string): void {
  getProject().setRemoteIngressUrl(url)
}

let transcriptMessagesVisited = 0
export function getTranscriptMessagesVisited(): number {
  return transcriptMessagesVisited
}

export async function recordTranscript(
  messages: Message[],
  teamInfo?: TeamInfo,
  startingParentUuidHint?: UUID,
  allMessages?: readonly Message[],
  replIds?: Set<string>,
): Promise<UUID | null> {
  transcriptMessagesVisited += messages.length
  const cleanedMessages = cleanMessagesForLogging(messages, allMessages, replIds)
  const sessionId = getSessionId() as UUID
  const messageSet = await getSessionMessages(sessionId)
  const newMessages: typeof cleanedMessages = []
  let startingParentUuid: UUID | undefined = startingParentUuidHint
  let seenNewMessage = false
  for (const m of cleanedMessages) {
    if (messageSet.has(m.uuid as UUID)) {
      if (!seenNewMessage && isChainParticipant(m)) {
        startingParentUuid = m.uuid as UUID
      }
    } else {
      newMessages.push(m)
      seenNewMessage = true
    }
  }
  const preferLiveLeaf = messageSet.size > 0
  if (newMessages.length > 0) {
    await getProject().insertMessageChain(
      newMessages,
      false,
      undefined,
      startingParentUuid,
      teamInfo,
      preferLiveLeaf,
    )
  }
  const lastRecorded = newMessages.findLast(isChainParticipant)
  if (lastRecorded) return lastRecorded.uuid as UUID
  if (preferLiveLeaf) {
    const leaf = getProject().currentSessionChainLeaf
    if (leaf !== undefined) return leaf
  }
  return startingParentUuid ?? null
}

export function settleTranscriptMessage(message: Message): Promise<void> {
  return getProject().settleMessage(message)
}

export async function recordSidechainTranscript(
  messages: Message[],
  agentId?: string,
  startingParentUuid?: UUID | null,
) {
  await getProject().insertMessageChain(
    cleanMessagesForLogging(messages),
    true,
    agentId,
    startingParentUuid,
  )
}

export async function recordQueueOperation(queueOp: QueueOperationMessage) {
  await getProject().insertQueueOperation(queueOp)
}

export async function removeTranscriptMessage(targetUuid: UUID): Promise<void> {
  await getProject().removeMessageByUuid(targetUuid)
}

export async function recordFileHistorySnapshot(
  messageId: UUID,
  snapshot: FileHistorySnapshot,
  isSnapshotUpdate: boolean,
) {
  await getProject().insertFileHistorySnapshot(
    messageId,
    snapshot,
    isSnapshotUpdate,
  )
}

export async function recordAttributionSnapshot(
  snapshot: AttributionSnapshotMessage,
) {
  await getProject().insertAttributionSnapshot(snapshot)
}

export async function recordContentReplacement(
  replacements: ContentReplacementRecord[],
  agentId?: AgentId,
) {
  await getProject().insertContentReplacement(replacements, agentId)
}

export async function resetSessionFilePointer() {
  getProject().resetSessionFile()
}

export function adoptResumedSessionFile(): void {
  const project = getProject()
  project.sessionFile = getTranscriptPath()
  project.reAppendSessionMetadata(true)
  project.currentSessionChainLeaf = undefined
}

export async function recordContextCollapseCommit(commit: {
  collapseId: string
  summaryUuid: string
  summaryContent: string
  summary: string
  firstArchivedUuid: string
  lastArchivedUuid: string
}): Promise<void> {
  const sessionId = getSessionId() as UUID
  if (!sessionId) return
  await getProject().appendEntry({
    type: 'context-collapse-commit',
    sessionId,
    ...commit,
  })
}

export async function recordContextCollapseSnapshot(snapshot: {
  staged: Array<{
    startUuid: string
    endUuid: string
    summary: string
    risk: number
    stagedAt: number
  }>
  armed: boolean
  lastSpawnTokens: number
}): Promise<void> {
  const sessionId = getSessionId() as UUID
  if (!sessionId) return
  await getProject().appendEntry({
    type: 'context-collapse-snapshot',
    sessionId,
    ...snapshot,
  })
}

export async function flushSessionStorage(): Promise<void> {
  await getProject().flush()
}

const REMOTE_FLUSH_INTERVAL_MS = 10

const ALWAYS_APPEND_KINDS = new Set<Entry['type']>([
  'summary',
  'custom-title',
  'ai-title',
  'last-prompt',
  'task-summary',
  'tag',
  'agent-name',
  'agent-color',
  'agent-setting',
  'pr-link',
  'file-history-snapshot',
  'attribution-snapshot',
  'speculation-accept',
  'mode',
  'worktree-state',
  'context-collapse-commit',
  'context-collapse-snapshot',
])

class Project {
  currentSessionTag: string | undefined
  currentSessionTitle: string | undefined
  currentSessionAgentName: string | undefined
  currentSessionAgentColor: string | undefined
  currentSessionLastPrompt: string | undefined
  currentSessionChainLeaf: UUID | undefined
  currentSessionAgentSetting: string | undefined
  currentSessionMode: 'coordinator' | 'normal' | undefined
  currentSessionWorktree: PersistedWorktreeSession | null | undefined
  currentSessionPrNumber: number | undefined
  currentSessionPrUrl: string | undefined
  currentSessionPrRepository: string | undefined

  sessionFile: string | null = null
  private pendingEntries: Entry[] = []
  private remoteIngressUrl: string | null = null
  private internalEventWriter: InternalEventWriter | null = null
  private internalEventReader: InternalEventReader | null = null
  private internalSubagentEventReader: InternalEventReader | null = null
  private pendingWriteCount: number = 0
  private flushResolvers: Array<() => void> = []
  private writeQueues = new Map<
    string,
    Array<{ line: string; resolve: () => void }>
  >()
  private settleState = new Map<
    string,
    {
      file: string
      entry: Entry
      lastLine: string
      semanticLine: string
      creationOrdinal?: string
      queued?: { line: string; resolve: () => void }
    }
  >()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private activeDrain: Promise<void> | null = null
  private FLUSH_INTERVAL_MS = 100
  private readonly MAX_CHUNK_BYTES = 100 * 1024 * 1024
  private fileWriteChain: Promise<unknown> = Promise.resolve()

  constructor() {}

  _resetFlushState(): void {
    this.settleState = new Map()
    this.pendingWriteCount = 0
    this.flushResolvers = []
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.activeDrain = null
    this.fileWriteChain = Promise.resolve()
    this.writeQueues = new Map()
  }

  private incrementPendingWrites(): void {
    this.pendingWriteCount++
  }

  private decrementPendingWrites(): void {
    this.pendingWriteCount--
    if (this.pendingWriteCount === 0) {
      for (const resolve of this.flushResolvers) {
        resolve()
      }
      this.flushResolvers = []
    }
  }

  private async trackWrite<T>(fn: () => Promise<T>): Promise<T> {
    this.incrementPendingWrites()
    try {
      return await fn()
    } finally {
      this.decrementPendingWrites()
    }
  }

  private insertChainQueue: Promise<unknown> = Promise.resolve()
  private serializeInsert<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.insertChainQueue.then(
      () => fn(),
      () => fn(),
    )
    this.insertChainQueue = run.catch(() => {})
    return run
  }

  private serializeWrite<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.fileWriteChain.then(
      () => fn(),
      () => fn(),
    )
    this.fileWriteChain = run.catch(() => {})
    return run
  }

  private enqueueWrite(filePath: string, entry: Entry): Promise<void> {
    return this.enqueueRawLine(
      filePath,
      encodeTranscriptLine(filePath, entry as Record<string, unknown>).line,
    )
  }

  private enqueueRawLine(
    filePath: string,
    line: string,
    capture?: (item: { line: string; resolve: () => void }) => void,
  ): Promise<void> {
    return new Promise<void>(resolve => {
      let queue = this.writeQueues.get(filePath)
      if (!queue) {
        queue = []
        this.writeQueues.set(filePath, queue)
      }
      const item = { line, resolve }
      queue.push(item)
      capture?.(item)
      this.scheduleDrain()
    })
  }

  private drainFailureStreak = 0

  private scheduleDrain(): void {
    if (this.flushTimer) {
      return
    }
    const interval = Math.min(this.FLUSH_INTERVAL_MS * 2 ** this.drainFailureStreak, 5_000)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      this.runDrain().catch(() => {})
    }, interval)
  }

  private runDrain(): Promise<void> {
    const run = this.drainWriteQueue()
    this.activeDrain = run
    return run
      .then(
        () => {
          this.drainFailureStreak = 0
          setStoreHealth({ failing: false, sentence: null })
        },
        err => {
          if (this.drainFailureStreak === 0) logError(err)
          this.drainFailureStreak++
          if (this.drainFailureStreak >= 2) {
            setStoreHealth({ failing: true, sentence: err instanceof Error ? err.message : String(err) })
          }
          throw err
        },
      )
      .finally(() => {
        if (this.activeDrain === run) this.activeDrain = null
        if (this.writeQueues.size > 0) {
          this.scheduleDrain()
        }
      })
  }

  private async appendToFile(filePath: string, data: string): Promise<void> {
    try {
      await fsAppendFile(filePath, data, { mode: 0o600 })
    } catch {
      try {
        await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
        await fsAppendFile(filePath, data, { mode: 0o600 })
      } catch (error) {
        throw describeTranscriptStoreFailure(filePath, error)
      }
    }
  }

  private drainWriteQueue(): Promise<void> {
    return this.serializeWrite(() => this._drainWriteQueueInner())
  }

  private async _drainWriteQueueInner(): Promise<void> {
    const failures: Array<{ filePath: string; error: unknown }> = []
    for (const [filePath, queue] of this.writeQueues) {
      if (queue.length === 0) {
        continue
      }
      const batch = queue.splice(0)

      let landed = 0

      try {
        let content = ''
        let pending = 0

        for (const { line } of batch) {
          if (content.length + line.length >= this.MAX_CHUNK_BYTES) {
            await this.appendToFile(filePath, content)
            for (let i = landed; i < landed + pending; i++) {
              batch[i]!.resolve()
            }
            landed += pending
            pending = 0
            content = ''
          }

          content += line
          pending++
        }

        if (content.length > 0) {
          await this.appendToFile(filePath, content)
          for (let i = landed; i < landed + pending; i++) {
            batch[i]!.resolve()
          }
          landed += pending
        }
      } catch (err) {
        queue.unshift(...batch.slice(landed))
        failures.push({ filePath, error: err })
      }
    }

    for (const [filePath, queue] of this.writeQueues) {
      if (queue.length === 0) {
        this.writeQueues.delete(filePath)
      }
    }

    if (failures.length === 1) throw failures[0]!.error
    if (failures.length > 1) {
      const detail = failures
        .map(({ filePath, error }) => `${basename(filePath)}: ${error instanceof Error ? error.message : String(error)}`)
        .join('; ')
      throw new Error(`${failures.length} transcript files could not be written — ${detail}`)
    }
  }

  resetSessionFile(): void {
    this.sessionFile = null
    this.pendingEntries = []
    this.settleState = new Map()
    this.currentSessionChainLeaf = undefined
  }

  reAppendSessionMetadata(skipTitleRefresh = false): void {
    if (!this.sessionFile) return
    const sessionId = getSessionId() as UUID
    if (!sessionId) return

    const tail = readFileTailSync(this.sessionFile)

    const isMetaLine = (l: string, metaKind: string): boolean =>
      l.startsWith('{"schemaVersion":') && l.includes(`"metaKind":"${metaKind}"`)
    const tailLines = tail.split('\n')
    if (!skipTitleRefresh) {
      const titleLine = tailLines.findLast((l: string) =>
        isMetaLine(l, 'custom-title'),
      )
      if (titleLine) {
        const tailTitle = extractLastJsonStringField(titleLine, 'customTitle')
        if (tailTitle !== undefined) {
          this.currentSessionTitle = tailTitle || undefined
        }
      }
    }
    const tagLine = tailLines.findLast((l: string) => isMetaLine(l, 'tag'))
    if (tagLine) {
      const tailTag = extractLastJsonStringField(tagLine, 'tag')
      if (tailTag !== undefined) {
        this.currentSessionTag = tailTag || undefined
      }
    }

    if (this.currentSessionLastPrompt) {
      appendEntryToFile(this.sessionFile, {
        type: 'last-prompt',
        lastPrompt: this.currentSessionLastPrompt,
        sessionId,
      })
    }
    if (this.currentSessionTitle) {
      appendEntryToFile(this.sessionFile, {
        type: 'custom-title',
        customTitle: this.currentSessionTitle,
        sessionId,
      })
    }
    if (this.currentSessionTag) {
      appendEntryToFile(this.sessionFile, {
        type: 'tag',
        tag: this.currentSessionTag,
        sessionId,
      })
    }
    if (this.currentSessionAgentName) {
      appendEntryToFile(this.sessionFile, {
        type: 'agent-name',
        agentName: this.currentSessionAgentName,
        sessionId,
      })
    }
    if (this.currentSessionAgentColor) {
      appendEntryToFile(this.sessionFile, {
        type: 'agent-color',
        agentColor: this.currentSessionAgentColor,
        sessionId,
      })
    }
    if (this.currentSessionAgentSetting) {
      appendEntryToFile(this.sessionFile, {
        type: 'agent-setting',
        agentSetting: this.currentSessionAgentSetting,
        sessionId,
      })
    }
    if (this.currentSessionMode) {
      appendEntryToFile(this.sessionFile, {
        type: 'mode',
        mode: this.currentSessionMode,
        sessionId,
      })
    }
    if (this.currentSessionWorktree !== undefined) {
      appendEntryToFile(this.sessionFile, {
        type: 'worktree-state',
        worktreeSession: this.currentSessionWorktree,
        sessionId,
      })
    }
    if (
      this.currentSessionPrNumber !== undefined &&
      this.currentSessionPrUrl &&
      this.currentSessionPrRepository
    ) {
      appendEntryToFile(this.sessionFile, {
        type: 'pr-link',
        sessionId,
        prNumber: this.currentSessionPrNumber,
        prUrl: this.currentSessionPrUrl,
        prRepository: this.currentSessionPrRepository,
        timestamp: new Date().toISOString(),
      })
    }
  }

  async flush(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer)
      this.flushTimer = null
    }
    if (this.activeDrain) {
      await this.activeDrain
    }
    await this.runDrain()

    if (this.pendingWriteCount === 0) {
      return
    }
    return new Promise<void>(resolve => {
      this.flushResolvers.push(resolve)
    })
  }

  async removeMessageByUuid(targetUuid: UUID): Promise<void> {
    return this.trackWrite(() =>
      this.serializeWrite(async () => {
        if (this.sessionFile === null) return
        await this._drainWriteQueueInner()
        try {
          let fileSize = 0
          const fd = openSync(this.sessionFile, 'r+')
          try {
            const { size } = fstatSync(fd)
            fileSize = size
            if (size === 0) return

            const chunkLen = Math.min(size, LITE_READ_BUF_SIZE)
            const tailStart = size - chunkLen
            const buf = Buffer.allocUnsafe(chunkLen)
            const bytesRead = readSync(fd, buf, 0, chunkLen, tailStart)
            const tail = buf.subarray(0, bytesRead)

            const needle = `"uuid":"${targetUuid}"`
            const matchIdx = tail.lastIndexOf(needle)

            if (matchIdx >= 0) {
              const prevNl = tail.lastIndexOf(0x0a, matchIdx)
              if (prevNl >= 0 || tailStart === 0) {
                const lineStart = prevNl + 1
                const nextNl = tail.indexOf(0x0a, matchIdx + needle.length)
                const lineEnd = nextNl >= 0 ? nextNl + 1 : bytesRead

                const absLineStart = tailStart + lineStart
                const afterLen = bytesRead - lineEnd
                ftruncateSync(fd, absLineStart)
                if (afterLen > 0) {
                  writeSync(fd, tail, lineEnd, afterLen, absLineStart)
                }
                return
              }
            }
          } finally {
            closeSync(fd)
          }

          if (fileSize > MAX_TOMBSTONE_REWRITE_BYTES) {
            logForDebugging(
              `Skipping tombstone removal: session file too large (${formatFileSize(fileSize)})`,
              { level: 'warn' },
            )
            return
          }
          const content = readFileSync(this.sessionFile, { encoding: 'utf-8' })
          const lines = content.split('\n').filter((line: string) => {
            if (!line.trim()) return true
            try {
              const entry = jsonParse(line)
              return entry.uuid !== targetUuid
            } catch {
              return true
            }
          })
          writeFileSync(this.sessionFile, lines.join('\n'), {
            encoding: 'utf8',
          })
        } catch {
        }
      }),
    )
  }

  private shouldSkipPersistence(): boolean {
    const allowTestPersistence = isEnvTruthy(
      process.env.TEST_ENABLE_SESSION_PERSISTENCE,
    )
    return (
      (getNodeEnv() === 'test' && !allowTestPersistence) ||
      getSettings_DEPRECATED()?.cleanupPeriodDays === 0 ||
      isSessionPersistenceDisabled() ||
      isEnvTruthy(process.env.MERCURY_SKIP_PROMPT_HISTORY)
    )
  }

  private async materializeSessionFile(): Promise<void> {
    if (this.shouldSkipPersistence()) return
    this.ensureCurrentSessionFile()
    this.reAppendSessionMetadata()
    if (this.pendingEntries.length > 0) {
      const buffered = this.pendingEntries
      this.pendingEntries = []
      for (const entry of buffered) {
        await this.appendEntry(entry)
      }
    }
  }

  async insertMessageChain(
    messages: Transcript,
    isSidechain: boolean = false,
    agentId?: string,
    startingParentUuid?: UUID | null,
    teamInfo?: { teamName?: string; agentName?: string },
    preferLiveLeaf: boolean = false,
  ) {
    return this.trackWrite(() => this.serializeInsert(async () => {
      let parentUuid: UUID | null = startingParentUuid ?? null
      if (!isSidechain && (preferLiveLeaf || parentUuid === null)) {
        const leaf = this.currentSessionChainLeaf
        if (leaf !== undefined) parentUuid = leaf
      }

      if (
        this.sessionFile === null &&
        messages.some(m => m.type === 'user' || m.type === 'assistant')
      ) {
        await this.materializeSessionFile()
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
          effectiveParentUuid = message.sourceToolAssistantUUID
        }

        const transcriptMessage: TranscriptMessage = {
          parentUuid: isCompactBoundary ? null : effectiveParentUuid,
          logicalParentUuid: isCompactBoundary
            ? (parentUuid ?? undefined)
            : undefined,
          isSidechain,
          teamName: teamInfo?.teamName,
          agentName: teamInfo?.agentName,
          promptId:
            message.type === 'user' ? (getPromptId() ?? undefined) : undefined,
          agentId,
          ...message,
          entrypoint: getEntrypoint(),
          cwd: getCwd(),
          sessionId,
          version: VERSION,
          gitBranch,
          slug,
        }
        await this.appendEntry(transcriptMessage)
        if (isChainParticipant(message)) {
          parentUuid = message.uuid
          if (!isSidechain) this.currentSessionChainLeaf = message.uuid as UUID
        }
      }

      if (!isSidechain) {
        const text = getFirstMeaningfulUserMessageTextContent(messages)
        if (text) {
          const flat = text.replace(/\n/g, ' ').trim()
          this.currentSessionLastPrompt =
            flat.length > 200 ? flat.slice(0, 200).trim() + '…' : flat
        }
      }
    }))
  }

  async insertFileHistorySnapshot(
    messageId: UUID,
    snapshot: FileHistorySnapshot,
    isSnapshotUpdate: boolean,
  ) {
    return this.trackWrite(async () => {
      const fileHistoryMessage: FileHistorySnapshotMessage = {
        type: 'file-history-snapshot',
        messageId,
        snapshot,
        isSnapshotUpdate,
      }
      await this.appendEntry(fileHistoryMessage)
    })
  }

  async insertQueueOperation(queueOp: QueueOperationMessage) {
    return this.trackWrite(async () => {
      await this.appendEntry(queueOp)
    })
  }

  async insertAttributionSnapshot(snapshot: AttributionSnapshotMessage) {
    return this.trackWrite(async () => {
      await this.appendEntry(snapshot)
    })
  }

  async insertContentReplacement(
    replacements: ContentReplacementRecord[],
    agentId?: AgentId,
  ) {
    return this.trackWrite(async () => {
      const entry: ContentReplacementEntry = {
        type: 'content-replacement',
        sessionId: getSessionId() as UUID,
        agentId,
        replacements,
      }
      await this.appendEntry(entry)
    })
  }

  async appendEntry(entry: Entry, sessionId: UUID = getSessionId() as UUID) {
    if (this.shouldSkipPersistence()) {
      return
    }

    const currentSessionId = getSessionId() as UUID
    const isCurrentSession = sessionId === currentSessionId

    let sessionFile: string
    if (isCurrentSession) {
      if (this.sessionFile === null) {
        this.pendingEntries.push(entry)
        return
      }
      sessionFile = this.sessionFile
    } else {
      const existing = await this.getExistingSessionFile(sessionId)
      if (!existing) {
        logError(
          new Error(
            `appendEntry: session file not found for other session ${sessionId}`,
          ),
        )
        return
      }
      sessionFile = existing
    }

    if (ALWAYS_APPEND_KINDS.has(entry.type)) {
      void this.enqueueWrite(sessionFile, entry)
      return
    }

    if (entry.type === 'content-replacement') {
      const targetFile = entry.agentId
        ? (agentTranscriptDestinations.get(entry.agentId) ??
          getAgentTranscriptPath(entry.agentId))
        : sessionFile
      void this.enqueueWrite(targetFile, entry)
      return
    }

    if (entry.type === 'queue-operation') {
      void this.enqueueWrite(sessionFile, entry)
      return
    }

    const message = entry as TranscriptMessage
    const isAgentSidechain =
      message.isSidechain && message.agentId !== undefined
    const targetFile = isAgentSidechain
      ? (agentTranscriptDestinations.get(message.agentId!) ??
        getAgentTranscriptPath(asAgentId(message.agentId!)))
      : sessionFile

    if (isAgentSidechain) {
      const agentSet = await getAgentFileMessages(targetFile)
      if (!agentSet.has(message.uuid)) {
        agentSet.add(message.uuid)
        this.enqueueMessageWrite(targetFile, message)
      }
      return
    }

    const messageSet = await getSessionMessages(sessionId)
    if (!messageSet.has(message.uuid)) {
      this.enqueueMessageWrite(targetFile, message)
      messageSet.add(message.uuid)

      if (isTranscriptMessage(message)) {
        await this.persistToRemote(sessionId, message)
      }
    }
  }

  private enqueueMessageWrite(file: string, entry: Entry): void {
    const encoded = encodeTranscriptLine(file, entry as Record<string, unknown>)
    const line = encoded.line
    if (entry.type === 'user' || entry.type === 'assistant') {
      const state: {
        file: string
        entry: Entry
        lastLine: string
        semanticLine: string
        creationOrdinal?: string
        queued?: { line: string; resolve: () => void }
      } = {
        file,
        entry,
        lastLine: line,
        semanticLine: jsonStringify(entry) + '\n',
        ...(encoded.record
          ? { creationOrdinal: String(encoded.record.creationOrdinal) }
          : {}),
      }
      void this.enqueueRawLine(file, line, item => {
        state.queued = item
      })
      this.settleState.set(entry.uuid, state)
    } else {
      void this.enqueueRawLine(file, line)
    }
  }

  async settleMessage(message: Message): Promise<void> {
    if (this.shouldSkipPersistence()) return
    const cached = this.settleState.get(message.uuid)
    if (!cached) return
    const [cleaned] = cleanMessagesForLogging([message])
    if (!cleaned) return
    const settled = { ...cached.entry, ...cleaned } as Entry
    const semanticLine = jsonStringify(settled) + '\n'
    if (semanticLine === cached.semanticLine) return
    const line = encodeTranscriptLine(
      cached.file,
      settled as Record<string, unknown>,
      {
        ...(cached.creationOrdinal
          ? { settleCreationOrdinal: cached.creationOrdinal }
          : {}),
      },
    ).line
    cached.entry = settled
    cached.semanticLine = semanticLine
    cached.lastLine = line
    const queue = this.writeQueues.get(cached.file)
    if (cached.queued && queue && queue.includes(cached.queued)) {
      cached.queued.line = line
      return
    }
    cached.queued = undefined
    await this.enqueueRawLine(cached.file, line)
  }

  private ensureCurrentSessionFile(): string {
    if (this.sessionFile === null) {
      this.sessionFile = getTranscriptPath()
    }
    return this.sessionFile
  }

  private existingSessionFiles = new Map<string, string>()
  private async getExistingSessionFile(
    sessionId: UUID,
  ): Promise<string | null> {
    const cached = this.existingSessionFiles.get(sessionId)
    if (cached) return cached

    const targetFile = getTranscriptPathForSession(sessionId)
    try {
      await stat(targetFile)
      this.existingSessionFiles.set(sessionId, targetFile)
      return targetFile
    } catch (e) {
      if (isFsInaccessible(e)) return null
      throw e
    }
  }

  private async persistToRemote(sessionId: UUID, entry: TranscriptMessage) {
    if (isShuttingDown()) {
      return
    }

    if (this.internalEventWriter) {
      try {
        await this.internalEventWriter(
          'transcript',
          entry as unknown as Record<string, unknown>,
          {
            ...(isCompactBoundaryMessage(entry) && { isCompaction: true }),
            ...(entry.agentId && { agentId: entry.agentId }),
          },
        )
      } catch {
        logForDebugging('Failed to write transcript as internal event')
      }
      return
    }
  }

  setRemoteIngressUrl(url: string): void {
    this.remoteIngressUrl = url
    logForDebugging(`Remote persistence enabled with URL: ${url}`)
    if (url) {
      this.FLUSH_INTERVAL_MS = REMOTE_FLUSH_INTERVAL_MS
    }
  }

  setInternalEventWriter(writer: InternalEventWriter): void {
    this.internalEventWriter = writer
    logForDebugging(
      'CCR v2 internal event writer registered for transcript persistence',
    )
    this.FLUSH_INTERVAL_MS = REMOTE_FLUSH_INTERVAL_MS
  }

  setInternalEventReader(reader: InternalEventReader): void {
    this.internalEventReader = reader
    logForDebugging(
      'CCR v2 internal event reader registered for session resume',
    )
  }

  setInternalSubagentEventReader(reader: InternalEventReader): void {
    this.internalSubagentEventReader = reader
    logForDebugging(
      'CCR v2 subagent event reader registered for session resume',
    )
  }

  getInternalEventReader(): InternalEventReader | null {
    return this.internalEventReader
  }

  getInternalSubagentEventReader(): InternalEventReader | null {
    return this.internalSubagentEventReader
  }
}

export type TeamInfo = {
  teamName?: string
  agentName?: string
}

function readFileTailSync(fullPath: string): string {
  let fd: number | undefined
  try {
    fd = openSync(fullPath, 'r')
    const st = fstatSync(fd)
    const tailOffset = Math.max(0, st.size - LITE_READ_BUF_SIZE)
    const buf = Buffer.allocUnsafe(
      Math.min(LITE_READ_BUF_SIZE, st.size - tailOffset),
    )
    const bytesRead = readSync(fd, buf, 0, buf.length, tailOffset)
    return buf.toString('utf8', 0, bytesRead)
  } catch {
    return ''
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
      }
    }
  }
}

export function appendEntryToFile(
  fullPath: string,
  entry: Record<string, unknown>,
): void {
  const fs = getFsImplementation()
  const line = encodeTranscriptLine(fullPath, entry).line
  try {
    fs.appendFileSync(fullPath, line, { mode: 0o600 })
  } catch {
    try {
      fs.mkdirSync(dirname(fullPath), { mode: 0o700 })
      fs.appendFileSync(fullPath, line, { mode: 0o600 })
    } catch (error) {
      throw describeTranscriptStoreFailure(fullPath, error)
    }
  }
}

function describeTranscriptStoreFailure(filePath: string, error: unknown): Error {
  const raw = error instanceof Error ? error.message : String(error)
  return new Error(
    `the session transcript store is unwritable (${dirname(filePath)}): ${raw}. ` +
      `Repair the directory, or run with --no-session-persistence to skip transcripts for this run.`,
    { cause: error },
  )
}
