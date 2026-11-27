import type { UUID } from 'crypto'
import { dirname } from 'path'
import memoize from 'lodash-es/memoize.js'
import { flagEnv } from '../../platform/substrate/flagRegistry.js'
import { getSessionId, isSessionPersistenceDisabled } from '../../boot/process-state/processState.js'
import { type AgentId, asAgentId } from './ids.js'
import type {
  ContentReplacementEntry,
  Entry,
  FileHistorySnapshotEntry,
  PersistedWorktreeSession,
  TranscriptMessage,
} from './transcriptEntries.js'
import type { Message } from '../../engine/message-shapes/message.js'
import { isFoldBoundaryMessage } from '../../engine/message-shapes/systemMessages.js'
import { storageRowPolicy } from '../../engine/rows/storage.js'
import { SessionMeta, SESSION_META_COMPAT_FIELDS } from './sessionMeta.js'
import { readTranscriptRecordIds, readTranscriptTailSync } from './transcriptReader.js'
import type { QueueOperationMessage } from '../../screen/composer/input-core/messageQueueTypes.js'
import { registerCleanup } from '../../platform/processes/cleanupRegistry.js'
import { registerExitCliffSeam } from '../../platform/processes/exitCliffDrain.js'
import { isEnvTruthy } from '../../platform/environment/envUtils.js'
import type { FileHistorySnapshot } from './fileHistory.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { errorMessage, getErrnoCode } from '../../platform/errors/errors.js'
import { getFsImplementation } from '../../platform/files/fsOperations.js'
import { logError } from '../../platform/logs/errorLog.js'
import { LITE_READ_BUF_SIZE } from './sessionStoragePortable.js'
import { getInitialSettings } from '../../platform/settings/settings.js'
import type { ContentReplacementRecord } from '../../engine/tool-dispatch/toolResultStorage.js'
import { cleanForTranscript, type Transcript } from './chain.js'
import { sessionFilePath } from './loading.js'
import {
  getCrewmateTranscriptPath,
  getNodeEnv,
  getTranscriptPath,
  isChainParticipant,
} from './paths.js'
import { notifyStorageFile, subscribeStorageFile } from './fileWatch.js'
import {
  encodeTranscriptLine,
  resetTranscriptFormatCacheForTesting,
} from './vnext.js'
import { ChainPart } from './writer/chainLinks.js'
import { FilesPart } from './writer/files.js'
import { QueuePart } from './writer/queue.js'
import { SettlePart } from './writer/settle.js'
import { describeTranscriptStoreFailure, setStoreHealth } from './writer/storeHealth.js'
import { passedOver } from '../../platform/errors/passedOver.js'
export { describeTranscriptStoreFailure, subscribeTranscriptStoreHealth, transcriptStoreHealth } from './writer/storeHealth.js'

export function subscribeTranscriptFile(path: string, listener: () => void): () => void {
  return subscribeStorageFile(path, listener)
}

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

const crewmateTranscriptDestinations = new Map<string, string>()

export function registerCrewmateTranscriptDestination(
  agentId: string,
  filePath: string,
): void {
  crewmateTranscriptDestinations.set(agentId, filePath)
}

const reportedCrewmateReadFailures = new Set<string>()

const crewmateFileMessages = new Map<string, Set<string>>()

async function getCrewmateFileMessages(filePath: string): Promise<Set<string>> {
  const cached = crewmateFileMessages.get(filePath)
  if (cached !== undefined) return cached
  try {
    const set = await readTranscriptRecordIds(filePath)
    const known = crewmateFileMessages.get(filePath)
    if (known !== undefined) return known
    crewmateFileMessages.set(filePath, set)
    return set
  } catch (error) {
    const code = getErrnoCode(error)
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      logForDebugging(`agent transcript read failed for ${filePath} (${code ?? 'unknown'})`, { level: 'error' })
      if (!reportedCrewmateReadFailures.has(filePath)) {
        reportedCrewmateReadFailures.add(filePath)
        setStoreHealth({
          failing: true,
          sentence: `Agent transcript at ${filePath} could not be read (${errorMessage(error)}), so entries may be duplicated — restore read permission on the file.`,
        })
      }
    }
    return new Set()
  }
}

let project: Project | null = null
let cleanupRegistered = false

export function getProject(): Project {
  if (!project) {
    project = new Project()
    if (!cleanupRegistered) {
      cleanupRegistered = true
      registerCleanup(async () => {
        await project?.flush()
        try {
          project?.reAppendSessionMetadata()
        } catch (error) {
          logError(
            new Error(
              `the session's title and tag rows could not be restamped into its transcript at exit, so it can list without its title: ${errorMessage(error)}`,
            ),
          )
        }
      })
      registerExitCliffSeam({
        name: 'transcript-writer',
        phase: 1,
        settle: () => project?.flush() ?? Promise.resolve(),
      })
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
  reportedCrewmateReadFailures.clear()
  project = null
}

export function setSessionFileForTesting(path: string): void {
  getProject().sessionFile = path
}

let transcriptMessagesVisited = 0
export function getTranscriptMessagesVisited(): number {
  return transcriptMessagesVisited
}

function recordedBoundary(row: TranscriptMessage, recorded: ReadonlySet<string>): TranscriptMessage {
  if (!isFoldBoundaryMessage(row)) return row
  const segment = row.compactMetadata?.preservedSegment
  if (!Array.isArray(segment?.keptUuids)) return row
  const keptUuids = segment.keptUuids.filter(id => recorded.has(id))
  const headUuid = keptUuids[0], tailUuid = keptUuids.at(-1)
  const preservedSegment = headUuid && tailUuid ? { ...segment, headUuid, tailUuid, keptUuids } : undefined
  return { ...row, compactMetadata: { ...row.compactMetadata, preservedSegment } }
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

function findLastRecordedParent(
  allMessages: readonly Message[],
  unwritten: Transcript,
  onDisk: ReadonlySet<UUID>,
): UUID | undefined {
  const unwrittenIds = new Set<UUID>(unwritten.map(m => m.uuid))
  let parent: UUID | undefined
  for (const m of allMessages) {
    if (unwrittenIds.has(m.uuid)) break
    if (isChainParticipant(m) && onDisk.has(m.uuid)) {
      parent = m.uuid
    }
  }
  return parent
}

export async function recordTranscript(
  messages: Message[],
  startingParentUuidHint?: UUID,
  allMessages?: readonly Message[],
): Promise<UUID | null> {
  transcriptMessagesVisited += messages.length
  const cleaned = cleanForTranscript(messages, allMessages)
  const onDisk = await getSessionMessages(getSessionId())
  const { unwritten, parent } = partitionUnwritten(
    cleaned,
    onDisk,
    startingParentUuidHint,
  )
  const startingParentUuid =
    parent ??
    (allMessages && unwritten.length > 0
      ? findLastRecordedParent(allMessages, unwritten, onDisk)
      : undefined)
  const preferLiveLeaf = onDisk.size > 0
  const currentProject = getProject()
  if (unwritten.length > 0) {
    await currentProject.insertMessageChain(
      unwritten,
      false,
      undefined,
      startingParentUuid,
      preferLiveLeaf,
    )
  }
  for (let i = unwritten.length - 1; i >= 0; i--) {
    const m = unwritten[i]!
    if (isChainParticipant(m)) return m.uuid
  }
  if (preferLiveLeaf && currentProject.currentSessionChainLeaf !== undefined) {
    return currentProject.currentSessionChainLeaf
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
): Promise<void> {
  await getProject().insertMessageChain(
    cleanForTranscript(messages),
    true,
    agentId,
    startingParentUuid,
  )
}

export function closeCrewmateTranscript(agentId: string): void {
  const currentProject = peekProject()
  if (!currentProject) return
  const file =
    crewmateTranscriptDestinations.get(agentId) ??
    getCrewmateTranscriptPath(asAgentId(agentId))
  currentProject.closeTranscript(file)
}

export async function recordQueueOperation(queueOp: QueueOperationMessage): Promise<void> {
  await getProject().insertQueueOperation(queueOp)
}

export async function recordTurnStart(turnId: string): Promise<void> {
  await recordSessionRow(sessionId => ({ type: 'turn-start', sessionId, turnId }))
}

export async function recordTurnEnd(turnId: string, status: string): Promise<void> {
  await recordSessionRow(sessionId => ({ type: 'turn-end', sessionId, turnId, status }))
}

export async function recordFileHistorySnapshot(
  messageId: UUID,
  snapshot: FileHistorySnapshot,
  isSnapshotUpdate: boolean,
): Promise<void> {
  await getProject().insertFileHistorySnapshot(
    messageId,
    snapshot,
    isSnapshotUpdate,
  )
}

export async function recordContentReplacement(
  replacements: ContentReplacementRecord[],
  agentId?: AgentId,
): Promise<void> {
  await getProject().insertContentReplacement(replacements, agentId)
}

export async function resetSessionFilePointer(): Promise<void> {
  getProject().resetSessionFile()
}

export function advisorSwitchOfSession(): boolean {
  return getProject().currentSessionAdvisor === true
}

export function swarmSwitchOfSession(): boolean {
  return getProject().currentSessionSwarm !== false
}

export function adoptResumedSessionFile(): void {
  const currentProject = getProject()
  currentProject.sessionFile = getTranscriptPath()
  currentProject.reAppendSessionMetadata(true)
  currentProject.currentSessionChainLeaf = undefined
}

async function recordSessionRow(row: (sessionId: UUID) => Entry): Promise<void> {
  const sessionId = getSessionId()
  if (!sessionId) return
  await getProject().appendEntry(row(sessionId))
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
  private readonly chainPart: ChainPart = new ChainPart(this, {
    trackWrite: <T>(fn: () => Promise<T>) => this.queuePart.trackWrite(fn),
    serializeInsert: <T>(fn: () => Promise<T>) => this.queuePart.serializeInsert(fn),
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
  private readonly filesPart: FilesPart = new FilesPart(this, {
    shouldSkipPersistence: () => this.shouldSkipPersistence(),
  })
  private readonly queuePart: QueuePart = new QueuePart()
  private readonly settlePart: SettlePart = new SettlePart({
    enqueueRawLine: (filePath, line, capture, record) =>
      this.queuePart.enqueueRawLine(filePath, line, capture, record).then(() => {
        notifyStorageFile(filePath)
      }),
    writeQueues: () => this.queuePart.writeQueues,
    shouldSkipPersistence: () => this.shouldSkipPersistence(),
  })

  readonly metadata: SessionMeta = new SessionMeta({
    currentId: () => getSessionId(),
    currentFile: () => this.sessionFile,
    append: appendEntryToFile,
    tail: path => readTranscriptTailSync(path, LITE_READ_BUF_SIZE),
  })

  constructor() {
    for (const [prop, field] of Object.entries(SESSION_META_COMPAT_FIELDS)) {
      Object.defineProperty(this, prop, {
        enumerable: true,
        configurable: true,
        get: () => this.metadata.fields[field],
        set: (value: unknown) => {
          ;(this.metadata.fields as Record<string, unknown>)[field] = value
        },
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

  private shouldSkipPersistence(): boolean {
    if (getNodeEnv() === 'test') return true
    if (getInitialSettings().records?.retentionDays === 0) return true
    if (isSessionPersistenceDisabled()) return true
    if (isEnvTruthy(flagEnv('MERCURY_SKIP_PROMPT_HISTORY'))) return true
    return false
  }

  insertMessageChain(
    messages: Transcript,
    isSidechain = false,
    agentId?: string,
    startingParentUuid?: UUID | null,
    preferLiveLeaf = false,
  ): Promise<void> {
    return this.chainPart.insertMessageChain(
      messages,
      isSidechain,
      agentId,
      startingParentUuid,
      preferLiveLeaf,
    )
  }

  private insertTracked(entry: Entry): Promise<void> {
    return this.queuePart.trackWrite(() => this.appendEntry(entry))
  }

  async insertFileHistorySnapshot(
    messageId: UUID,
    snapshot: FileHistorySnapshot,
    isSnapshotUpdate: boolean,
  ): Promise<void> {
    const entry: FileHistorySnapshotEntry = {
      type: 'file-history-snapshot',
      messageId,
      snapshot,
      isSnapshotUpdate,
    }
    await this.insertTracked(entry)
  }

  async insertQueueOperation(queueOp: QueueOperationMessage): Promise<void> {
    await this.insertTracked(queueOp)
  }

  async insertContentReplacement(
    replacements: ContentReplacementRecord[],
    agentId?: AgentId,
  ): Promise<void> {
    const entry: ContentReplacementEntry = {
      type: 'content-replacement',
      sessionId: getSessionId(),
      agentId,
      replacements,
    }
    await this.insertTracked(entry)
  }

  async appendEntry(entry: Entry, sessionId?: UUID): Promise<void> {
    if (this.shouldSkipPersistence()) return
    const targetSessionId = sessionId ?? getSessionId()
    const file = await this.filesPart.sessionFileFor(targetSessionId, entry)
    if (file === null) return

    if (storageRowPolicy(entry.type)?.write === 'append') {
      void this.queuePart
        .enqueueWrite(file, entry)
        .then(() => notifyStorageFile(file), passedOver)
      return
    }

    if (entry.type === 'content-replacement') {
      const target = entry.agentId
        ? (crewmateTranscriptDestinations.get(entry.agentId) ??
            getCrewmateTranscriptPath(entry.agentId))
        : file
      void this.queuePart
        .enqueueWrite(target, entry)
        .then(() => notifyStorageFile(target), passedOver)
      return
    }

    if (entry.type === 'queue-operation') {
      void this.queuePart
        .enqueueWrite(file, entry)
        .then(() => notifyStorageFile(file), passedOver)
      return
    }

    const message = entry as TranscriptMessage
    const agent = message.isSidechain ? message.agentId : undefined
    const target = agent === undefined ? file : crewmateTranscriptDestinations.get(agent) ?? getCrewmateTranscriptPath(asAgentId(agent))
    const existing = agent === undefined ? await getSessionMessages(targetSessionId) : await getCrewmateFileMessages(target)
    if (existing.has(message.uuid)) return
    this.settlePart.enqueueMessageWrite(target, recordedBoundary(message, existing))
    existing.add(message.uuid)
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
  const { line } = encodeTranscriptLine(fullPath, entry)
  const fs = getFsImplementation()
  try {
    fs.appendFileSync(fullPath, line, { mode: 0o600 })
  } catch {
    try {
      fs.mkdirSync(dirname(fullPath), { mode: 0o700 })
      fs.appendFileSync(fullPath, line, { mode: 0o600 })
    } catch (retryError) {
      throw describeTranscriptStoreFailure(fullPath, retryError)
    }
  }
  notifyStorageFile(fullPath)
}

