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
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'

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
  return notBuilt('src/utils/sessionStorage/logs.ts:162')
}

function newestPerKey(logs: SessionListing[], keyOf: (log: SessionListing) => string | undefined): SessionListing[] {
  return notBuilt('src/utils/sessionStorage/logs.ts:180')
}

function numbered(logs: SessionListing[]): SessionListing[] {
  return notBuilt('src/utils/sessionStorage/logs.ts:198')
}

export async function listSessions(limit?: number): Promise<SessionListing[]> {
  return notBuilt('src/utils/sessionStorage/logs.ts:202')
}

export async function saveCustomTitle(
  sessionId: UUID,
  customTitle: string,
  fullPath?: string,
  source?: 'user' | 'auto',
): Promise<Unbuilt> {
  return notBuilt('src/utils/sessionStorage/logs.ts:207')
}

export function saveAiGeneratedTitle(sessionId: UUID, aiTitle: string): void {
  return notBuilt('src/utils/sessionStorage/logs.ts:219')
}

export function saveTaskSummary(sessionId: UUID, summary: string): void {
  return notBuilt('src/utils/sessionStorage/logs.ts:227')
}

export async function saveTag(sessionId: UUID, tag: string, fullPath?: string): Promise<Unbuilt> {
  return notBuilt('src/utils/sessionStorage/logs.ts:236')
}

export async function linkSessionToPR(
  sessionId: UUID,
  prNumber: number,
  prUrl: string,
  prRepository: string,
  fullPath?: string,
): Promise<void> {
  return notBuilt('src/utils/sessionStorage/logs.ts:241')
}

function liveSessionFacts(sessionId: string): SessionMetaFields | undefined {
  return sessionId === getSessionId() ? getProject().metadata.fields : undefined
}

export function getCurrentSessionTag(sessionId: UUID): string | undefined {
  return notBuilt('src/utils/sessionStorage/logs.ts:256')
}

export function getCurrentSessionTitle(
  sessionId: SessionId,
): string | undefined {
  return notBuilt('src/utils/sessionStorage/logs.ts:260')
}

export function getCurrentSessionAgentColor(): string | undefined {
  return notBuilt('src/utils/sessionStorage/logs.ts:266')
}

export function restoreSessionMetadata(meta: Omit<SessionMetaFields, 'lastPrompt'>): void {
  return notBuilt('src/utils/sessionStorage/logs.ts:270')
}

export function clearSessionMetadata(): void {
  return notBuilt('src/utils/sessionStorage/logs.ts:274')
}

export function reAppendSessionMetadata(): void {
  return notBuilt('src/utils/sessionStorage/logs.ts:278')
}

export async function saveAgentName(
  sessionId: UUID,
  agentName: string,
  fullPath?: string,
  source?: 'user' | 'auto',
): Promise<Unbuilt> {
  return notBuilt('src/utils/sessionStorage/logs.ts:283')
}

export async function saveAgentColor(
  sessionId: UUID,
  agentColor: string,
  fullPath?: string,
): Promise<Unbuilt> {
  return notBuilt('src/utils/sessionStorage/logs.ts:294')
}

export function saveAgentSetting(agentSetting: string): void {
  return notBuilt('src/utils/sessionStorage/logs.ts:303')
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
  return notBuilt('src/utils/sessionStorage/logs.ts:335')
}

export function sessionIdOfListing(log: SessionListing): UUID | undefined {
  return notBuilt('src/utils/sessionStorage/logs.ts:353')
}

export function isLiteListing(log: SessionListing): boolean {
  return notBuilt('src/utils/sessionStorage/logs.ts:360')
}

export async function fillSessionListing(log: SessionListing): Promise<SessionListing> {
  return notBuilt('src/utils/sessionStorage/logs.ts:364')
}

export async function searchSessionsByCustomTitle(
  query: string,
  options?: { limit?: number; exact?: boolean },
): Promise<SessionListing[]> {
  return notBuilt('src/utils/sessionStorage/logs.ts:411')
}

export function clearSessionMessagesCache(): void {
  return notBuilt('src/utils/sessionStorage/logs.ts:427')
}

export async function doesMessageExistInSession(
  sessionId: UUID,
  messageUuid: UUID,
): Promise<boolean> {
  return notBuilt('src/utils/sessionStorage/logs.ts:431')
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
  return notBuilt('src/utils/sessionStorage/logs.ts:497')
}

export function resumeLeafOf(messages: Map<UUID, TranscriptMessage>): TranscriptMessage | undefined {
  return notBuilt('src/utils/sessionStorage/logs.ts:513')
}

export async function listProjectSessions(limit?: number): Promise<SessionListing[]> {
  return notBuilt('src/utils/sessionStorage/logs.ts:519')
}

export async function listSessionsAcrossProjects(
  limit?: number,
  options?: { skipIndex?: boolean; initialEnrichCount?: number },
): Promise<SessionListing[]> {
  return notBuilt('src/utils/sessionStorage/logs.ts:524')
}

async function projectDirectories(projectsDir: string, failed?: (error: unknown) => void): Promise<string[] | null> {
  return notBuilt('src/utils/sessionStorage/logs.ts:533')
}

async function progressivePage(
  allStatLogs: SessionListing[],
  initialEnrichCount: number,
  priorFailures?: SessionReadFailures,
): Promise<SessionPage> {
  return notBuilt('src/utils/sessionStorage/logs.ts:544')
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
  return notBuilt('src/utils/sessionStorage/logs.ts:861')
}

const INITIAL_ENRICH_COUNT: Unbuilt = unbuilt('src/utils/sessionStorage/logs.ts:886')

export async function listingsOfSessionFile(
  sessionFile: string,
  projectPathOverride?: string,
): Promise<SessionListing[]> {
  return notBuilt('src/utils/sessionStorage/logs.ts:907')
}

export function extractFirstPromptFromChunk(chunk: string): string {
  return notBuilt('src/utils/sessionStorage/logs.ts:961')
}

export async function sessionFilesLite(
  projectDir: string,
  limit?: number,
  projectPath?: string,
  onReadError?: (path: string, error: unknown) => void,
): Promise<SessionListing[]> {
  return notBuilt('src/utils/sessionStorage/logs.ts:982')
}

async function enrichLog(
  log: SessionListing,
  readBuf: Buffer,
  onReadError?: (path: string, error: unknown) => void,
): Promise<SessionListing | null> {
  return notBuilt('src/utils/sessionStorage/logs.ts:992')
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
