import type { UUID } from 'crypto'
import type { Dirent } from 'fs'
import { readdir, stat } from 'fs/promises'
import { basename, join } from 'path'
import { partiallySanitizeUnicode } from '../sanitization.js'
import {
  getOriginalCwd,
  getSessionId,
  getSessionProjectDir,
} from '../../bootstrap/state.js'
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
import { foldPathCase } from '../platform/paths.js'
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
import { promptLabel, readSessionLabelFacts, sessionFiles, sessionPromptFromWindow, type IndexedSession } from './sessionIndex.js'
import { missionGoalBeside } from '../mission/missionCard.js'
import { transcriptRows } from './rowGraph.js'
import type { SessionMetaFields } from './sessionMeta.js'
import { isBuiltInCommandName } from './builtInCommands.js'
import { errorMessage, getErrnoCode } from '../errors.js'
import { passedOver } from '../passedOver.js'

export type SessionReadFailures = {
  count: number
  firstPath: string
  firstError: string
}

export function formatSessionReadFailures(failures: SessionReadFailures | undefined | null): string | null {
  if (!failures || failures.count <= 0) return null
  return `${failures.count} sessions or folders could not be read and are not listed (first: ${failures.firstPath}: ${failures.firstError})`
}

export function mergeSessionReadFailures(
  a: SessionReadFailures | undefined,
  b: SessionReadFailures | undefined,
): SessionReadFailures | undefined {
  if (!a || a.count <= 0) return b && b.count > 0 ? b : undefined
  if (!b || b.count <= 0) return a
  return { count: a.count + b.count, firstPath: a.firstPath, firstError: a.firstError }
}

function isAbsenceError(error: unknown): boolean {
  const code = getErrnoCode(error)
  return code === 'ENOENT' || code === 'ENOTDIR'
}

type FailureCollector = {
  add: (path: string, error: unknown) => void
  summary: () => SessionReadFailures | undefined
}

function createFailureCollector(): FailureCollector {
  let count = 0
  let firstPath = ''
  let firstError = ''
  return {
    add(path: string, error: unknown): void {
      count++
      if (count === 1) {
        firstPath = path
        firstError = errorMessage(error)
      }
    },
    summary(): SessionReadFailures | undefined {
      return count > 0 ? { count, firstPath, firstError } : undefined
    },
  }
}

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
    ...(fullPath !== undefined ? { fullPath } : {}),
    value: 0,
    created: new Date(first.timestamp),
    modified: new Date(anchor.timestamp),
    firstPrompt: extractFirstPrompt(chain),
    messageCount: visibleTurnCount(chain),
    isSidechain: first.isSidechain,
    leafUuid: anchor.uuid,
    projectPath: first.cwd,
    ...(anchor.gitBranch !== undefined ? { gitBranch: anchor.gitBranch } : {}),
  }
}

function newestPerKey(logs: SessionListing[], keyOf: (log: SessionListing) => string | undefined): SessionListing[] {
  const byKey = new Map<string, SessionListing>()
  for (const log of logs) {
    const key = keyOf(log)
    if (!key) continue
    const existing = byKey.get(key)
    if (!existing || log.modified.getTime() > existing.modified.getTime()) {
      byKey.set(key, log)
    }
  }
  return [...byKey.values()]
}

function numberInOrder(logs: SessionListing[]): SessionListing[] {
  for (let i = 0; i < logs.length; i++) logs[i]!.value = i
  return logs
}

function numbered(logs: SessionListing[]): SessionListing[] {
  return numberInOrder(sortSessionListings(logs))
}

export async function listSessions(limit?: number): Promise<SessionListing[]> {
  const cwd = getOriginalCwd()
  return sessionFilesLite(getProjectDir(cwd), limit, cwd)
}

export async function saveCustomTitle(
  sessionId: UUID,
  customTitle: string,
  fullPath?: string,
  _source?: 'user' | 'auto',
): Promise<void> {
  getProject().metadata.write(
    { type: 'custom-title', customTitle: partiallySanitizeUnicode(customTitle), sessionId },
    fullPath ?? getTranscriptPathForSession(sessionId),
  )
  invalidateSessionListingMemo()
}

export function saveAiGeneratedTitle(sessionId: UUID, aiTitle: string): void {
  appendEntryToFile(getTranscriptPathForSession(sessionId), {
    type: 'ai-title',
    sessionId,
    aiTitle: partiallySanitizeUnicode(aiTitle),
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

export async function saveTag(sessionId: UUID, tag: string, fullPath?: string): Promise<void> {
  getProject().metadata.write(
    { type: 'tag', tag, sessionId },
    fullPath ?? getTranscriptPathForSession(sessionId),
  )
}

export async function linkSessionToPR(
  sessionId: UUID,
  prNumber: number,
  prUrl: string,
  prRepository: string,
  fullPath?: string,
): Promise<void> {
  getProject().metadata.write(
    {
      type: 'pr-link',
      sessionId,
      prNumber,
      prUrl,
      prRepository,
      timestamp: new Date().toISOString(),
    },
    fullPath ?? getTranscriptPathForSession(sessionId),
  )
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
  const project = getProject()
  project.metadata.oweBriefs()
  project.reAppendSessionMetadata()
}

export async function saveAgentName(
  sessionId: UUID,
  agentName: string,
  fullPath?: string,
  _source?: 'user' | 'auto',
): Promise<void> {
  getProject().metadata.write(
    { type: 'agent-name', agentName, sessionId },
    fullPath ?? getTranscriptPathForSession(sessionId),
  )
  if (sessionId === getSessionId()) {
    void updateSessionName(agentName)
  }
}

export async function saveAgentColor(
  sessionId: UUID,
  agentColor: string,
  fullPath?: string,
): Promise<void> {
  getProject().metadata.write(
    { type: 'agent-color', agentColor, sessionId },
    fullPath ?? getTranscriptPathForSession(sessionId),
  )
}

export function saveAgentSetting(agentSetting: string): void {
  getProject().currentSessionAgentSetting = agentSetting
}

export function saveSessionBrief(field: 'brief' | 'briefAdd', text: string | null): void {
  getProject().metadata.setBrief(field, text)
}

export function carrySessionBriefs(): void {
  getProject().metadata.oweBriefs()
}

export function cacheSessionTitle(customTitle: string): void {
  getProject().currentSessionTitle = partiallySanitizeUnicode(customTitle)
}

export function saveMode(mode: 'coordinator' | 'normal'): void {
  getProject().currentSessionMode = mode
}

export function saveAdvisorSwitch(on: boolean): void {
  getProject().metadata.saveCached('advisor-switch', on)
}

export function saveSwarmSwitch(on: boolean): void {
  getProject().metadata.saveCached('swarm-switch', on)
}

export function saveSessionModel(model: string): void {
  getProject().metadata.saveCached('model', model)
}

export function saveWorktreeState(
  worktreeSession: PersistedWorktreeSession | null,
): void {
  const persisted: PersistedWorktreeSession | null = worktreeSession
    ? {
        originalCwd: worktreeSession.originalCwd,
        worktreePath: worktreeSession.worktreePath,
        worktreeName: worktreeSession.worktreeName,
        worktreeBranch: worktreeSession.worktreeBranch,
        originalBranch: worktreeSession.originalBranch,
        originalHeadCommit: worktreeSession.originalHeadCommit,
        sessionId: worktreeSession.sessionId,
        tmuxSessionName: worktreeSession.tmuxSessionName,
      }
    : null
  getProject().metadata.saveCached('worktree-state', persisted)
}

export function sessionIdOfListing(log: SessionListing): UUID | undefined {
  return (log.sessionId as UUID | undefined) || log.messages[0]?.sessionId
}

export function isLiteListing(log: SessionListing): boolean {
  return log.messages.length === 0 && log.sessionId !== undefined
}

export async function fillSessionListing(log: SessionListing): Promise<SessionListing> {
  if (!isLiteListing(log) || !log.fullPath) return log
  try {
    const loaded = await loadTranscriptFile(log.fullPath)
    if (loaded.messages.size === 0) return log
    const leaf = findLatestMessage(
      loaded.messages.values(),
      msg => loaded.leafUuids.has(msg.uuid) && (msg.type === 'user' || msg.type === 'assistant'),
    )
    if (!leaf) return log
    const chain = buildConversationChain(loaded.messages, leaf)
    const first = chain[0]
    const sessionId = (leaf.sessionId || log.sessionId) as UUID
    const summary = loaded.summaries.get(leaf.uuid)
    return {
      ...log,
      messages: removeExtraFields(chain),
      firstPrompt: extractFirstPrompt(chain),
      messageCount: visibleTurnCount(chain),
      ...(summary !== undefined ? { summary } : {}),
      ...(leaf.gitBranch ? { gitBranch: leaf.gitBranch } : {}),
      ...(first?.isSidechain !== undefined ? { isSidechain: first.isSidechain } : {}),
      leafUuid: leaf.uuid,
      ...resumeFactsOf(loaded, sessionId, chain),
    }
  } catch (error) {
    passedOver(error)
    return log
  }
}

export async function searchSessionsByCustomTitle(
  query: string,
  options?: { limit?: number; exact?: boolean },
): Promise<SessionListing[]> {
  const worktreePaths = await getWorktreePaths(getOriginalCwd())
  const statLogs = await getStatOnlyLogsForWorktrees(worktreePaths)
  const { logs } = await enrichSessionListings(statLogs, 0, statLogs.length)
  const normalizedQuery = query.trim().toLowerCase()
  const exact = options?.exact === true
  const matched = logs.filter(log => {
    const title = log.customTitle?.trim().toLowerCase()
    if (!title) return false
    return exact ? title === normalizedQuery : title.includes(normalizedQuery)
  })
  const ordered = numbered(newestPerKey(matched, sessionIdOfListing))
  return options?.limit ? ordered.slice(0, options.limit) : ordered
}

export function clearSessionMessagesCache(): void {
  getSessionMessages.cache.clear?.()
}

export async function doesMessageExistInSession(
  sessionId: UUID,
  messageUuid: UUID,
): Promise<boolean> {
  const messages = await getSessionMessages(sessionId)
  return messages.has(messageUuid)
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
  | 'brief'
  | 'briefAdd'
  | 'customTitle'
  | 'tag'
  | 'mode'
  | 'advisor'
  | 'swarm'
  | 'model'
  | 'worktreeSession'
  | 'prNumber'
  | 'prUrl'
  | 'prRepository'
  | 'turnEnd'
  | 'turnOpen'
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
    brief: fold.sessionBriefs.get(sessionId),
    briefAdd: fold.sessionBriefAdds.get(sessionId),
    customTitle: fold.customTitles.get(sessionId),
    tag: fold.tags.get(sessionId),
    mode: fold.modes.get(sessionId) as SessionListing['mode'],
    advisor: fold.advisorSwitches.get(sessionId),
    swarm: fold.swarmSwitches.get(sessionId),
    model: fold.sessionModels.get(sessionId),
    worktreeSession: fold.worktreeStates.has(sessionId) ? fold.worktreeStates.get(sessionId) : undefined,
    prNumber: fold.prNumbers.get(sessionId),
    prUrl: fold.prUrls.get(sessionId),
    prRepository: fold.prRepositories.get(sessionId),
    turnEnd: fold.turnEnds.get(sessionId),
    ...(fold.turnsOpen.has(sessionId) ? { turnOpen: true } : {}),
  }
}

export async function lastSession(
  sessionId: UUID,
): Promise<SessionListing | null> {
  const fold = await loadSessionFile(sessionId)
  if (fold.messages.size === 0) return null
  const leaf = resumeLeafOf(fold.messages)
  if (!leaf) return null
  const chain = buildConversationChain(fold.messages, leaf)
  const anchor = chain.at(-1) ?? leaf
  const summary = fold.summaries.get(leaf.uuid)
  return {
    ...chainLogOption(chain, anchor, getTranscriptPathForSession(sessionId)),
    sessionId,
    ...(summary !== undefined ? { summary } : {}),
    ...resumeFactsOf(fold, sessionId, chain),
  }
}

export function resumeLeafOf(messages: Map<UUID, TranscriptMessage>): TranscriptMessage | undefined {
  const nonSidechainParents = new Set<UUID>()
  for (const msg of messages.values()) {
    if (!msg.isSidechain && msg.parentUuid) nonSidechainParents.add(msg.parentUuid)
  }
  return (
    findLatestMessage(
      messages.values(),
      msg => !msg.isSidechain && !nonSidechainParents.has(msg.uuid),
    ) ?? findLatestMessage(messages.values(), msg => !msg.isSidechain)
  )
}

export async function listProjectSessions(limit?: number): Promise<SessionListing[]> {
  const lite = await listSessions(limit)
  const { logs } = await enrichSessionListings(lite, 0, lite.length)
  return numbered(logs)
}

export async function listSessionsAcrossProjects(
  limit?: number,
  options?: { skipIndex?: boolean; initialEnrichCount?: number },
): Promise<SessionListing[]> {
  if (!options?.skipIndex) {
    const page = await listSessionsAcrossProjectsProgressive(
      limit,
      options?.initialEnrichCount ?? INITIAL_ENRICH_COUNT,
    )
    return page.logs
  }
  const projectDirs = await projectDirectories(getProjectsDir())
  if (!projectDirs) return []
  const perProject = await mapWithConcurrency(projectDirs, discoveryPoolWidth(), async projectDir => {
    const files = await newestSessionFiles(projectDir, limit)
    const perFile = await mapWithConcurrency(files, discoveryPoolWidth(), async file => {
      try {
        return await listingsOfSessionFile(file.path)
      } catch (error) {
        passedOver(error)
        logForDebugging(`Failed to load session file: ${file.path}`)
        return []
      }
    })
    return perFile.flat()
  })
  return numbered(
    newestPerKey(perProject.flat(), log => `${log.sessionId ?? ''}:${log.leafUuid ?? ''}`),
  )
}

async function projectDirectories(
  projectsDir: string,
  failed?: (error: unknown) => void,
): Promise<string[] | null> {
  try {
    const entries = await readdir(projectsDir, { withFileTypes: true })
    return entries.filter(entry => entry.isDirectory()).map(entry => join(projectsDir, entry.name))
  } catch (error) {
    failed?.(error)
    return null
  }
}

async function progressivePage(
  allStatLogs: SessionListing[],
  initialEnrichCount: number,
  priorFailures?: SessionReadFailures,
): Promise<SessionPage> {
  const { logs, nextIndex, readFailures } = await enrichSessionListings(
    allStatLogs,
    0,
    initialEnrichCount,
  )
  numberInOrder(logs)
  const merged = mergeSessionReadFailures(priorFailures, readFailures)
  return {
    logs,
    allStatLogs,
    nextIndex,
    ...(merged ? { readFailures: merged } : {}),
  }
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
  } catch (error) {
    passedOver(error)
    return null
  }
}

function shareListing(result: SessionPage): SessionPage {
  return {
    logs: result.logs.map(log => ({ ...log })),
    allStatLogs: result.allStatLogs.map(log => ({ ...log })),
    nextIndex: result.nextIndex,
    ...(result.readFailures ? { readFailures: { ...result.readFailures } } : {}),
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
  const rootFailures = createFailureCollector()
  const projectDirs = await projectDirectories(projectsDir, error => {
    if (!isAbsenceError(error)) rootFailures.add(projectsDir, error)
  })
  if (!projectDirs) {
    const readFailures = rootFailures.summary()
    return { logs: [], allStatLogs: [], nextIndex: 0, ...(readFailures ? { readFailures } : {}) }
  }

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
    if (truth !== null && !result.readFailures) listingMemo = { key, truth, at: Date.now(), result }
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
  const collector = createFailureCollector()
  const perProject = await mapWithConcurrency(projectDirs, discoveryPoolWidth(), projectDir =>
    sessionFilesLite(projectDir, limit, undefined, collector.add),
  )
  return progressivePage(
    numbered(newestPerKey(perProject.flat(), log => log.sessionId)),
    initialEnrichCount,
    collector.summary(),
  )
}

export type SessionPage = {
  logs: SessionListing[]
  allStatLogs: SessionListing[]
  nextIndex: number
  readFailures?: SessionReadFailures
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
  const collector = createFailureCollector()
  const allStatLogs = await getStatOnlyLogsForWorktrees(worktreePaths, limit, collector.add)
  logForDebugging(`/sessions: found ${allStatLogs.length} session files on disk`)
  return progressivePage(allStatLogs, initialEnrichCount, collector.summary())
}

function worktreeStores(projectDirs: string[], worktreePaths: string[]): Array<{ dir: string; wtPath: string }> {
  const spelled = (name: string): string => foldPathCase(name)
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
  onReadError?: (path: string, error: unknown) => void,
): Promise<SessionListing[]> {
  const cwd = getOriginalCwd()
  if (worktreePaths.length <= 1) return sessionFilesLite(getProjectDir(cwd), undefined, cwd, onReadError)
  const projectsDir = getProjectsDir()
  const projectDirs = await projectDirectories(projectsDir, e => {
    logForDebugging(`The projects folder ${projectsDir} could not be listed; only the current project's sessions are shown (${e})`)
    if (!isAbsenceError(e)) onReadError?.(projectsDir, e)
  })
  if (!projectDirs) return sessionFilesLite(getProjectDir(cwd), limit, cwd, onReadError)
  const matched = worktreeStores(projectDirs, worktreePaths)
  const perDir = await mapWithConcurrency(matched, discoveryPoolWidth(), ({ dir, wtPath }) =>
    sessionFilesLite(dir, undefined, wtPath, onReadError),
  )
  return numbered(newestPerKey(perDir.flat(), log => log.sessionId))
}

export async function getAgentTranscript(agentId: AgentId): Promise<{
  messages: Message[]
  contentReplacements: ContentReplacementRecord[]
} | null> {
  const agentFile = getAgentTranscriptPath(agentId)
  const { messages, agentContentReplacements } = await loadTranscriptFile(agentFile, { throwOnError: true })
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
  } catch (error) {
    passedOver(error)
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
  } catch (error) {
    passedOver(error)
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
  const callsIt = (message: TranscriptMessage): boolean =>
    message.type === 'assistant' &&
    Array.isArray(message.message.content) &&
    message.message.content.some(block => block.type === 'tool_use' && block.id === toolUseId)
  const answersIt = (message: TranscriptMessage): boolean =>
    message.type === 'user' &&
    Array.isArray(message.message.content) &&
    message.message.content.some(block => block.type === 'tool_result' && block.tool_use_id === toolUseId)
  try {
    const { messages } = await loadTranscriptFile(getTranscriptPath())
    const rows = [...messages.values()]
    if (rows.some(answersIt)) return null
    return (rows.findLast(callsIt) as AssistantMessage | undefined) ?? null
  } catch (error) {
    passedOver(error)
    return null
  }
}

function statSessionFiles(
  projectDir: string,
  onReadError?: (path: string, error: unknown) => void,
): Promise<IndexedSession[]> {
  return sessionFiles(projectDir, {
    concurrency: discoveryPoolWidth(),
    failed: (path, error) => {
      logForDebugging(`Failed to stat session file: ${path}`)
      if (error !== undefined) onReadError?.(path, error)
    },
  })
}

async function newestSessionFiles(
  projectDir: string,
  limit?: number,
  onReadError?: (path: string, error: unknown) => void,
): Promise<IndexedSession[]> {
  const files = (await statSessionFiles(projectDir, onReadError)).sort((a, b) => b.mtime - a.mtime)
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
  const maps = await mapWithConcurrency(projectDirs, discoveryPoolWidth(), dir =>
    sessionFilesWithMtime(dir),
  )
  let count = 0
  let bytes = 0
  let oldestMtimeMs: number | null = null
  for (const map of maps) {
    for (const file of map.values()) {
      count++
      bytes += file.size
      if (oldestMtimeMs === null || file.mtime < oldestMtimeMs) {
        oldestMtimeMs = file.mtime
      }
    }
  }
  return { count, bytes, oldestMtimeMs }
}

const INITIAL_ENRICH_COUNT = 50

export async function listingsOfSessionFile(
  sessionFile: string,
  projectPathOverride?: string,
): Promise<SessionListing[]> {
  const loaded = await loadTranscriptFile(sessionFile, { keepAllLeaves: true })
  if (loaded.messages.size === 0) return []
  const graph = transcriptRows(loaded.messages)
  const listings: SessionListing[] = []
  for (const [uuid, leaf] of loaded.messages) {
    if (!loaded.leafUuids.has(uuid)) continue
    const chain = buildConversationChain(loaded.messages, leaf)
    if (chain.length === 0) continue
    const trailingChildren = graph
      .childrenOf(leaf.uuid)
      .filter(child => !loaded.leafUuids.has(child.uuid))
      .sort((a, b) => (a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0))
    const fullChain = trailingChildren.length > 0 ? [...chain, ...trailingChildren] : chain
    const first = fullChain[0]!
    const summary = loaded.summaries.get(leaf.uuid)
    listings.push({
      ...chainLogOption(fullChain, leaf, sessionFile),
      sessionId: leaf.sessionId,
      ...(summary !== undefined ? { summary } : {}),
      isSidechain: first.isSidechain || false,
      projectPath: projectPathOverride ?? first.cwd,
      ...resumeFactsOf(loaded, leaf.sessionId, fullChain),
    })
  }
  return listings
}

export function extractFirstPromptFromChunk(chunk: string): string {
  return sessionPromptFromWindow(chunk, isBuiltInCommandName)
}

export async function sessionFilesLite(
  projectDir: string,
  limit?: number,
  projectPath?: string,
  onReadError?: (path: string, error: unknown) => void,
): Promise<SessionListing[]> {
  const files = await newestSessionFiles(projectDir, limit, onReadError)
  const logs: SessionListing[] = files.map(file => {
    const modified = new Date(file.mtime)
    return {
      date: modified.toISOString(),
      messages: [],
      isLite: true,
      fullPath: file.path,
      value: 0,
      created: new Date(file.ctime),
      modified,
      firstPrompt: '',
      fileSize: file.size,
      isSidechain: false,
      sessionId: file.sessionId,
      ...(projectPath !== undefined ? { projectPath } : {}),
    }
  })
  return numbered(logs)
}

type LiteLabelFacts = {
  firstPrompt: string
  isSidechain: boolean
  gitBranch?: string
  projectPath?: string
  customTitle?: string
  summary?: string
  tag?: string
  agentSetting?: string
  prNumber?: number
  prUrl?: string
  prRepository?: string
  endedOnError?: boolean
  lastTimestamp?: string
}

async function enrichLog(
  log: SessionListing,
  readBuf: Buffer,
  onReadError?: (path: string, error: unknown) => void,
): Promise<SessionListing | null> {
  if (!log.isLite || !log.fullPath) return log
  let readFailed = false
  const facts: LiteLabelFacts = await readSessionLabelFacts(
    log.fullPath,
    log.fileSize ?? 0,
    readBuf,
    isBuiltInCommandName,
    (path, error) => {
      readFailed = true
      onReadError?.(path, error)
    },
  )
  if (readFailed) return null
  if (facts.isSidechain) {
    logForDebugging(`Session ${log.sessionId} filtered from /sessions: isSidechain=true`)
    return null
  }
  const missionGoal = missionGoalBeside(log.fullPath)
  const rawFirstPrompt = missionGoal !== null ? promptLabel(missionGoal) : facts.firstPrompt
  const firstPrompt =
    rawFirstPrompt || (facts.customTitle || facts.summary ? '' : '(session)')
  const projectPath = facts.projectPath || log.projectPath
  return {
    ...log,
    isLite: false,
    date: facts.lastTimestamp || log.date,
    firstPrompt,
    isSidechain: facts.isSidechain,
    ...(facts.gitBranch !== undefined ? { gitBranch: facts.gitBranch } : {}),
    ...(facts.customTitle !== undefined ? { customTitle: facts.customTitle } : {}),
    ...(facts.summary !== undefined ? { summary: facts.summary } : {}),
    ...(facts.tag !== undefined ? { tag: facts.tag } : {}),
    ...(facts.agentSetting !== undefined ? { agentSetting: facts.agentSetting } : {}),
    ...(facts.prNumber !== undefined ? { prNumber: facts.prNumber } : {}),
    ...(facts.prUrl !== undefined ? { prUrl: facts.prUrl } : {}),
    ...(facts.prRepository !== undefined ? { prRepository: facts.prRepository } : {}),
    ...(facts.endedOnError !== undefined ? { endedOnError: facts.endedOnError } : {}),
    ...(projectPath !== undefined ? { projectPath } : {}),
  }
}

export async function enrichSessionListings(
  allLogs: SessionListing[],
  startIndex: number,
  count: number,
): Promise<{ logs: SessionListing[]; nextIndex: number; readFailures?: SessionReadFailures }> {
  const readBuf = Buffer.alloc(LITE_READ_BUF_SIZE)
  const collector = createFailureCollector()
  const logs: SessionListing[] = []
  let nextIndex = startIndex
  while (nextIndex < allLogs.length && logs.length < count) {
    const enriched = await enrichLog(allLogs[nextIndex++]!, readBuf, collector.add)
    if (enriched) logs.push(enriched)
  }
  const scanned = nextIndex - startIndex
  const filtered = scanned - logs.length
  if (filtered > 0) {
    logForDebugging(
      `/sessions: enriched ${scanned} sessions, ${filtered} filtered out, ${logs.length} visible (${allLogs.length - nextIndex} remaining on disk)`,
    )
  }
  const readFailures = collector.summary()
  return { logs, nextIndex, ...(readFailures ? { readFailures } : {}) }
}
