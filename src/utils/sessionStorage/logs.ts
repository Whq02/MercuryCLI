
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
  SessionListing,
  PersistedWorktreeSession,
  TranscriptMessage,
} from '../../types/logs.js'
import { sortSessionListings } from '../../types/logs.js'
import type { AssistantMessage, Message } from '../../types/message.js'
import {
  decodeTranscriptBuffer,
  TRANSCRIPT_FORMAT_REFUSAL,
} from '../../fabric/transcriptDecode.js'
import { uniq } from '../array.js'
import { discoveryPoolWidth, mapWithConcurrency } from '../concurrency.js'
import { updateSessionName } from '../concurrentSessions.js'
import { logForDebugging } from '../debug.js'
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
import { readSessionLabelFacts, sessionFiles, sessionPromptFromWindow, type IndexedSession } from './sessionIndex.js'
import { transcriptRows } from './rowGraph.js'
import type { SessionMetaFields } from './sessionMeta.js'

export async function loadTranscriptFromFile(
  filePath: string,
): Promise<SessionListing> {
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
    const sessionId = leafMessage.sessionId as UUID
    return {
      ...chainLogOption(transcript, transcript.at(-1)!, filePath),
      summary: summaries.get(leafMessage.uuid),
      ...resumeFactsOf(fold, sessionId, transcript),
    }
  }

  throw new Error(TRANSCRIPT_FORMAT_REFUSAL)
}

function paintsConversationRow(message: TranscriptMessage): boolean {
  if (message.type === 'user') {
    const content = message.message?.content
    if (message.isMeta || !content) return false
    if (typeof content === 'string') return content.trim().length > 0
    return Array.isArray(content) && content.some(block => block.type === 'text' || block.type === 'image' || block.type === 'document')
  }
  if (message.type === 'assistant') {
    const content = message.message?.content
    return Array.isArray(content) && content.some(block => block.type === 'text' && typeof block.text === 'string' && block.text.trim().length > 0)
  }
  return false
}

function visibleTurnCount(chain: TranscriptMessage[]): number {
  return chain.filter(paintsConversationRow).length
}

function chainLogOption(chain: TranscriptMessage[], anchor: TranscriptMessage, fullPath?: string): SessionListing {
  const first = chain[0]!
  return {
    date: anchor.timestamp,
    messages: removeExtraFields(chain),
    fullPath,
    value: 0,
    created: new Date(first.timestamp),
    modified: new Date(anchor.timestamp),
    firstPrompt: extractFirstPrompt(chain),
    messageCount: visibleTurnCount(chain),
    isSidechain: first.isSidechain,
    leafUuid: anchor.uuid,
    gitBranch: anchor.gitBranch,
    projectPath: first.cwd,
  }
}

function newestPerKey(logs: SessionListing[], keyOf: (log: SessionListing) => string | undefined): SessionListing[] {
  const newest = new Map<string, SessionListing>()
  for (const log of logs) {
    const key = keyOf(log)
    if (!key) continue
    const held = newest.get(key)
    if (!held || log.modified.getTime() > held.modified.getTime()) newest.set(key, log)
  }
  return [...newest.values()]
}

function renumbered(logs: SessionListing[]): SessionListing[] {
  logs.forEach((log, i) => {
    log.value = i
  })
  return logs
}

function numbered(logs: SessionListing[]): SessionListing[] {
  return renumbered(sortSessionListings(logs))
}

export async function listSessions(limit?: number): Promise<SessionListing[]> {
  const projectDir = getProjectDir(getOriginalCwd())
  return sessionFilesLite(projectDir, limit, getOriginalCwd())
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

function liveSessionFacts(sessionId: string): SessionMetaFields | undefined {
  return sessionId === getSessionId() ? getProject().metadata.fields : undefined
}

export function getCurrentSessionTag(sessionId: UUID): string | undefined {
  return liveSessionFacts(sessionId)?.tag
}

export function getCurrentSessionTitle(
  sessionId: SessionId,
): string | undefined {
  return liveSessionFacts(sessionId)?.customTitle
}

export function getCurrentSessionAgentColor(): string | undefined {
  return getProject().metadata.fields.agentColor
}

export function restoreSessionMetadata(meta: Omit<SessionMetaFields, 'lastPrompt'>): void {
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

export function sessionIdOfListing(log: SessionListing): UUID | undefined {
  if (log.sessionId) {
    return log.sessionId as UUID
  }
  return log.messages[0]?.sessionId as UUID | undefined
}

export function isLiteListing(log: SessionListing): boolean {
  return log.messages.length === 0 && log.sessionId !== undefined
}

export async function fillSessionListing(log: SessionListing): Promise<SessionListing> {
  if (!isLiteListing(log)) {
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
      messageCount: visibleTurnCount(transcript),
      summary: mostRecentLeaf
        ? summaries.get(mostRecentLeaf.uuid)
        : log.summary,
      gitBranch: mostRecentLeaf?.gitBranch ?? log.gitBranch,
      isSidechain: transcript[0]?.isSidechain ?? log.isSidechain,
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
): Promise<SessionListing[]> {
  const { limit, exact } = options || {}
  const allStatLogs = await getStatOnlyLogsForWorktrees(await getWorktreePaths(getOriginalCwd()))
  const { logs } = await enrichSessionListings(allStatLogs, 0, allStatLogs.length)
  const wanted = query.toLowerCase().trim()
  const titled = logs.filter(log => {
    const title = log.customTitle?.toLowerCase().trim()
    return Boolean(title) && (exact ? title === wanted : title!.includes(wanted))
  })
  const newest = newestPerKey(titled, sessionIdOfListing).sort((a, b) => b.modified.getTime() - a.modified.getTime())
  return limit ? newest.slice(0, limit) : newest
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
  SessionListing,
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
    mode: fold.modes.get(sessionId) as SessionListing['mode'],
    advisor: fold.advisorSwitches.get(sessionId),
    model: fold.sessionModels.get(sessionId),
    worktreeSession: fold.worktreeStates.has(sessionId) ? fold.worktreeStates.get(sessionId) : undefined,
    prNumber: fold.prNumbers.get(sessionId),
    prUrl: fold.prUrls.get(sessionId),
    prRepository: fold.prRepositories.get(sessionId),
  }
}

export async function lastSession(
  sessionId: UUID,
): Promise<SessionListing | null> {
  const fold = await loadSessionFile(sessionId)
  const { messages, summaries } = fold
  if (messages.size === 0) return null
  if (!getSessionMessages.cache.has(sessionId)) {
    getSessionMessages.cache.set(
      sessionId,
      Promise.resolve(new Set(messages.keys())),
    )
  }
  const leaf = findLatestMessage(messages.values(), m => !m.isSidechain)
  if (!leaf) return null
  const chain = buildConversationChain(messages, leaf)
  return {
    ...chainLogOption(chain, chain.at(-1)!, getTranscriptPathForSession(sessionId)),
    summary: summaries.get(leaf.uuid),
    ...resumeFactsOf(fold, sessionId, chain),
  }
}

export async function listProjectSessions(limit?: number): Promise<SessionListing[]> {
  const rows = await listSessions(limit)
  return numbered((await enrichSessionListings(rows, 0, rows.length)).logs)
}

export async function listSessionsAcrossProjects(
  limit?: number,
  options?: { skipIndex?: boolean; initialEnrichCount?: number },
): Promise<SessionListing[]> {
  if (options?.skipIndex) return loadAllProjectsMessageLogsFull(limit)
  const page = await listSessionsAcrossProjectsProgressive(limit, options?.initialEnrichCount ?? INITIAL_ENRICH_COUNT)
  return page.logs
}

async function projectDirectories(projectsDir: string, failed?: (error: unknown) => void): Promise<string[] | null> {
  try {
    const dirents = await readdir(projectsDir, { withFileTypes: true })
    return dirents.filter(dirent => dirent.isDirectory()).map(dirent => join(projectsDir, dirent.name))
  } catch (error) {
    failed?.(error)
    return null
  }
}

async function progressivePage(allStatLogs: SessionListing[], initialEnrichCount: number): Promise<SessionPage> {
  const { logs, nextIndex } = await enrichSessionListings(allStatLogs, 0, initialEnrichCount)
  return { logs: renumbered(logs), allStatLogs, nextIndex }
}

async function loadAllProjectsMessageLogsFull(
  limit?: number,
): Promise<SessionListing[]> {
  const projectDirs = await projectDirectories(getProjectsDir())
  if (!projectDirs) return []
  const logsPerProject = await mapWithConcurrency(projectDirs, discoveryPoolWidth(), projectDir =>
    getLogsWithoutIndex(projectDir, limit),
  )
  return numbered(newestPerKey(logsPerProject.flat(), log => `${log.sessionId ?? ''}:${log.leafUuid ?? ''}`))
}

const LISTING_MEMO_TTL_MS = 5_000
interface ListingMemo {
  key: string
  truth: string
  at: number
  result: SessionPage
}
let listingMemo: ListingMemo | null = null
let listingFlight: { key: string; promise: Promise<SessionPage> } | null = null
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

function shareListing(result: SessionPage): SessionPage {
  return {
    logs: result.logs.map(log => ({ ...log })),
    allStatLogs: result.allStatLogs.map(log => ({ ...log })),
    nextIndex: result.nextIndex,
  }
}

export function invalidateSessionListingMemo(): void {
  listingMemo = null
}

export async function listSessionsAcrossProjectsProgressive(
  limit?: number,
  initialEnrichCount: number = INITIAL_ENRICH_COUNT,
): Promise<SessionPage> {
  const projectsDir = getProjectsDir()
  const projectDirs = await projectDirectories(projectsDir)
  if (!projectDirs) return { logs: [], allStatLogs: [], nextIndex: 0 }

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
): Promise<SessionPage> {
  listingCensus.sweeps++
  const perProject = await mapWithConcurrency(projectDirs, discoveryPoolWidth(), projectDir =>
    sessionFilesLite(projectDir, limit),
  )
  return progressivePage(numbered(newestPerKey(perProject.flat(), log => log.sessionId)), initialEnrichCount)
}

export type SessionPage = {
  logs: SessionListing[]
  allStatLogs: SessionListing[]
  nextIndex: number
}

export async function listRepoSessions(
  worktreePaths: string[],
  limit?: number,
  initialEnrichCount: number = INITIAL_ENRICH_COUNT,
): Promise<SessionListing[]> {
  const page = await listRepoSessionsProgressive(worktreePaths, limit, initialEnrichCount)
  return page.logs
}

export async function listRepoSessionsProgressive(
  worktreePaths: string[],
  limit?: number,
  initialEnrichCount: number = INITIAL_ENRICH_COUNT,
): Promise<SessionPage> {
  logForDebugging(
    `/sessions: loading sessions for cwd=${getOriginalCwd()}, worktrees=[${worktreePaths.join(', ')}]`,
  )
  const allStatLogs = await getStatOnlyLogsForWorktrees(worktreePaths, limit)
  logForDebugging(`/sessions: found ${allStatLogs.length} session files on disk`)
  return progressivePage(allStatLogs, initialEnrichCount)
}

function worktreeStores(projectDirs: string[], worktreePaths: string[]): Array<{ dir: string; wtPath: string }> {
  const spelled = (name: string): string => (process.platform === 'win32' ? name.toLowerCase() : name)
  const slugs = worktreePaths
    .map(wtPath => ({ wtPath, prefix: spelled(sanitizePath(wtPath)) }))
    .sort((a, b) => b.prefix.length - a.prefix.length)
  const claimed = new Set<string>()
  const stores: Array<{ dir: string; wtPath: string }> = []
  for (const dir of projectDirs) {
    const name = spelled(basename(dir))
    if (claimed.has(name)) continue
    const owner = slugs.find(({ prefix }) => name === prefix || name.startsWith(prefix + '-'))
    if (!owner) continue
    claimed.add(name)
    stores.push({ dir, wtPath: owner.wtPath })
  }
  return stores
}

async function getStatOnlyLogsForWorktrees(
  worktreePaths: string[],
  limit?: number,
): Promise<SessionListing[]> {
  const cwd = getOriginalCwd()
  if (worktreePaths.length <= 1) return sessionFilesLite(getProjectDir(cwd), undefined, cwd)
  const projectsDir = getProjectsDir()
  const projectDirs = await projectDirectories(projectsDir, e =>
    logForDebugging(`Failed to read projects dir ${projectsDir}, falling back to current project: ${e}`),
  )
  if (!projectDirs) return sessionFilesLite(getProjectDir(cwd), limit, cwd)
  const matched = worktreeStores(projectDirs, worktreePaths)
  const perDir = await mapWithConcurrency(matched, discoveryPoolWidth(), ({ dir, wtPath }) =>
    sessionFilesLite(dir, undefined, wtPath),
  )
  return numbered(newestPerKey(perDir.flat(), log => log.sessionId))
}

export async function getAgentTranscript(agentId: AgentId): Promise<{
  messages: Message[]
  contentReplacements: ContentReplacementRecord[]
} | null> {
  const agentFile = getAgentTranscriptPath(agentId)
  try {
    const { messages, agentContentReplacements } = await loadTranscriptFile(agentFile)
    const own = [...messages.values()].filter(msg => msg.agentId === agentId && msg.isSidechain)
    const parents = new Set(own.map(msg => msg.parentUuid))
    const leaf = findLatestMessage(own, msg => !parents.has(msg.uuid))
    if (!leaf) return null
    const chain = buildConversationChain(messages, leaf).filter(msg => msg.agentId === agentId)
    const first = chain.find(msg => msg.type === 'assistant' || (msg.type === 'user' && msg.isMeta !== true))
    const prefix = first === undefined ? undefined : findLatestMessage(own, msg =>
      msg.sessionId === leaf.sessionId && msg.type === 'attachment' && msg.attachment.type === 'bound_prefix' &&
      msg.attachment.boundKey.split('|').at(-2) === first.uuid,
    )
    if (prefix !== undefined && !chain.some(msg => msg.uuid === prefix.uuid)) chain.push(prefix)
    return {
      messages: chain.map(({ isSidechain, parentUuid, ...msg }) => msg),
      contentReplacements: agentContentReplacements.get(agentId) ?? [],
    }
  } catch {
    return null
  }
}

function progressAgentId(message: Message): string | undefined {
  if (message.type !== 'progress' || !message.data || typeof message.data !== 'object' || !('type' in message.data)) return undefined
  const { type, agentId } = message.data as { type?: unknown; agentId?: unknown }
  return (type === 'agent_progress' || type === 'skill_progress') && typeof agentId === 'string' ? agentId : undefined
}

export function extractAgentIdsFromMessages(messages: Message[]): string[] {
  return uniq(messages.flatMap(message => {
    const agentId = progressAgentId(message)
    return agentId === undefined ? [] : [agentId]
  }))
}

async function subagentMessages(agentId: string): Promise<Message[] | null> {
  try {
    const transcript = await getAgentTranscript(asAgentId(agentId))
    return transcript && transcript.messages.length > 0 ? transcript.messages : null
  } catch {
    return null
  }
}

export async function loadSubagentTranscripts(
  agentIds: string[],
): Promise<{ [agentId: string]: Message[] }> {
  const loaded = await Promise.all(agentIds.map(async agentId => [agentId, await subagentMessages(agentId)] as const))
  return Object.fromEntries(loaded.filter((entry): entry is readonly [string, Message[]] => entry[1] !== null))
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
  const agentIds = entries.flatMap(entry => {
    const agentId = entry.isFile() ? /^agent-(.*)\.jsonl$/.exec(entry.name)?.[1] : undefined
    return agentId === undefined ? [] : [agentId]
  })
  return loadSubagentTranscripts(agentIds)
}

export async function sessionAtIndex(index: number): Promise<SessionListing | null> {
  const logs = await listProjectSessions()
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

function statSessionFiles(projectDir: string): Promise<IndexedSession[]> {
  return sessionFiles(projectDir, {
    concurrency: discoveryPoolWidth(),
    failed: path => logForDebugging(`Failed to stat session file: ${path}`),
  })
}

async function newestSessionFiles(projectDir: string, limit?: number): Promise<IndexedSession[]> {
  const files = (await statSessionFiles(projectDir)).sort((a, b) => b.mtime - a.mtime)
  return limit && files.length > limit ? files.slice(0, limit) : files
}

export async function sessionFilesWithMtime(
  projectDir: string,
): Promise<
  Map<string, { path: string; mtime: number; ctime: number; size: number }>
> {
  const rows = await statSessionFiles(projectDir)
  return new Map(rows.map(({ sessionId, ...row }) => [sessionId, row]))
}

export async function transcriptCensus(): Promise<{
  count: number
  bytes: number
  oldestMtimeMs: number | null
}> {
  const projectDirs = await projectDirectories(getProjectsDir())
  if (!projectDirs) return { count: 0, bytes: 0, oldestMtimeMs: null }
  const perProject = await mapWithConcurrency(projectDirs, discoveryPoolWidth(), projectDir =>
    sessionFilesWithMtime(projectDir),
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
  customTitle?: string
  summary?: string
  tag?: string
  agentSetting?: string
  prNumber?: number
  prUrl?: string
  prRepository?: string
  endedOnError?: boolean
}

const byTimestamp = (a: TranscriptMessage, b: TranscriptMessage): number =>
  a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0

export async function listingsOfSessionFile(
  sessionFile: string,
  projectPathOverride?: string,
): Promise<SessionListing[]> {
  const fold = await loadTranscriptFile(sessionFile, { keepAllLeaves: true })
  const { messages, summaries, leafUuids } = fold
  if (messages.size === 0) return []
  const rows = transcriptRows(messages)
  const logs: SessionListing[] = []
  for (const leaf of messages.values()) {
    if (!leafUuids.has(leaf.uuid)) continue
    const chain = buildConversationChain(messages, leaf)
    if (chain.length === 0) continue
    chain.push(...rows.childrenOf(leaf.uuid).filter(row => !leafUuids.has(row.uuid)).sort(byTimestamp))
    const first = chain[0]!
    const sessionId = leaf.sessionId as UUID
    logs.push({
      ...chainLogOption(chain, leaf, sessionFile),
      isSidechain: first.isSidechain ?? false,
      sessionId,
      summary: summaries.get(leaf.uuid),
      projectPath: projectPathOverride ?? first.cwd,
      ...resumeFactsOf(fold, sessionId, chain),
    })
  }
  return logs
}

async function getLogsWithoutIndex(
  projectDir: string,
  limit?: number,
): Promise<SessionListing[]> {
  const logs: SessionListing[] = []
  for (const file of await newestSessionFiles(projectDir, limit)) {
    try {
      logs.push(...(await listingsOfSessionFile(file.path)))
    } catch {
      logForDebugging(`Failed to load session file: ${file.path}`)
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

function liteLogOption(file: IndexedSession, projectPath?: string): SessionListing {
  return {
    date: new Date(file.mtime).toISOString(),
    messages: [],
    isLite: true,
    fullPath: file.path,
    value: 0,
    created: new Date(file.ctime),
    modified: new Date(file.mtime),
    firstPrompt: '',
    fileSize: file.size,
    isSidechain: false,
    sessionId: file.sessionId,
    projectPath,
  }
}

export async function sessionFilesLite(
  projectDir: string,
  limit?: number,
  projectPath?: string,
): Promise<SessionListing[]> {
  const files = await newestSessionFiles(projectDir, limit)
  return numbered(files.map(file => liteLogOption(file, projectPath)))
}

async function enrichLog(
  log: SessionListing,
  readBuf: Buffer,
): Promise<SessionListing | null> {
  if (!log.isLite || !log.fullPath) return log
  const meta = await readLiteMetadata(log.fullPath, log.fileSize ?? 0, readBuf)
  const enriched: SessionListing = {
    ...log,
    isLite: false,
    firstPrompt: meta.firstPrompt || (meta.customTitle ? '' : '(session)'),
    gitBranch: meta.gitBranch,
    isSidechain: meta.isSidechain,
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
  const hidden = enriched.isSidechain ? 'isSidechain=true' : undefined
  if (hidden) {
    logForDebugging(`Session ${log.sessionId} filtered from /sessions: ${hidden}`)
    return null
  }
  return enriched
}

export async function enrichSessionListings(
  allLogs: SessionListing[],
  startIndex: number,
  count: number,
): Promise<{ logs: SessionListing[]; nextIndex: number }> {
  const readBuf = Buffer.alloc(LITE_READ_BUF_SIZE)
  const logs: SessionListing[] = []
  let nextIndex = startIndex
  while (nextIndex < allLogs.length && logs.length < count) {
    const enriched = await enrichLog(allLogs[nextIndex++]!, readBuf)
    if (enriched) logs.push(enriched)
  }
  const scanned = nextIndex - startIndex
  const filtered = scanned - logs.length
  if (filtered > 0) {
    logForDebugging(
      `/sessions: enriched ${scanned} sessions, ${filtered} filtered out, ${logs.length} visible (${allLogs.length - nextIndex} remaining on disk)`,
    )
  }
  return { logs, nextIndex }
}
