import type { UUID } from 'crypto'
import { sleep } from '../sleep.js'
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
import { notifyStorageFile, subscribeStorageFile } from './fileWatch.js'
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
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'
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

const agentTranscriptDestinations = new Map<string, string>()

export function registerAgentTranscriptDestination(
  agentId: string,
  filePath: string,
): void {
  agentTranscriptDestinations.set(agentId, filePath)
}

const reportedAgentReadFailures = new Set<string>()

const agentFileMessages = new Map<string, Set<string>>()

async function getAgentFileMessages(filePath: string): Promise<Set<string>> {
  const cached = agentFileMessages.get(filePath)
  if (cached !== undefined) return cached
  try {
    const head = historyHead(filePath)
    const set = new Set<string>()
    for (const part of sealedExtents(head)) for (const [, id] of historyIndex(part)) if (id !== null) set.add(id)
    let added = 0
    for (const row of transcriptLineBytes(filePath, { end: head.end })) {
      added += row.length
      if (added >= 1024 * 1024) { await sleep(0); added = 0 }
      try {
        const id = JSON.parse(row.toString('utf8'))?.annotations?.uuid
        if (typeof id === 'string') set.add(id)
      } catch (error) { passedOver(error) }
    }
    const known = agentFileMessages.get(filePath)
    if (known !== undefined) return known
    agentFileMessages.set(filePath, set)
    return set
  } catch (error) {
    const code = getErrnoCode(error)
    if (code !== 'ENOENT' && code !== 'ENOTDIR') {
      logForDebugging(`agent transcript read failed for ${filePath} (${code ?? 'unknown'})`, { level: 'error' })
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
}

let project: Project | null = null
let cleanupRegistered = false

export function getProject(): Project {
  return notBuilt('src/utils/sessionStorage/writer.ts:125')
}

export function peekProject(): Project | null {
  return notBuilt('src/utils/sessionStorage/writer.ts:149')
}

export function resetProjectFlushStateForTesting(): void {
  return notBuilt('src/utils/sessionStorage/writer.ts:153')
}

export function resetProjectForTesting(): void {
  return notBuilt('src/utils/sessionStorage/writer.ts:157')
}

export function setSessionFileForTesting(path: string): void {
  return notBuilt('src/utils/sessionStorage/writer.ts:163')
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

export async function recordTranscript(
  messages: Message[],
  startingParentUuidHint?: UUID,
  allMessages?: readonly Message[],
): Promise<UUID | null> {
  return notBuilt('src/utils/sessionStorage/writer.ts:201')
}

export function settleTranscriptMessage(message: Message): Promise<void> {
  return notBuilt('src/utils/sessionStorage/writer.ts:231')
}

export async function recordSidechainTranscript(
  messages: Message[],
  agentId?: string,
  startingParentUuid?: UUID | null,
): Promise<Unbuilt> {
  return notBuilt('src/utils/sessionStorage/writer.ts:235')
}

export function closeAgentTranscript(agentId: string): void {
  return notBuilt('src/utils/sessionStorage/writer.ts:248')
}

export async function recordQueueOperation(queueOp: QueueOperationMessage): Promise<Unbuilt> {
  return notBuilt('src/utils/sessionStorage/writer.ts:252')
}

export async function recordTurnStart(turnId: string): Promise<void> {
  return notBuilt('src/utils/sessionStorage/writer.ts:256')
}

export async function recordTurnEnd(turnId: string, status: string): Promise<void> {
  await recordSessionRow(sessionId => ({ type: 'turn-end', sessionId, turnId, status }))
}

export async function removeTranscriptMessage(targetUuid: UUID): Promise<void> {
  return notBuilt('src/utils/sessionStorage/writer.ts:264')
}

export async function recordFileHistorySnapshot(
  messageId: UUID,
  snapshot: FileHistorySnapshot,
  isSnapshotUpdate: boolean,
): Promise<Unbuilt> {
  return notBuilt('src/utils/sessionStorage/writer.ts:268')
}

export async function recordAttributionSnapshot(
  snapshot: AttributionSnapshotEntry,
): Promise<Unbuilt> {
  return notBuilt('src/utils/sessionStorage/writer.ts:280')
}

export async function recordContentReplacement(
  replacements: ContentReplacementRecord[],
  agentId?: AgentId,
): Promise<Unbuilt> {
  return notBuilt('src/utils/sessionStorage/writer.ts:286')
}

export async function resetSessionFilePointer(): Promise<Unbuilt> {
  return notBuilt('src/utils/sessionStorage/writer.ts:293')
}

export function advisorSwitchOfSession(): boolean {
  return notBuilt('src/utils/sessionStorage/writer.ts:297')
}

export function swarmSwitchOfSession(): boolean {
  return notBuilt('src/utils/sessionStorage/writer.ts:301')
}

export function adoptResumedSessionFile(): void {
  return notBuilt('src/utils/sessionStorage/writer.ts:305')
}

async function recordSessionRow(row: (sessionId: UUID) => Entry): Promise<void> {
  return notBuilt('src/utils/sessionStorage/writer.ts:312')
}

export async function recordContextCollapseCommit(commit: {
  collapseId: string
  summaryUuid: string
  summaryContent: string
  summary: string
  firstArchivedUuid: string
  lastArchivedUuid: string
}): Promise<void> {
  return notBuilt('src/utils/sessionStorage/writer.ts:318')
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
  return notBuilt('src/utils/sessionStorage/writer.ts:329')
}

export async function flushSessionStorage(): Promise<void> {
  return notBuilt('src/utils/sessionStorage/writer.ts:343')
}

class Project {
  currentSessionTag: string | undefined
  currentSessionTitle: string | undefined
  currentSessionAgentName: string | undefined
  currentSessionAgentColor: string | undefined
  currentSessionLastPrompt: string | undefined
  currentSessionChainLeaf: UUID | undefined
  private readonly chainPart: Unbuilt = unbuilt('src/utils/sessionStorage/writer.ts:354')
  currentSessionAgentSetting: string | undefined
  currentSessionMode: 'coordinator' | 'normal' | undefined
  currentSessionAdvisor: boolean | undefined
  currentSessionSwarm: boolean | undefined
  currentSessionModel: string | undefined
  currentSessionWorktree: PersistedWorktreeSession | null | undefined
  currentSessionPrNumber: number | undefined
  currentSessionPrUrl: string | undefined
  currentSessionPrRepository: string | undefined

  sessionFile: string | null = unbuilt('src/utils/sessionStorage/writer.ts:369')
  private readonly filesPart: Unbuilt = unbuilt('src/utils/sessionStorage/writer.ts:370')
  private readonly queuePart: Unbuilt = unbuilt('src/utils/sessionStorage/writer.ts:371')
  private readonly settlePart: Unbuilt = unbuilt('src/utils/sessionStorage/writer.ts:372')
  private readonly removePart: Unbuilt = unbuilt('src/utils/sessionStorage/writer.ts:380')

  readonly metadata: Unbuilt = unbuilt('src/utils/sessionStorage/writer.ts:386')

  constructor() {
    notBuilt('src/utils/sessionStorage/writer.ts:393')
  }

  _resetFlushState(): void {
    return notBuilt('src/utils/sessionStorage/writer.ts:404')
  }

  resetSessionFile(): void {
    return notBuilt('src/utils/sessionStorage/writer.ts:409')
  }

  reAppendSessionMetadata(skipTitleRefresh?: boolean): void {
    return notBuilt('src/utils/sessionStorage/writer.ts:416')
  }

  flush(): Promise<void> {
    return notBuilt('src/utils/sessionStorage/writer.ts:420')
  }

  async removeMessageByUuid(targetUuid: UUID): Promise<void> {
    return notBuilt('src/utils/sessionStorage/writer.ts:424')
  }

  private shouldSkipPersistence(): boolean {
    return notBuilt('src/utils/sessionStorage/writer.ts:430')
  }

  insertMessageChain(
    messages: Transcript,
    isSidechain?: boolean,
    agentId?: string,
    startingParentUuid?: UUID | null,
    preferLiveLeaf?: boolean,
  ): Unbuilt {
    return notBuilt('src/utils/sessionStorage/writer.ts:439')
  }

  private insertTracked(entry: Entry): Promise<void> {
    return notBuilt('src/utils/sessionStorage/writer.ts:449')
  }

  async insertFileHistorySnapshot(
    messageId: UUID,
    snapshot: FileHistorySnapshot,
    isSnapshotUpdate: boolean,
  ): Promise<Unbuilt> {
    return notBuilt('src/utils/sessionStorage/writer.ts:453')
  }

  async insertQueueOperation(queueOp: QueueOperationMessage): Promise<Unbuilt> {
    return notBuilt('src/utils/sessionStorage/writer.ts:462')
  }

  async insertAttributionSnapshot(snapshot: AttributionSnapshotEntry): Promise<Unbuilt> {
    return notBuilt('src/utils/sessionStorage/writer.ts:466')
  }

  async insertContentReplacement(
    replacements: ContentReplacementRecord[],
    agentId?: AgentId,
  ): Promise<Unbuilt> {
    return notBuilt('src/utils/sessionStorage/writer.ts:470')
  }

  async appendEntry(entry: Entry, sessionId?: UUID): Promise<Unbuilt> {
    return notBuilt('src/utils/sessionStorage/writer.ts:478')
  }

  settleMessage(message: Message): Promise<void> {
    return notBuilt('src/utils/sessionStorage/writer.ts:528')
  }

  closeTranscript(file: string): void {
    return notBuilt('src/utils/sessionStorage/writer.ts:532')
  }
}

export function appendEntryToFile(
  fullPath: string,
  entry: Record<string, unknown>,
): void {
  return notBuilt('src/utils/sessionStorage/writer.ts:537')
}

