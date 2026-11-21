import type { UUID } from 'crypto'
import { scheduler } from 'node:timers/promises'
import { historyHead, sealedExtents, historyIndex } from './historyParts.js'
import { transcriptLineBytes } from './transcriptBytes.js'
import { dirname } from 'path'
import memoize from 'lodash-es/memoize.js'
import { flagEnv } from '../../substrate/flagRegistry.js'
import { getSessionId, isSessionPersistenceDisabled } from '../../bootstrap/state.js'
import { type AgentId, asAgentId } from '../../types/ids.js'
import type {
  ContentReplacementEntry,
  Entry,
  FileHistorySnapshotEntry,
  PersistedWorktreeSession,
  TranscriptMessage,
} from '../../types/logs.js'
import type { AttributionSnapshotEntry } from '../../types/logs.js'
import type { Message } from '../../types/message.js'
import { storageRowPolicy } from '../../rows/storage.js'
import { SessionMeta, SESSION_META_COMPAT_FIELDS } from './sessionMeta.js'
import { readTranscriptRecordIds, readTranscriptTailSync } from './transcriptReader.js'
import type { QueueOperationMessage } from '../../types/messageQueueTypes.js'
import { registerCleanup } from '../cleanupRegistry.js'
import { registerExitCliffSeam } from '../exitCliffDrain.js'
import { isEnvTruthy } from '../envUtils.js'
import type { FileHistorySnapshot } from '../../types/fileHistory.js'
import { logForDebugging } from '../debug.js'
import { errorMessage, getErrnoCode } from '../errors.js'
import { getFsImplementation } from '../fsOperations.js'
import { logError } from '../log.js'
import { LITE_READ_BUF_SIZE } from '../sessionStoragePortable.js'
import { getInitialSettings } from '../settings/settings.js'
import type { ContentReplacementRecord } from '../toolResultStorage.js'
import { cleanForTranscript, type Transcript } from './chain.js'
import { sessionFilePath } from './loading.js'
import {
  getAgentTranscriptPath,
  getNodeEnv,
  getTranscriptPath,
  isChainParticipant,
} from './paths.js'
import {
  encodeTranscriptLine,
  resetTranscriptFormatCacheForTesting,
} from './vnext.js'
import { ChainPart } from './writer/chainLinks.js'
import { FilesPart } from './writer/files.js'
import { QueuePart } from './writer/queue.js'
import { RemovePart } from './writer/remove.js'
import { SettlePart } from './writer/settle.js'
import { describeTranscriptStoreFailure, setStoreHealth } from './writer/storeHealth.js'
import { passedOver } from '../passedOver.js'
export { describeTranscriptStoreFailure, subscribeTranscriptStoreHealth, transcriptStoreHealth } from './writer/storeHealth.js'

const sessionRecordIds = new Map<string, Set<UUID>>()

export const getSessionMessages = memoize(
  async (sessionId: UUID): Promise<Set<UUID>> => {
    const path = sessionFilePath(sessionId)
    let known = sessionRecordIds.get(path)
    if (known === undefined) sessionRecordIds.set(path, (known = new Set()))
    for (const id of await readTranscriptRecordIds(path)) known.add(id as UUID)
    return known
  },
  (sessionId: UUID) => sessionId,
)

const agentTranscriptDestinations = new Map<string, string>()

export function registerAgentTranscriptDestination(
  agentId: string,
  filePath: string,
): void {
  agentTranscriptDestinations.set(agentId, filePath)
}

const reportedAgentReadFailures = new Set<string>()

const getAgentFileMessages = memoize(
  async (filePath: string): Promise<Set<string>> => {
    try {
      const head = historyHead(filePath)
      const set = new Set<string>()
      for (const part of sealedExtents(head)) for (const [, id] of historyIndex(part)) if (id !== null) set.add(id)
      let added = 0
      for (const row of transcriptLineBytes(filePath, { end: head.end })) {
        added += row.length
        if (added >= 1024 * 1024) { await scheduler.yield(); added = 0 }
        try {
          const id = JSON.parse(row.toString('utf8'))?.annotations?.uuid
          if (typeof id === 'string') set.add(id)
        } catch (error) { passedOver(error) }
      }
      return set
    } catch (error) {
      const code = getErrnoCode(error)
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        logForDebugging(`agent transcript read failed for ${filePath} (${code ?? 'unknown'})`, { level: 'error' })
        getAgentFileMessages.cache.delete(filePath)
        if (!reportedAgentReadFailures.has(filePath)) {
          reportedAgentReadFailures.add(filePath)
          setStoreHealth({
            failing: true,
            sentence: `Agent transcript at ${filePath} could not be read (${errorMessage(error)}), so entries may be duplicated — restore read permission on the file.`,
          })
        }
      }
      return new Set()
    }

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
        } catch (error) {
          logError(new Error(`the session's title and tag rows could not be restamped into its transcript at exit, so it can list without its title: ${errorMessage(error)}`))
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
  reportedAgentReadFailures.clear()
  project = null
}

export function setSessionFileForTesting(path: string): void {
  getProject().sessionFile = path
}

let transcriptMessagesVisited = 0
export function getTranscriptMessagesVisited(): number {
  return transcriptMessagesVisited
}

function partitionUnwritten(
  messages: Transcript,
  onDisk: ReadonlySet<UUID>,
  parentHint: UUID | undefined,
): { unwritten: Transcript; parent: UUID | undefined } {
  const unwritten: Transcript = []
  let parent = parentHint
  for (const m of messages) {
    if (!onDisk.has(m.uuid as UUID)) unwritten.push(m)
    else if (unwritten.length === 0 && isChainParticipant(m)) parent = m.uuid as UUID
  }
  return { unwritten, parent }
}

function recordedLeafBefore(
  allMessages: readonly Message[] | undefined,
  unwritten: Transcript,
  onDisk: ReadonlySet<UUID>,
): UUID | undefined {
  if (allMessages === undefined || unwritten.length === 0) return undefined
  const pending = new Set(unwritten.map(m => m.uuid))
  let leaf: UUID | undefined
  for (const m of allMessages) {
    if (pending.has(m.uuid)) break
    if (isChainParticipant(m) && onDisk.has(m.uuid as UUID)) leaf = m.uuid as UUID
  }
  return leaf
}

export async function recordTranscript(
  messages: Message[],
  startingParentUuidHint?: UUID,
  allMessages?: readonly Message[],
): Promise<UUID | null> {
  transcriptMessagesVisited += messages.length
  const cleanedMessages = cleanForTranscript(messages, allMessages)
  const messageSet = await getSessionMessages(getSessionId() as UUID)
  const partition = partitionUnwritten(cleanedMessages, messageSet, startingParentUuidHint)
  const newMessages = partition.unwritten
  const startingParentUuid = partition.parent ?? recordedLeafBefore(allMessages, newMessages, messageSet)
  const preferLiveLeaf = messageSet.size > 0
  if (newMessages.length > 0) {
    await getProject().insertMessageChain(
      newMessages,
      false,
      undefined,
      startingParentUuid,
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
    cleanForTranscript(messages),
    true,
    agentId,
    startingParentUuid,
  )
}

export function closeAgentTranscript(agentId: string): void {
  project?.closeTranscript(agentTranscriptDestinations.get(agentId) ?? getAgentTranscriptPath(asAgentId(agentId)))
}

export async function recordQueueOperation(queueOp: QueueOperationMessage) {
  await getProject().insertQueueOperation(queueOp)
}

export async function recordTurnStart(turnId: string): Promise<void> {
  await recordSessionRow(sessionId => ({ type: 'turn-start', sessionId, turnId }))
}

export async function recordTurnEnd(turnId: string, status: string): Promise<void> {
  await recordSessionRow(sessionId => ({ type: 'turn-end', sessionId, turnId, status }))
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
  snapshot: AttributionSnapshotEntry,
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

export function advisorSwitchOfSession(): boolean {
  return getProject().currentSessionAdvisor === true
}

export function swarmSwitchOfSession(): boolean {
  return getProject().currentSessionSwarm !== false
}

export function adoptResumedSessionFile(): void {
  const project = getProject()
  project.sessionFile = getTranscriptPath()
  project.reAppendSessionMetadata(true)
  project.currentSessionChainLeaf = undefined
}

async function recordSessionRow(row: (sessionId: UUID) => Entry): Promise<void> {
  const sessionId = getSessionId() as UUID
  if (!sessionId) return
  await getProject().appendEntry(row(sessionId))
}

export async function recordContextCollapseCommit(commit: {
  collapseId: string
  summaryUuid: string
  summaryContent: string
  summary: string
  firstArchivedUuid: string
  lastArchivedUuid: string
}): Promise<void> {
  await recordSessionRow(sessionId => ({ type: 'context-collapse-commit', sessionId, ...commit }))
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
  await recordSessionRow(sessionId => ({ type: 'context-collapse-snapshot', sessionId, ...snapshot }))
}

export async function flushSessionStorage(): Promise<void> {
  await getProject().flush()
}

class Project {
  currentSessionTag: string | undefined
  currentSessionTitle: string | undefined
  currentSessionAgentName: string | undefined
  currentSessionAgentColor: string | undefined
  currentSessionLastPrompt: string | undefined
  currentSessionChainLeaf: UUID | undefined
  private readonly chainPart = new ChainPart(this, {
    trackWrite: fn => this.queuePart.trackWrite(fn),
    serializeInsert: fn => this.queuePart.serializeInsert(fn),
    materializeSessionFile: () => this.filesPart.materializeSessionFile(),
  })
  currentSessionAgentSetting: string | undefined
  currentSessionMode: 'coordinator' | 'normal' | undefined
  currentSessionAdvisor: boolean | undefined
  currentSessionSwarm: boolean | undefined
  currentSessionModel: string | undefined
  currentSessionWorktree: PersistedWorktreeSession | null | undefined
  currentSessionPrNumber: number | undefined
  currentSessionPrUrl: string | undefined
  currentSessionPrRepository: string | undefined

  sessionFile: string | null = null
  private readonly filesPart = new FilesPart(this, { shouldSkipPersistence: () => this.shouldSkipPersistence() })
  private readonly queuePart = new QueuePart()
  private readonly settlePart = new SettlePart({
    enqueueRawLine: (...args) => this.queuePart.enqueueRawLine(...args),
    writeQueues: () => this.queuePart.writeQueues,
    shouldSkipPersistence: () => this.shouldSkipPersistence(),
  })
  private readonly removePart = new RemovePart(this, {
    trackWrite: fn => this.queuePart.trackWrite(fn),
    serializeWrite: fn => this.queuePart.serializeWrite(fn),
    _drainWriteQueueInner: () => this.queuePart._drainWriteQueueInner(),
  })

  readonly metadata = new SessionMeta({
    currentId: () => getSessionId() as UUID,
    currentFile: () => this.sessionFile,
    append: appendEntryToFile,
    tail: path => readTranscriptTailSync(path, LITE_READ_BUF_SIZE),
  })

  constructor() {
    for (const [name, field] of Object.entries(SESSION_META_COMPAT_FIELDS)) {
      Object.defineProperty(this, name, {
        enumerable: true,
        configurable: true,
        get: () => this.metadata.fields[field],
        set: value => { (this.metadata.fields as Record<string, unknown>)[field] = value },
      })
    }
  }

  _resetFlushState(): void {
    this.settlePart.resetSettled()
    this.queuePart._resetFlushState()
  }

  resetSessionFile(): void {
    this.sessionFile = null
    this.filesPart.pendingEntries = []
    this.settlePart.resetSettled()
    this.currentSessionChainLeaf = undefined
  }

  reAppendSessionMetadata(skipTitleRefresh = false): void {
    this.metadata.restamp(skipTitleRefresh)
  }

  flush(): Promise<void> {
    return this.queuePart.flush()
  }

  removeMessageByUuid(targetUuid: UUID): Promise<void> {
    return this.removePart.removeMessageByUuid(targetUuid)
  }

  private shouldSkipPersistence(): boolean {
    return (
      getNodeEnv() === 'test' ||
      getInitialSettings()?.records?.retentionDays === 0 ||
      isSessionPersistenceDisabled() ||
      isEnvTruthy(flagEnv('MERCURY_SKIP_PROMPT_HISTORY'))
    )
  }

  insertMessageChain(
    messages: Transcript,
    isSidechain: boolean = false,
    agentId?: string,
    startingParentUuid?: UUID | null,
    preferLiveLeaf: boolean = false,
  ) {
    return this.chainPart.insertMessageChain(messages, isSidechain, agentId, startingParentUuid, preferLiveLeaf)
  }

  private insertTracked(entry: Entry): Promise<void> {
    return this.queuePart.trackWrite(() => this.appendEntry(entry))
  }

  async insertFileHistorySnapshot(
    messageId: UUID,
    snapshot: FileHistorySnapshot,
    isSnapshotUpdate: boolean,
  ) {
    const fileHistoryMessage: FileHistorySnapshotEntry = { type: 'file-history-snapshot', messageId, snapshot, isSnapshotUpdate }
    return this.insertTracked(fileHistoryMessage)
  }

  async insertQueueOperation(queueOp: QueueOperationMessage) {
    return this.insertTracked(queueOp)
  }

  async insertAttributionSnapshot(snapshot: AttributionSnapshotEntry) {
    return this.insertTracked(snapshot)
  }

  async insertContentReplacement(
    replacements: ContentReplacementRecord[],
    agentId?: AgentId,
  ) {
    const entry: ContentReplacementEntry = { type: 'content-replacement', sessionId: getSessionId() as UUID, agentId, replacements }
    return this.insertTracked(entry)
  }

  async appendEntry(entry: Entry, sessionId: UUID = getSessionId() as UUID) {
    if (this.shouldSkipPersistence()) {
      return
    }
    const sessionFile = await this.filesPart.sessionFileFor(sessionId, entry)
    if (sessionFile === null) return

    if (storageRowPolicy(entry.type)?.write === 'append') {
      void this.queuePart.enqueueWrite(sessionFile, entry)
      return
    }

    if (entry.type === 'content-replacement') {
      const targetFile = entry.agentId
        ? (agentTranscriptDestinations.get(entry.agentId) ??
          getAgentTranscriptPath(entry.agentId))
        : sessionFile
      void this.queuePart.enqueueWrite(targetFile, entry)
      return
    }

    if (entry.type === 'queue-operation') {
      void this.queuePart.enqueueWrite(sessionFile, entry)
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
        this.settlePart.enqueueMessageWrite(targetFile, message)
      }
      return
    }

    const messageSet = await getSessionMessages(sessionId)
    if (!messageSet.has(message.uuid)) {
      this.settlePart.enqueueMessageWrite(targetFile, message)
      messageSet.add(message.uuid)
    }
  }

  settleMessage(message: Message): Promise<void> {
    return this.settlePart.settleMessage(message)
  }

  closeTranscript(file: string): void {
    this.settlePart.closeTranscript(file)
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

