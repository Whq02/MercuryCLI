
import type { UUID } from 'crypto'
import type { Dirent } from 'fs'
import { readdir, stat } from 'fs/promises'
import { basename, join } from 'path'
import {
  getOriginalCwd,
  getSessionId,
  getSessionProjectDir,
} from '../../bootstrap/state.js'
import { builtInCommandNames } from '../../commands.js'
import {
  type AgentId,
  asAgentId,
  type SessionId,
} from '../../types/ids.js'
import type {
  AttributionSnapshotMessage,
  LogOption,
  PersistedWorktreeSession,
  TranscriptMessage,
} from '../../types/logs.js'
import { sortLogs } from '../../types/logs.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import {
  decodeTranscriptBuffer,
  TRANSCRIPT_FORMAT_REFUSAL,
} from '../../fabric/transcriptDecode.js'
import { uniq } from '../array.js'
import { discoveryPoolWidth, mapWithConcurrency } from '../concurrency.js'
import { updateSessionName } from '../concurrentSessions.js'
import { logForDebugging } from '../debug.js'
import type { FileHistorySnapshot } from '../fileHistory.js'
import { getWorktreePaths } from '../getWorktreePaths.js'
import { sanitizePath } from '../path.js'
import { LITE_READ_BUF_SIZE, readSessionLite } from '../sessionStoragePortable.js'
import type { ContentReplacementRecord } from '../toolResultStorage.js'
import {
  buildAttributionSnapshotChain,
  buildConversationChain,
  buildFileHistorySnapshotChain,
  extractFirstPrompt,
  findLatestMessage,
  removeExtraFields,
} from './chain.js'
import { loadSessionFile, loadTranscriptFile, type TranscriptFoldState } from './loading.js'
import {
  getAgentTranscriptPath,
  getProjectDir,
  getProjectsDir,
  getTranscriptPath,
  getTranscriptPathForSession,
} from './paths.js'
import { appendEntryToFile, getProject, getSessionMessages } from './writer.js'
import { readSessionLabelFacts, sessionFiles, sessionPromptFromWindow } from './sessionIndex.js'

export async function loadTranscriptFromFile(
  filePath: string,
): Promise<LogOption> {
  if (filePath.endsWith('.jsonl')) {
    const fold = await loadTranscriptFile(filePath)
    const { messages, summaries, leafUuids } = fold

    if (messages.size === 0) {
      const head = (await readSessionLite(filePath))?.head ?? ''
      if (decodeTranscriptBuffer(head).refusal) {
        throw new Error(TRANSCRIPT_FORMAT_REFUSAL)
      }
      throw new Error('No messages found in JSONL file')
    }

    const leafMessage = findLatestMessage(messages.values(), msg =>
      leafUuids.has(msg.uuid),
    )
    if (!leafMessage) {
      throw new Error('No valid conversation chain found in JSONL file')
    }

    const transcript = buildConversationChain(messages, leafMessage)

    const summary = summaries.get(leafMessage.uuid)
    const sessionId = leafMessage.sessionId as UUID
    return {
      ...convertToLogOption(
        transcript,
        0,
        summary,
        undefined,
        undefined,
        undefined,
        filePath,
      ),
      ...resumeFactsOf(fold, sessionId, transcript),
    }
  }

  throw new Error(TRANSCRIPT_FORMAT_REFUSAL)
}

function hasVisibleUserContent(message: TranscriptMessage): boolean {
  if (message.type !== 'user') return false
  if (message.isMeta) return false

  const content = message.message?.content
  if (!content) return false

  if (typeof content === 'string') {
    return content.trim().length > 0
  }
  if (Array.isArray(content)) {
    return content.some(
      block =>
        block.type === 'text' ||
        block.type === 'image' ||
        block.type === 'document',
    )
  }
  return false
}

function hasVisibleAssistantContent(message: TranscriptMessage): boolean {
  if (message.type !== 'assistant') return false

  const content = message.message?.content
  if (!content || !Array.isArray(content)) return false

  return content.some(
    block =>
      block.type === 'text' &&
      typeof block.text === 'string' &&
      block.text.trim().length > 0,
  )
}

function countVisibleMessages(transcript: TranscriptMessage[]): number {
  let count = 0
  for (const message of transcript) {
    if (hasVisibleUserContent(message) || hasVisibleAssistantContent(message)) {
      count++
    }
  }
  return count
}

function convertToLogOption(
  transcript: TranscriptMessage[],
  value: number = 0,
  summary?: string,
  customTitle?: string,
  fileHistorySnapshots?: FileHistorySnapshot[],
  tag?: string,
  fullPath?: string,
  attributionSnapshots?: AttributionSnapshotMessage[],
  agentSetting?: string,
  contentReplacements?: ContentReplacementRecord[],
): LogOption {
  const lastMessage = transcript.at(-1)!
  const firstMessage = transcript[0]!

  return {
    date: lastMessage.timestamp,
    messages: removeExtraFields(transcript),
    fullPath,
    value,
    created: new Date(firstMessage.timestamp),
    modified: new Date(lastMessage.timestamp),
    firstPrompt: extractFirstPrompt(transcript),
    messageCount: countVisibleMessages(transcript),
    isSidechain: firstMessage.isSidechain,
    crewName: firstMessage.crewName,
    agentName: firstMessage.agentName,
    agentSetting,
    leafUuid: lastMessage.uuid,
    summary,
    customTitle,
    tag,
    fileHistorySnapshots,
    attributionSnapshots,
    contentReplacements,
    gitBranch: lastMessage.gitBranch,
    projectPath: firstMessage.cwd,
  }
}

export async function fetchLogs(limit?: number): Promise<LogOption[]> {
  const projectDir = getProjectDir(getOriginalCwd())
  return getSessionFilesLite(projectDir, limit, getOriginalCwd())
}

export async function saveCustomTitle(
  sessionId: UUID,
  customTitle: string,
  fullPath?: string,
  source: 'user' | 'auto' = 'user',
) {
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  getProject().metadata.write({ type: 'custom-title', customTitle, sessionId }, resolvedPath)
  invalidateSessionListingMemo()
}

export function saveAiGeneratedTitle(sessionId: UUID, aiTitle: string): void {
  appendEntryToFile(getTranscriptPathForSession(sessionId), {
    type: 'ai-title',
    aiTitle,
    sessionId,
  })
}

export function saveTaskSummary(sessionId: UUID, summary: string): void {
  appendEntryToFile(getTranscriptPathForSession(sessionId), {
    type: 'task-summary',
    summary,
    sessionId,
    timestamp: new Date().toISOString(),
  })
}

export async function saveTag(sessionId: UUID, tag: string, fullPath?: string) {
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  getProject().metadata.write({ type: 'tag', tag, sessionId }, resolvedPath)
}

export async function linkSessionToPR(
  sessionId: UUID,
  prNumber: number,
  prUrl: string,
  prRepository: string,
  fullPath?: string,
): Promise<void> {
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  getProject().metadata.write({ type: 'pr-link', sessionId, prNumber, prUrl, prRepository, timestamp: new Date().toISOString() }, resolvedPath)
}

export function getCurrentSessionTag(sessionId: UUID): string | undefined {
  if (sessionId === getSessionId()) {
    return getProject().currentSessionTag
  }
  return undefined
}

export function getCurrentSessionTitle(
  sessionId: SessionId,
): string | undefined {
  if (sessionId === getSessionId()) {
    return getProject().currentSessionTitle
  }
  return undefined
}

export function getCurrentSessionAgentColor(): string | undefined {
  return getProject().currentSessionAgentColor
}


export function restoreSessionMetadata(meta: {
  customTitle?: string
  tag?: string
  agentName?: string
  agentColor?: string
  agentSetting?: string
  mode?: 'coordinator' | 'normal'
  advisor?: boolean
  model?: string
  worktreeSession?: PersistedWorktreeSession | null
  prNumber?: number
  prUrl?: string
  prRepository?: string
}): void {
  getProject().metadata.restore(meta)
}

export function clearSessionMetadata(): void {
  getProject().metadata.clear()
}

export function reAppendSessionMetadata(): void {
  getProject().reAppendSessionMetadata()
}

export async function saveAgentName(
  sessionId: UUID,
  agentName: string,
  fullPath?: string,
  source: 'user' | 'auto' = 'user',
) {
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  getProject().metadata.write({ type: 'agent-name', agentName, sessionId }, resolvedPath)
  if (sessionId === getSessionId()) void updateSessionName(agentName)
}

export async function saveAgentColor(
  sessionId: UUID,
  agentColor: string,
  fullPath?: string,
) {
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  getProject().metadata.write({ type: 'agent-color', agentColor, sessionId }, resolvedPath)
}

export function saveAgentSetting(agentSetting: string): void {
  getProject().currentSessionAgentSetting = agentSetting
}

export function cacheSessionTitle(customTitle: string): void {
  getProject().currentSessionTitle = customTitle
}

export function saveMode(mode: 'coordinator' | 'normal'): void {
  getProject().currentSessionMode = mode
}

export function saveAdvisorSwitch(on: boolean): void {
  getProject().metadata.saveCached('advisor-switch', on)
}

export function saveSessionModel(model: string): void {
  getProject().metadata.saveCached('model', model)
}

export function saveWorktreeState(
  worktreeSession: PersistedWorktreeSession | null,
): void {
  const stripped: PersistedWorktreeSession | null = worktreeSession
    ? {
        originalCwd: worktreeSession.originalCwd,
        worktreePath: worktreeSession.worktreePath,
        worktreeName: worktreeSession.worktreeName,
        worktreeBranch: worktreeSession.worktreeBranch,
        originalBranch: worktreeSession.originalBranch,
        originalHeadCommit: worktreeSession.originalHeadCommit,
        sessionId: worktreeSession.sessionId,
        tmuxSessionName: worktreeSession.tmuxSessionName,
        hookBased: worktreeSession.hookBased,
      }
    : null
  getProject().metadata.saveCached('worktree-state', stripped)
}

export function getSessionIdFromLog(log: LogOption): UUID | undefined {
  if (log.sessionId) {
    return log.sessionId as UUID
  }
  return log.messages[0]?.sessionId as UUID | undefined
}

export function isLiteLog(log: LogOption): boolean {
  return log.messages.length === 0 && log.sessionId !== undefined
}

export async function loadFullLog(log: LogOption): Promise<LogOption> {
  if (!isLiteLog(log)) {
    return log
  }
  const sessionFile = log.fullPath
  if (!sessionFile) {
    return log
  }

  try {
    const fold = await loadTranscriptFile(sessionFile)
    const { messages, summaries, leafUuids } = fold

    if (messages.size === 0) {
      return log
    }

    const mostRecentLeaf = findLatestMessage(
      messages.values(),
      msg =>
        leafUuids.has(msg.uuid) &&
        (msg.type === 'user' || msg.type === 'assistant'),
    )
    if (!mostRecentLeaf) {
      return log
    }

    const transcript = buildConversationChain(messages, mostRecentLeaf)
    const sessionId = (mostRecentLeaf.sessionId ?? log.sessionId) as UUID
    return {
      ...log,
      messages: removeExtraFields(transcript),
      firstPrompt: extractFirstPrompt(transcript),
      messageCount: countVisibleMessages(transcript),
      summary: mostRecentLeaf
        ? summaries.get(mostRecentLeaf.uuid)
        : log.summary,
      gitBranch: mostRecentLeaf?.gitBranch ?? log.gitBranch,
      isSidechain: transcript[0]?.isSidechain ?? log.isSidechain,
      crewName: transcript[0]?.crewName ?? log.crewName,
      leafUuid: mostRecentLeaf?.uuid ?? log.leafUuid,
      ...resumeFactsOf(fold, sessionId, transcript),
    }
  } catch {
    return log
  }
}

export async function searchSessionsByCustomTitle(
  query: string,
  options?: { limit?: number; exact?: boolean },
): Promise<LogOption[]> {
  const { limit, exact } = options || {}
  const worktreePaths = await getWorktreePaths(getOriginalCwd())
  const allStatLogs = await getStatOnlyLogsForWorktrees(worktreePaths)
  const { logs } = await enrichLogs(allStatLogs, 0, allStatLogs.length)
  const normalizedQuery = query.toLowerCase().trim()

  const matchingLogs = logs.filter(log => {
    const title = log.customTitle?.toLowerCase().trim()
    if (!title) return false
    return exact ? title === normalizedQuery : title.includes(normalizedQuery)
  })

  const sessionIdToLog = new Map<UUID, LogOption>()
  for (const log of matchingLogs) {
    const sessionId = getSessionIdFromLog(log)
    if (sessionId) {
      const existing = sessionIdToLog.get(sessionId)
      if (!existing || log.modified > existing.modified) {
        sessionIdToLog.set(sessionId, log)
      }
    }
  }
  const deduplicated = Array.from(sessionIdToLog.values())

  deduplicated.sort((a, b) => b.modified.getTime() - a.modified.getTime())

  if (limit) {
    return deduplicated.slice(0, limit)
  }
  return deduplicated
}

export function clearSessionMessagesCache(): void {
  getSessionMessages.cache.clear?.()
}

export async function doesMessageExistInSession(
  sessionId: UUID,
  messageUuid: UUID,
): Promise<boolean> {
  const messageSet = await getSessionMessages(sessionId)
  return messageSet.has(messageUuid)
}

export type ResumeFacts = Pick<
  LogOption,
  | 'fileHistorySnapshots'
  | 'attributionSnapshots'
  | 'contentReplacements'
  | 'contextCollapseCommits'
  | 'contextCollapseSnapshot'
  | 'agentName'
  | 'agentColor'
  | 'agentSetting'
  | 'customTitle'
  | 'tag'
  | 'mode'
  | 'advisor'
  | 'model'
  | 'worktreeSession'
  | 'prNumber'
  | 'prUrl'
  | 'prRepository'
>

export function resumeFactsOf(
  fold: Omit<TranscriptFoldState, 'progressBridge'>,
  sessionId: UUID,
  chain: TranscriptMessage[],
): ResumeFacts {
  return {
    fileHistorySnapshots: buildFileHistorySnapshotChain(fold.fileHistorySnapshots, chain),
    attributionSnapshots: buildAttributionSnapshotChain(fold.attributionSnapshots, chain),
    contentReplacements: fold.contentReplacements.get(sessionId) ?? [],
    contextCollapseCommits: fold.contextCollapseCommits.filter(e => e.sessionId === sessionId),
    contextCollapseSnapshot:
      fold.contextCollapseSnapshot?.sessionId === sessionId ? fold.contextCollapseSnapshot : undefined,
    agentName: fold.agentNames.get(sessionId),
    agentColor: fold.agentColors.get(sessionId),
    agentSetting: fold.agentSettings.get(sessionId),
    customTitle: fold.customTitles.get(sessionId),
    tag: fold.tags.get(sessionId),
    mode: fold.modes.get(sessionId) as LogOption['mode'],
    advisor: fold.advisorSwitches.get(sessionId),
    model: fold.sessionModels.get(sessionId),
    worktreeSession: fold.worktreeStates.has(sessionId) ? fold.worktreeStates.get(sessionId) : undefined,
    prNumber: fold.prNumbers.get(sessionId),
    prUrl: fold.prUrls.get(sessionId),
    prRepository: fold.prRepositories.get(sessionId),
  }
}

export async function getLastSessionLog(
  sessionId: UUID,
): Promise<LogOption | null> {
  const fold = await loadSessionFile(sessionId)
  const { messages, summaries } = fold
  if (messages.size === 0) return null
  if (!getSessionMessages.cache.has(sessionId)) {
    getSessionMessages.cache.set(
      sessionId,
      Promise.resolve(new Set(messages.keys())),
    )
  }

  const lastMessage = findLatestMessage(messages.values(), m => !m.isSidechain)
  if (!lastMessage) return null

  const transcript = buildConversationChain(messages, lastMessage)

  const summary = summaries.get(lastMessage.uuid)
  return {
    ...convertToLogOption(
      transcript,
      0,
      summary,
      undefined,
      undefined,
      undefined,
      getTranscriptPathForSession(sessionId),
    ),
    ...resumeFactsOf(fold, sessionId, transcript),
  }
}

export async function loadMessageLogs(limit?: number): Promise<LogOption[]> {
  const sessionLogs = await fetchLogs(limit)
  const { logs: enriched } = await enrichLogs(
    sessionLogs,
    0,
    sessionLogs.length,
  )

  const sorted = sortLogs(enriched)
  sorted.forEach((log, i) => {
    log.value = i
  })
  return sorted
}

export async function loadAllProjectsMessageLogs(
  limit?: number,
  options?: { skipIndex?: boolean; initialEnrichCount?: number },
): Promise<LogOption[]> {
  if (options?.skipIndex) {
    return loadAllProjectsMessageLogsFull(limit)
  }
  const result = await loadAllProjectsMessageLogsProgressive(
    limit,
    options?.initialEnrichCount ?? INITIAL_ENRICH_COUNT,
  )
  return result.logs
}

async function loadAllProjectsMessageLogsFull(
  limit?: number,
): Promise<LogOption[]> {
  const projectsDir = getProjectsDir()

  let dirents: Dirent[]
  try {
    dirents = await readdir(projectsDir, { withFileTypes: true })
  } catch {
    return []
  }

  const projectDirs = dirents
    .filter(dirent => dirent.isDirectory())
    .map(dirent => join(projectsDir, dirent.name))

  const logsPerProject = await mapWithConcurrency(projectDirs, discoveryPoolWidth(), projectDir =>
    getLogsWithoutIndex(projectDir, limit),
  )
  const allLogs = logsPerProject.flat()

  const deduped = new Map<string, LogOption>()
  for (const log of allLogs) {
    const key = `${log.sessionId ?? ''}:${log.leafUuid ?? ''}`
    const existing = deduped.get(key)
    if (!existing || log.modified.getTime() > existing.modified.getTime()) {
      deduped.set(key, log)
    }
  }

  const sorted = sortLogs([...deduped.values()])
  sorted.forEach((log, i) => {
    log.value = i
  })
  return sorted
}

const LISTING_MEMO_TTL_MS = 5_000
interface ListingMemo {
  key: string
  truth: string
  at: number
  result: SessionLogResult
}
let listingMemo: ListingMemo | null = null
let listingFlight: { key: string; promise: Promise<SessionLogResult> } | null = null
export const listingCensus = { sweeps: 0, served: 0, joined: 0 }

async function listingTruth(projectsDir: string, projectDirs: string[]): Promise<string | null> {
  try {
    const root = await stat(projectsDir)
    const stamps = await mapWithConcurrency(projectDirs, discoveryPoolWidth(), async dir => {
      try {
        return `${basename(dir)}@${(await stat(dir)).mtimeMs}`
      } catch {
        return `${basename(dir)}@gone`
      }
    })
    return `${root.mtimeMs}|${stamps.join('|')}`
  } catch {
    return null
  }
}

function shareListing(result: SessionLogResult): SessionLogResult {
  return {
    logs: result.logs.map(log => ({ ...log })),
    allStatLogs: result.allStatLogs.map(log => ({ ...log })),
    nextIndex: result.nextIndex,
  }
}

export function invalidateSessionListingMemo(): void {
  listingMemo = null
}

export async function loadAllProjectsMessageLogsProgressive(
  limit?: number,
  initialEnrichCount: number = INITIAL_ENRICH_COUNT,
): Promise<SessionLogResult> {
  const projectsDir = getProjectsDir()

  let dirents: Dirent[]
  try {
    dirents = await readdir(projectsDir, { withFileTypes: true })
  } catch {
    return { logs: [], allStatLogs: [], nextIndex: 0 }
  }

  const projectDirs = dirents
    .filter(dirent => dirent.isDirectory())
    .map(dirent => join(projectsDir, dirent.name))

  const key = `${projectsDir}\x1f${limit ?? ''}\x1f${initialEnrichCount}`
  const truth = await listingTruth(projectsDir, projectDirs)
  const memo = listingMemo
  if (memo !== null && truth !== null && memo.key === key && memo.truth === truth && Date.now() - memo.at < LISTING_MEMO_TTL_MS) {
    listingCensus.served++
    return shareListing(memo.result)
  }
  if (listingFlight !== null && listingFlight.key === key) {
    listingCensus.joined++
    return shareListing(await listingFlight.promise)
  }
  const promise = sweepAllProjectsProgressive(projectDirs, limit, initialEnrichCount).then(result => {
    if (truth !== null) listingMemo = { key, truth, at: Date.now(), result }
    return result
  })
  listingFlight = { key, promise }
  try {
    return shareListing(await promise)
  } finally {
    if (listingFlight !== null && listingFlight.promise === promise) listingFlight = null
  }
}

async function sweepAllProjectsProgressive(
  projectDirs: string[],
  limit: number | undefined,
  initialEnrichCount: number,
): Promise<SessionLogResult> {
  listingCensus.sweeps++
  const perProject = await mapWithConcurrency(projectDirs, discoveryPoolWidth(), projectDir =>
    getSessionFilesLite(projectDir, limit),
  )
  const rawLogs: LogOption[] = perProject.flat()
  const sorted = deduplicateLogsBySessionId(rawLogs)

  const { logs, nextIndex } = await enrichLogs(sorted, 0, initialEnrichCount)

  logs.forEach((log, i) => {
    log.value = i
  })
  return { logs, allStatLogs: sorted, nextIndex }
}

export type SessionLogResult = {
  logs: LogOption[]
  allStatLogs: LogOption[]
  nextIndex: number
}

export async function loadSameRepoMessageLogs(
  worktreePaths: string[],
  limit?: number,
  initialEnrichCount: number = INITIAL_ENRICH_COUNT,
): Promise<LogOption[]> {
  const result = await loadSameRepoMessageLogsProgressive(
    worktreePaths,
    limit,
    initialEnrichCount,
  )
  return result.logs
}

export async function loadSameRepoMessageLogsProgressive(
  worktreePaths: string[],
  limit?: number,
  initialEnrichCount: number = INITIAL_ENRICH_COUNT,
): Promise<SessionLogResult> {
  logForDebugging(
    `/resume: loading sessions for cwd=${getOriginalCwd()}, worktrees=[${worktreePaths.join(', ')}]`,
  )
  const allStatLogs = await getStatOnlyLogsForWorktrees(worktreePaths, limit)
  logForDebugging(`/resume: found ${allStatLogs.length} session files on disk`)

  const { logs, nextIndex } = await enrichLogs(
    allStatLogs,
    0,
    initialEnrichCount,
  )

  logs.forEach((log, i) => {
    log.value = i
  })
  return { logs, allStatLogs, nextIndex }
}

async function getStatOnlyLogsForWorktrees(
  worktreePaths: string[],
  limit?: number,
): Promise<LogOption[]> {
  const projectsDir = getProjectsDir()

  if (worktreePaths.length <= 1) {
    const cwd = getOriginalCwd()
    const projectDir = getProjectDir(cwd)
    return getSessionFilesLite(projectDir, undefined, cwd)
  }

  const caseInsensitive = process.platform === 'win32'

  const indexed = worktreePaths.map(wt => {
    const sanitized = sanitizePath(wt)
    return {
      path: wt,
      prefix: caseInsensitive ? sanitized.toLowerCase() : sanitized,
    }
  })
  indexed.sort((a, b) => b.prefix.length - a.prefix.length)

  const allLogs: LogOption[] = []
  const seenDirs = new Set<string>()

  let allDirents: Dirent[]
  try {
    allDirents = await readdir(projectsDir, { withFileTypes: true })
  } catch (e) {
    logForDebugging(
      `Failed to read projects dir ${projectsDir}, falling back to current project: ${e}`,
    )
    const projectDir = getProjectDir(getOriginalCwd())
    return getSessionFilesLite(projectDir, limit, getOriginalCwd())
  }

  const matched: Array<{ dir: string; wtPath: string }> = []
  for (const dirent of allDirents) {
    if (!dirent.isDirectory()) continue
    const dirName = caseInsensitive ? dirent.name.toLowerCase() : dirent.name
    if (seenDirs.has(dirName)) continue

    for (const { path: wtPath, prefix } of indexed) {
      if (dirName === prefix || dirName.startsWith(prefix + '-')) {
        seenDirs.add(dirName)
        matched.push({ dir: join(projectsDir, dirent.name), wtPath })
        break
      }
    }
  }
  const perDir = await mapWithConcurrency(matched, discoveryPoolWidth(), ({ dir, wtPath }) =>
    getSessionFilesLite(dir, undefined, wtPath),
  )
  allLogs.push(...perDir.flat())

  return deduplicateLogsBySessionId(allLogs)
}

export async function getAgentTranscript(agentId: AgentId): Promise<{
  messages: Message[]
  contentReplacements: ContentReplacementRecord[]
} | null> {
  const agentFile = getAgentTranscriptPath(agentId)

  try {
    const { messages, agentContentReplacements } =
      await loadTranscriptFile(agentFile)

    const agentMessages = Array.from(messages.values()).filter(
      msg => msg.agentId === agentId && msg.isSidechain,
    )
    if (agentMessages.length === 0) {
      return null
    }

    const parentUuids = new Set(agentMessages.map(msg => msg.parentUuid))
    const leafMessage = findLatestMessage(
      agentMessages,
      msg => !parentUuids.has(msg.uuid),
    )
    if (!leafMessage) {
      return null
    }

    const transcript = buildConversationChain(messages, leafMessage)
    const agentTranscript = transcript.filter(msg => msg.agentId === agentId)

    return {
      messages: agentTranscript.map(
        ({ isSidechain, parentUuid, ...msg }) => msg,
      ),
      contentReplacements: agentContentReplacements.get(agentId) ?? [],
    }
  } catch {
    return null
  }
}

export function extractAgentIdsFromMessages(messages: Message[]): string[] {
  const agentIds: string[] = []

  for (const message of messages) {
    if (
      message.type === 'progress' &&
      message.data &&
      typeof message.data === 'object' &&
      'type' in message.data &&
      (message.data.type === 'agent_progress' ||
        message.data.type === 'skill_progress') &&
      'agentId' in message.data &&
      typeof message.data.agentId === 'string'
    ) {
      agentIds.push(message.data.agentId)
    }
  }

  return uniq(agentIds)
}

export function extractCrewmateTranscriptsFromTasks(tasks: {
  [taskId: string]: {
    type: string
    identity?: { agentId: string }
    messages?: Message[]
  }
}): { [agentId: string]: Message[] } {
  const transcripts: { [agentId: string]: Message[] } = {}

  for (const task of Object.values(tasks)) {
    if (
      task.type === 'in_process_crewmate' &&
      task.identity?.agentId &&
      task.messages &&
      task.messages.length > 0
    ) {
      transcripts[task.identity.agentId] = task.messages
    }
  }

  return transcripts
}

export async function loadSubagentTranscripts(
  agentIds: string[],
): Promise<{ [agentId: string]: Message[] }> {
  const results = await Promise.all(
    agentIds.map(async agentId => {
      try {
        const result = await getAgentTranscript(asAgentId(agentId))
        if (result && result.messages.length > 0) {
          return { agentId, transcript: result.messages }
        }
        return null
      } catch {
        return null
      }
    }),
  )

  const transcripts: { [agentId: string]: Message[] } = {}
  for (const result of results) {
    if (result) {
      transcripts[result.agentId] = result.transcript
    }
  }
  return transcripts
}

export async function loadAllSubagentTranscriptsFromDisk(): Promise<{
  [agentId: string]: Message[]
}> {
  const subagentsDir = join(
    getSessionProjectDir() ?? getProjectDir(getOriginalCwd()),
    getSessionId(),
    'subagents',
  )
  let entries: Dirent[]
  try {
    entries = await readdir(subagentsDir, { withFileTypes: true })
  } catch {
    return {}
  }
  const agentIds = entries
    .filter(
      d =>
        d.isFile() && d.name.startsWith('agent-') && d.name.endsWith('.jsonl'),
    )
    .map(d => d.name.slice('agent-'.length, -'.jsonl'.length))
  return loadSubagentTranscripts(agentIds)
}

export async function getLogByIndex(index: number): Promise<LogOption | null> {
  const logs = await loadMessageLogs()
  return logs[index] || null
}

export async function findUnresolvedToolUse(
  toolUseId: string,
): Promise<AssistantMessage | null> {
  try {
    const transcriptPath = getTranscriptPath()
    const { messages } = await loadTranscriptFile(transcriptPath)

    let toolUseMessage = null

    for (const message of messages.values()) {
      if (message.type === 'assistant') {
        const content = message.message.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'tool_use' && block.id === toolUseId) {
              toolUseMessage = message
              break
            }
          }
        }
      } else if (message.type === 'user') {
        const content = message.message.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (
              block.type === 'tool_result' &&
              block.tool_use_id === toolUseId
            ) {
              return null
            }
          }
        }
      }
    }

    return toolUseMessage
  } catch {
    return null
  }
}

export async function getSessionFilesWithMtime(
  projectDir: string,
): Promise<
  Map<string, { path: string; mtime: number; ctime: number; size: number }>
> {
  const rows = await sessionFiles(projectDir, {
    concurrency: discoveryPoolWidth(),
    failed: path => logForDebugging(`Failed to stat session file: ${path}`),
  })
  return new Map(rows.map(({ sessionId, ...row }) => [sessionId, row]))
}

export async function transcriptCensus(): Promise<{
  count: number
  bytes: number
  oldestMtimeMs: number | null
}> {
  const projectsDir = getProjectsDir()
  let dirents: Dirent[]
  try {
    dirents = await readdir(projectsDir, { withFileTypes: true })
  } catch {
    return { count: 0, bytes: 0, oldestMtimeMs: null }
  }
  const projectDirs = dirents
    .filter(dirent => dirent.isDirectory())
    .map(dirent => join(projectsDir, dirent.name))
  const perProject = await mapWithConcurrency(projectDirs, discoveryPoolWidth(), projectDir =>
    getSessionFilesWithMtime(projectDir),
  )
  let count = 0
  let bytes = 0
  let oldestMtimeMs: number | null = null
  for (const files of perProject) {
    for (const info of files.values()) {
      count++
      bytes += info.size
      if (oldestMtimeMs === null || info.mtime < oldestMtimeMs) {
        oldestMtimeMs = info.mtime
      }
    }
  }
  return { count, bytes, oldestMtimeMs }
}

const INITIAL_ENRICH_COUNT = 50

type LiteMetadata = {
  firstPrompt: string
  gitBranch?: string
  isSidechain: boolean
  projectPath?: string
  crewName?: string
  customTitle?: string
  summary?: string
  tag?: string
  agentSetting?: string
  prNumber?: number
  prUrl?: string
  prRepository?: string
  endedOnError?: boolean
}

export async function loadAllLogsFromSessionFile(
  sessionFile: string,
  projectPathOverride?: string,
): Promise<LogOption[]> {
  const fold = await loadTranscriptFile(sessionFile, { keepAllLeaves: true })
  const { messages, summaries, leafUuids } = fold

  if (messages.size === 0) return []

  const leafMessages: TranscriptMessage[] = []
  const childrenByParent = new Map<UUID, TranscriptMessage[]>()
  for (const msg of messages.values()) {
    if (leafUuids.has(msg.uuid)) {
      leafMessages.push(msg)
    } else if (msg.parentUuid) {
      const siblings = childrenByParent.get(msg.parentUuid)
      if (siblings) {
        siblings.push(msg)
      } else {
        childrenByParent.set(msg.parentUuid, [msg])
      }
    }
  }

  const logs: LogOption[] = []

  for (const leafMessage of leafMessages) {
    const chain = buildConversationChain(messages, leafMessage)
    if (chain.length === 0) continue

    const trailingMessages = childrenByParent.get(leafMessage.uuid)
    if (trailingMessages) {
      trailingMessages.sort((a, b) =>
        a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0,
      )
      chain.push(...trailingMessages)
    }

    const firstMessage = chain[0]!
    const sessionId = leafMessage.sessionId as UUID

    logs.push({
      date: leafMessage.timestamp,
      messages: removeExtraFields(chain),
      fullPath: sessionFile,
      value: 0,
      created: new Date(firstMessage.timestamp),
      modified: new Date(leafMessage.timestamp),
      firstPrompt: extractFirstPrompt(chain),
      messageCount: countVisibleMessages(chain),
      isSidechain: firstMessage.isSidechain ?? false,
      sessionId,
      leafUuid: leafMessage.uuid,
      summary: summaries.get(leafMessage.uuid),
      gitBranch: leafMessage.gitBranch,
      projectPath: projectPathOverride ?? firstMessage.cwd,
      ...resumeFactsOf(fold, sessionId, chain),
    })
  }

  return logs
}

async function getLogsWithoutIndex(
  projectDir: string,
  limit?: number,
): Promise<LogOption[]> {
  const sessionFilesMap = await getSessionFilesWithMtime(projectDir)
  if (sessionFilesMap.size === 0) return []

  let filesToProcess: Array<{ path: string; mtime: number }>
  if (limit && sessionFilesMap.size > limit) {
    filesToProcess = [...sessionFilesMap.values()]
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
  } else {
    filesToProcess = [...sessionFilesMap.values()]
  }

  const logs: LogOption[] = []
  for (const fileInfo of filesToProcess) {
    try {
      const fileLogOptions = await loadAllLogsFromSessionFile(fileInfo.path)
      logs.push(...fileLogOptions)
    } catch {
      logForDebugging(`Failed to load session file: ${fileInfo.path}`)
    }
  }

  return logs
}

async function readLiteMetadata(
  filePath: string,
  fileSize: number,
  buf: Buffer,
): Promise<LiteMetadata> {
  return readSessionLabelFacts(filePath, fileSize, buf, name => builtInCommandNames().has(name))
}

export function extractFirstPromptFromChunk(chunk: string): string {
  return sessionPromptFromWindow(chunk, name => builtInCommandNames().has(name))
}

function deduplicateLogsBySessionId(logs: LogOption[]): LogOption[] {
  const deduped = new Map<string, LogOption>()
  for (const log of logs) {
    if (!log.sessionId) continue
    const existing = deduped.get(log.sessionId)
    if (!existing || log.modified.getTime() > existing.modified.getTime()) {
      deduped.set(log.sessionId, log)
    }
  }
  return sortLogs([...deduped.values()]).map((log, i) => ({
    ...log,
    value: i,
  }))
}

export async function getSessionFilesLite(
  projectDir: string,
  limit?: number,
  projectPath?: string,
): Promise<LogOption[]> {
  const sessionFilesMap = await getSessionFilesWithMtime(projectDir)

  let entries = [...sessionFilesMap.entries()].sort(
    (a, b) => b[1].mtime - a[1].mtime,
  )
  if (limit && entries.length > limit) {
    entries = entries.slice(0, limit)
  }

  const logs: LogOption[] = []

  for (const [sessionId, fileInfo] of entries) {
    logs.push({
      date: new Date(fileInfo.mtime).toISOString(),
      messages: [],
      isLite: true,
      fullPath: fileInfo.path,
      value: 0,
      created: new Date(fileInfo.ctime),
      modified: new Date(fileInfo.mtime),
      firstPrompt: '',
      fileSize: fileInfo.size,
      isSidechain: false,
      sessionId,
      projectPath,
    })
  }

  const sorted = sortLogs(logs)
  sorted.forEach((log, i) => {
    log.value = i
  })
  return sorted
}

async function enrichLog(
  log: LogOption,
  readBuf: Buffer,
): Promise<LogOption | null> {
  if (!log.isLite || !log.fullPath) return log

  const meta = await readLiteMetadata(log.fullPath, log.fileSize ?? 0, readBuf)

  const enriched: LogOption = {
    ...log,
    isLite: false,
    firstPrompt: meta.firstPrompt,
    gitBranch: meta.gitBranch,
    isSidechain: meta.isSidechain,
    crewName: meta.crewName,
    customTitle: meta.customTitle,
    summary: meta.summary,
    tag: meta.tag,
    agentSetting: meta.agentSetting,
    prNumber: meta.prNumber,
    prUrl: meta.prUrl,
    prRepository: meta.prRepository,
    endedOnError: meta.endedOnError,
    projectPath: meta.projectPath ?? log.projectPath,
  }

  if (!enriched.firstPrompt && !enriched.customTitle) {
    enriched.firstPrompt = '(session)'
  }
  if (enriched.isSidechain) {
    logForDebugging(
      `Session ${log.sessionId} filtered from /resume: isSidechain=true`,
    )
    return null
  }
  if (enriched.crewName) {
    logForDebugging(
      `Session ${log.sessionId} filtered from /resume: crewName=${enriched.crewName}`,
    )
    return null
  }

  return enriched
}

export async function enrichLogs(
  allLogs: LogOption[],
  startIndex: number,
  count: number,
): Promise<{ logs: LogOption[]; nextIndex: number }> {
  const result: LogOption[] = []
  const readBuf = Buffer.alloc(LITE_READ_BUF_SIZE)
  let i = startIndex

  while (i < allLogs.length && result.length < count) {
    const log = allLogs[i]!
    i++

    const enriched = await enrichLog(log, readBuf)
    if (enriched) {
      result.push(enriched)
    }
  }

  const scanned = i - startIndex
  const filtered = scanned - result.length
  if (filtered > 0) {
    logForDebugging(
      `/resume: enriched ${scanned} sessions, ${filtered} filtered out, ${result.length} visible (${allLogs.length - i} remaining on disk)`,
    )
  }

  return { logs: result, nextIndex: i }
}
