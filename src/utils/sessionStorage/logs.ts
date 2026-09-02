// sessionStorage/logs — the listing/labeling surface over transcript files:
// LogOption construction, session metadata persistence (titles, tags, PR
// links, agent identity), the stat-only → lite-enriched → fully-loaded
// listing ladder the resume picker rides, and subagent transcript loading.
// Mercury-owned.

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
import { COMMAND_NAME_TAG } from '../../constants/xml.js'
import { GROUND_NOTE_MARK, stripGroundNote } from '../../daemon/isolationNote.js'
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
import { jsonParse } from '../slowOperations.js'
import { extractTag } from '../messages.js'
import { sanitizePath } from '../path.js'
import {
  extractJsonStringField,
  extractLastJsonStringField,
  LITE_READ_BUF_SIZE,
  readHeadAndTail,
  readSessionLite,
  scanTailForEndedOnError,
  unescapeJsonString,
} from '../sessionStoragePortable.js'
import type { ContentReplacementRecord } from '../toolResultStorage.js'
import { validateUuid } from '../uuid.js'
import {
  buildAttributionSnapshotChain,
  buildConversationChain,
  buildFileHistorySnapshotChain,
  extractFirstPrompt,
  findLatestMessage,
  removeExtraFields,
} from './chain.js'
import { loadSessionFile, loadTranscriptFile } from './loading.js'
import {
  getAgentTranscriptPath,
  getProjectDir,
  getProjectsDir,
  getTranscriptPath,
  getTranscriptPathForSession,
} from './paths.js'
import { appendEntryToFile, getProject, getSessionMessages } from './writer.js'

// Same skip grammar as chain.ts / sessionStoragePortable.ts: lowercase
// XML-ish opening tags and the interrupt marker never label a session.
const SKIP_FIRST_PROMPT_PATTERN =
  /^(?:\s*<[a-z][\w-]*[\s>]|\[Request interrupted by user[^\]]*\])/

/**
 * One file → one LogOption, anchored at the newest leaf: the full load +
 * chain walk over a .jsonl record transcript. Throws on empty/undecodable
 * input — this is the explicit "open THIS file" path, where silence would
 * misreport a real problem; a file outside the record format throws the
 * one honest refusal line.
 */
export async function loadTranscriptFromFile(
  filePath: string,
): Promise<LogOption> {
  if (filePath.endsWith('.jsonl')) {
    const {
      messages,
      summaries,
      customTitles,
      tags,
      fileHistorySnapshots,
      attributionSnapshots,
      contextCollapseCommits,
      contextCollapseSnapshot,
      leafUuids,
      contentReplacements,
      worktreeStates,
    } = await loadTranscriptFile(filePath)

    if (messages.size === 0) {
      // Distinguish "empty session" from "not Mercury's format" — the
      // refusal line names the second honestly. One bounded head read: the
      // verdict is the first parseable line's.
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
    const customTitle = customTitles.get(leafMessage.sessionId as UUID)
    const tag = tags.get(leafMessage.sessionId as UUID)
    const sessionId = leafMessage.sessionId as UUID
    return {
      ...convertToLogOption(
        transcript,
        0,
        summary,
        customTitle,
        buildFileHistorySnapshotChain(fileHistorySnapshots, transcript),
        tag,
        filePath,
        buildAttributionSnapshotChain(attributionSnapshots, transcript),
        undefined,
        contentReplacements.get(sessionId) ?? [],
      ),
      contextCollapseCommits: contextCollapseCommits.filter(
        e => e.sessionId === sessionId,
      ),
      contextCollapseSnapshot:
        contextCollapseSnapshot?.sessionId === sessionId
          ? contextCollapseSnapshot
          : undefined,
      worktreeSession: worktreeStates.has(sessionId)
        ? worktreeStates.get(sessionId)
        : undefined,
    }
  }

  // Anything that is not a .jsonl record transcript is not a format
  // Mercury opens.
  throw new Error(TRANSCRIPT_FORMAT_REFUSAL)
}

/**
 * Would this user message paint a conversation row? Meta messages and pure
 * tool_result carriers don't — results render inside their tool's group.
 */
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

/**
 * Would this assistant message paint a row? Only non-empty text blocks do —
 * tool_use and thinking render as grouped UI, not turns.
 */
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

/** Turn count as the transcript view would paint it: visible user turns +
 *  visible assistant turns; system/attachment/progress never count. */
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
    teamName: firstMessage.teamName,
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
  appendEntryToFile(resolvedPath, {
    type: 'custom-title',
    customTitle,
    sessionId,
  })
  // The listing memo holds the old label: the next listing sweeps again.
  invalidateSessionListingMemo()
  // The live session also caches, so the new title paints immediately.
  if (sessionId === getSessionId()) {
    getProject().currentSessionTitle = customTitle
  }
}

/**
 * Persist an AI-generated title as its own `ai-title` entry — a DISTINCT
 * kind from `custom-title`, and the distinction is load-bearing:
 * - readers prefer the customTitle field, so an operator rename wins over
 *   any AI title regardless of append order;
 * - loadTranscriptFile populates customTitles only from `custom-title`
 *   entries, so resume never caches an AI title and reAppendSessionMetadata
 *   never re-appends one at EOF — the clobber-on-resume shape (stale AI
 *   title over a mid-session rename) cannot occur;
 * - VS Code's onlyIfNoCustomTitle CAS scans only the customTitle field, so
 *   AI may replace its own earlier title but never an operator's.
 *
 * Never re-appended ⇒ the entry eventually scrolls out of the 64KB tail
 * window; readers fall back to scanning the HEAD buffer for aiTitle. Both
 * reads stay bounded — never a full-file scan.
 *
 * A client holding its own stale-write guard should send persist:false and
 * write through its rename path once its guard passes, closing the race
 * where the AI title lands after a mid-flight operator rename.
 */
export function saveAiGeneratedTitle(sessionId: UUID, aiTitle: string): void {
  appendEntryToFile(getTranscriptPathForSession(sessionId), {
    type: 'ai-title',
    aiTitle,
    sessionId,
  })
}

/**
 * Rolling "what is this agent doing NOW" snapshot for `mercury ps`. Not
 * re-appended on exit (unlike titles) — staleness is acceptable, and ps
 * reads only the newest from the tail.
 */
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
  appendEntryToFile(resolvedPath, { type: 'tag', tag, sessionId })
  if (sessionId === getSessionId()) {
    getProject().currentSessionTag = tag
  }
}

/** Bind a session to a GitHub PR (number, URL, repository) for tracking
 *  and navigation; the live session caches so exit re-appends it. */
export async function linkSessionToPR(
  sessionId: UUID,
  prNumber: number,
  prUrl: string,
  prRepository: string,
  fullPath?: string,
): Promise<void> {
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  appendEntryToFile(resolvedPath, {
    type: 'pr-link',
    sessionId,
    prNumber,
    prUrl,
    prRepository,
    timestamp: new Date().toISOString(),
  })
  if (sessionId === getSessionId()) {
    const project = getProject()
    project.currentSessionPrNumber = prNumber
    project.currentSessionPrUrl = prUrl
    project.currentSessionPrRepository = prRepository
  }
}

export function getCurrentSessionTag(sessionId: UUID): string | undefined {
  // The cache covers exactly one session: the live one.
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

/**
 * Seed the in-memory metadata cache from a resumed session's disk state, so
 * banners paint and exit re-appends the right values. `??=` on the title:
 * a --name given THIS launch outranks the resumed title (REPL clears the
 * cache before plain /resume, so that path is unaffected).
 */
export function restoreSessionMetadata(meta: {
  customTitle?: string
  tag?: string
  agentName?: string
  agentColor?: string
  agentSetting?: string
  mode?: 'coordinator' | 'normal'
  worktreeSession?: PersistedWorktreeSession | null
  prNumber?: number
  prUrl?: string
  prRepository?: string
}): void {
  const project = getProject()
  if (meta.customTitle) project.currentSessionTitle ??= meta.customTitle
  if (meta.tag !== undefined) project.currentSessionTag = meta.tag || undefined
  if (meta.agentName) project.currentSessionAgentName = meta.agentName
  if (meta.agentColor) project.currentSessionAgentColor = meta.agentColor
  if (meta.agentSetting) project.currentSessionAgentSetting = meta.agentSetting
  if (meta.mode) project.currentSessionMode = meta.mode
  if (meta.worktreeSession !== undefined)
    project.currentSessionWorktree = meta.worktreeSession
  if (meta.prNumber !== undefined)
    project.currentSessionPrNumber = meta.prNumber
  if (meta.prUrl) project.currentSessionPrUrl = meta.prUrl
  if (meta.prRepository) project.currentSessionPrRepository = meta.prRepository
}

/** Drop every cached metadata field — /clear starts a new session and the
 *  old session's identity must not bleed into it. */
export function clearSessionMetadata(): void {
  const project = getProject()
  project.currentSessionTitle = undefined
  project.currentSessionTag = undefined
  project.currentSessionAgentName = undefined
  project.currentSessionAgentColor = undefined
  project.currentSessionLastPrompt = undefined
  project.currentSessionAgentSetting = undefined
  project.currentSessionMode = undefined
  project.currentSessionWorktree = undefined
  project.currentSessionPrNumber = undefined
  project.currentSessionPrUrl = undefined
  project.currentSessionPrRepository = undefined
}

/**
 * Push cached metadata back to EOF so it stays inside the bounded tail
 * window the lite reader scans. Post-compaction growth would otherwise
 * evict a /rename'd title from the window and --resume would fall back to
 * the derived firstPrompt.
 */
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
  appendEntryToFile(resolvedPath, { type: 'agent-name', agentName, sessionId })
  if (sessionId === getSessionId()) {
    getProject().currentSessionAgentName = agentName
    void updateSessionName(agentName)
  }
}

export async function saveAgentColor(
  sessionId: UUID,
  agentColor: string,
  fullPath?: string,
) {
  const resolvedPath = fullPath ?? getTranscriptPathForSession(sessionId)
  appendEntryToFile(resolvedPath, {
    type: 'agent-color',
    agentColor,
    sessionId,
  })
  if (sessionId === getSessionId()) {
    getProject().currentSessionAgentColor = agentColor
  }
}

/**
 * Cache-only until materialization: the agent setting reaches disk when
 * materializeSessionFile writes the first real message (and again on exit).
 * Writing eagerly here would mint metadata-only session files at startup.
 */
export function saveAgentSetting(agentSetting: string): void {
  getProject().currentSessionAgentSetting = agentSetting
}

/** Cache a --name title at startup; disk write waits for the first real
 *  message so an aborted launch leaves no orphan file. */
export function cacheSessionTitle(customTitle: string): void {
  getProject().currentSessionTitle = customTitle
}

/** Cache the session mode; materialization and exit stamp it to disk. */
export function saveMode(mode: 'coordinator' | 'normal'): void {
  getProject().currentSessionMode = mode
}

/**
 * Record worktree state for --resume. null is meaningful: it says the
 * session EXITED its worktree, so resume must not cd back in (undefined
 * would read as never-entered). Ephemeral run stats that ride the full
 * WorktreeSession shape are stripped before serialization.
 */
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
  const project = getProject()
  project.currentSessionWorktree = stripped
  // Mid-session enter/exit writes through immediately; at --worktree
  // startup sessionFile is still null and materialization will stamp it
  // with the first message.
  if (project.sessionFile) {
    appendEntryToFile(project.sessionFile, {
      type: 'worktree-state',
      worktreeSession: stripped,
      sessionId: getSessionId(),
    })
  }
}

/** SessionId of a log: the direct field on lite logs, the first message's
 *  stamp on full ones. */
export function getSessionIdFromLog(log: LogOption): UUID | undefined {
  if (log.sessionId) {
    return log.sessionId as UUID
  }
  return log.messages[0]?.sessionId as UUID | undefined
}

/** Lite = listed from stat only: no messages yet, sessionId known. */
export function isLiteLog(log: LogOption): boolean {
  return log.messages.length === 0 && log.sessionId !== undefined
}

/**
 * Upgrade a lite log to a full one by reading its file. Total: an
 * already-full log, a pathless log, and every load failure all return the
 * input unchanged — the picker keeps painting what it has.
 */
export async function loadFullLog(log: LogOption): Promise<LogOption> {
  if (!isLiteLog(log)) {
    return log
  }
  const sessionFile = log.fullPath
  if (!sessionFile) {
    return log
  }

  try {
    const {
      messages,
      summaries,
      customTitles,
      tags,
      agentNames,
      agentColors,
      agentSettings,
      prNumbers,
      prUrls,
      prRepositories,
      modes,
      worktreeStates,
      fileHistorySnapshots,
      attributionSnapshots,
      contentReplacements,
      contextCollapseCommits,
      contextCollapseSnapshot,
      leafUuids,
    } = await loadTranscriptFile(sessionFile)

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
    // Metadata keys by the LEAF's sessionId: a forked session copies
    // chain[0] from its source, but titles/tags were written under the
    // current session's id.
    const sessionId = mostRecentLeaf.sessionId as UUID | undefined
    return {
      ...log,
      messages: removeExtraFields(transcript),
      firstPrompt: extractFirstPrompt(transcript),
      messageCount: countVisibleMessages(transcript),
      summary: mostRecentLeaf
        ? summaries.get(mostRecentLeaf.uuid)
        : log.summary,
      customTitle: sessionId ? customTitles.get(sessionId) : log.customTitle,
      tag: sessionId ? tags.get(sessionId) : log.tag,
      agentName: sessionId ? agentNames.get(sessionId) : log.agentName,
      agentColor: sessionId ? agentColors.get(sessionId) : log.agentColor,
      agentSetting: sessionId ? agentSettings.get(sessionId) : log.agentSetting,
      mode: sessionId ? (modes.get(sessionId) as LogOption['mode']) : log.mode,
      worktreeSession:
        sessionId && worktreeStates.has(sessionId)
          ? worktreeStates.get(sessionId)
          : log.worktreeSession,
      prNumber: sessionId ? prNumbers.get(sessionId) : log.prNumber,
      prUrl: sessionId ? prUrls.get(sessionId) : log.prUrl,
      prRepository: sessionId
        ? prRepositories.get(sessionId)
        : log.prRepository,
      gitBranch: mostRecentLeaf?.gitBranch ?? log.gitBranch,
      isSidechain: transcript[0]?.isSidechain ?? log.isSidechain,
      teamName: transcript[0]?.teamName ?? log.teamName,
      leafUuid: mostRecentLeaf?.uuid ?? log.leafUuid,
      fileHistorySnapshots: buildFileHistorySnapshotChain(
        fileHistorySnapshots,
        transcript,
      ),
      attributionSnapshots: buildAttributionSnapshotChain(
        attributionSnapshots,
        transcript,
      ),
      contentReplacements: sessionId
        ? (contentReplacements.get(sessionId) ?? [])
        : log.contentReplacements,
      // Sequential file read ⇒ the commit array is already in commit
      // order, and filter preserves it.
      contextCollapseCommits: sessionId
        ? contextCollapseCommits.filter(e => e.sessionId === sessionId)
        : undefined,
      contextCollapseSnapshot:
        sessionId && contextCollapseSnapshot?.sessionId === sessionId
          ? contextCollapseSnapshot
          : undefined,
    }
  } catch {
    return log
  }
}

/**
 * Title search across the repo's worktrees: case-insensitive (exact or
 * substring), deduplicated per session keeping the newest branch, sorted
 * newest-first, optionally limited.
 */
export async function searchSessionsByCustomTitle(
  query: string,
  options?: { limit?: number; exact?: boolean },
): Promise<LogOption[]> {
  const { limit, exact } = options || {}
  const worktreePaths = await getWorktreePaths(getOriginalCwd())
  const allStatLogs = await getStatOnlyLogsForWorktrees(worktreePaths)
  // Titles live in metadata, so every candidate needs enrichment first.
  const { logs } = await enrichLogs(allStatLogs, 0, allStatLogs.length)
  const normalizedQuery = query.toLowerCase().trim()

  const matchingLogs = logs.filter(log => {
    const title = log.customTitle?.toLowerCase().trim()
    if (!title) return false
    return exact ? title === normalizedQuery : title.includes(normalizedQuery)
  })

  // Branches of one conversation share a sessionId — keep the newest.
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

/** Invalidate the memoized per-session UUID sets — required after
 *  compaction, when old message UUIDs stop being valid. */
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

export async function getLastSessionLog(
  sessionId: UUID,
): Promise<LogOption | null> {
  // One read serves everything below — never load the file twice.
  const {
    messages,
    summaries,
    customTitles,
    tags,
    agentSettings,
    worktreeStates,
    fileHistorySnapshots,
    attributionSnapshots,
    contentReplacements,
    contextCollapseCommits,
    contextCollapseSnapshot,
  } = await loadSessionFile(sessionId)
  if (messages.size === 0) return null
  // Prime the UUID-set cache from this read so recordTranscript (fired
  // right after REPL mounts on --resume) skips its own full-file load —
  // worth ~200ms on large sessions. ONLY when empty: a live session's set
  // holds unflushed UUIDs that a disk snapshot would erase, breaking dedup.
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
  const customTitle = customTitles.get(lastMessage.sessionId as UUID)
  const tag = tags.get(lastMessage.sessionId as UUID)
  const agentSetting = agentSettings.get(sessionId)
  return {
    ...convertToLogOption(
      transcript,
      0,
      summary,
      customTitle,
      buildFileHistorySnapshotChain(fileHistorySnapshots, transcript),
      tag,
      getTranscriptPathForSession(sessionId),
      buildAttributionSnapshotChain(attributionSnapshots, transcript),
      agentSetting,
      contentReplacements.get(sessionId) ?? [],
    ),
    worktreeSession: worktreeStates.get(sessionId),
    contextCollapseCommits: contextCollapseCommits.filter(
      e => e.sessionId === sessionId,
    ),
    contextCollapseSnapshot:
      contextCollapseSnapshot?.sessionId === sessionId
        ? contextCollapseSnapshot
        : undefined,
  }
}

/** The current project's session list, enriched and renumbered. */
export async function loadMessageLogs(limit?: number): Promise<LogOption[]> {
  const sessionLogs = await fetchLogs(limit)
  // fetchLogs lists stat-only; enrichment fills labels and drops
  // sidechains/agent sessions.
  const { logs: enriched } = await enrichLogs(
    sessionLogs,
    0,
    sessionLogs.length,
  )

  // enrichLogs hands back fresh objects — renumber in place rather than
  // re-spreading a 30-field LogOption per row.
  const sorted = sortLogs(enriched)
  sorted.forEach((log, i) => {
    log.value = i
  })
  return sorted
}

/** Session logs across every project dir; progressive by default, full
 *  loads (skipIndex) for consumers that need message bodies. */
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

  // This path emits one LogOption PER LEAF, so dedup keys on
  // sessionId+leafUuid (a session can span several project dirs).
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

// ── FN-020 row 8: one estate sweep shared by every listing surface ────────
// The tab strip (every boot and every in-place switch), the cockpit's solo
// RECENT lane, /sessions, /sessiontab and /resume each ran the whole
// progressive sweep on their own — one readdir per project directory, one
// stat per lifetime session file, head-plus-tail reads for the newest rows
// — and the sweeps co-fired inside one mount window. The memo below is
// single-flight (concurrent callers of one shape share the running sweep)
// and keyed by TRUTH, not trust: a completed result is served only while
// the projects root and every project directory keep their mtimes (a
// session file born or removed by ANY process — the daemon's runners write
// the transcripts — moves its directory's mtime) and for at most
// LISTING_MEMO_TTL_MS (an append to an existing transcript moves no
// directory; seconds-stale ordering is the accepted trade, the surfaces
// already seed from last-known rows). This process's own title save
// invalidates explicitly. Consumers receive fresh row objects, exactly as a
// fresh sweep handed them.
const LISTING_MEMO_TTL_MS = 5_000
interface ListingMemo {
  key: string
  truth: string
  at: number
  result: SessionLogResult
}
let listingMemo: ListingMemo | null = null
let listingFlight: { key: string; promise: Promise<SessionLogResult> } | null = null
/** PROOF CENSUS (operation-shaped, never a wall clock): sweeps actually
 *  run, listings served from the memo, callers that joined a running
 *  sweep — read by scripts/sessionStorage/prove-listing-memo.ts. */
export const listingCensus = { sweeps: 0, served: 0, joined: 0 }

/** The truth stamp: the projects root's mtime plus every project
 *  directory's name and mtime — one readdir and P stats, against the
 *  sweep's P readdirs, S stats and the enrichment reads. Null when the
 *  root cannot be stat'ed (such a listing is never memoized). */
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

/** This process moved a session's facts (a title save): the next listing
 *  sweeps again. Births and removals need no call — the directory mtime
 *  in the truth stamp sees them from every process. */
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
    // The stamp taken BEFORE the sweep: a birth during the sweep moves a
    // directory past it, so the next listing sweeps again (conservative).
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
  // A small order-preserving pool over the project dirs: a large Windows
  // history (hundreds of project dirs) paid the SUM of every serial scan
  // here — the pool overlaps them and hands back the same projectDirs-order
  // rows a serial walk produced.
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

/** A progressive listing result: what's enriched, the full stat-only list,
 *  and where enrichment should continue. */
export type SessionLogResult = {
  /** Rows already enriched and ready to paint. */
  logs: LogOption[]
  /** The complete stat-only listing — hand slices back to enrichLogs. */
  allStatLogs: LogOption[]
  /** Continuation cursor into allStatLogs for the next enrichment call. */
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

/** Stat-only listing across a repo's worktree project dirs. */
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

  // Windows: git worktree list and stored project dirs can disagree on
  // drive-letter case; compare case-insensitively there.
  const caseInsensitive = process.platform === 'win32'

  // Longest sanitized prefix first, so -code-myrepo-worktree1 matches its
  // own worktree instead of being claimed by the shorter -code-myrepo.
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

/**
 * A subagent's conversation, straight from its sidechain file: chain from
 * the newest leaf carrying the agentId, filtered to that agent, with the
 * envelope fields stripped. null when nothing matches; load failures also
 * resolve null (a missing sidechain is normal for evicted tasks).
 */
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

/**
 * Agent IDs mentioned by progress messages in a conversation — the sync
 * agents (agent_progress / skill_progress) that streamed through the turn.
 */
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

/**
 * Teammate transcripts straight from AppState tasks. In-process teammates
 * hold their messages in task.messages, which beats disk here: each
 * teammate turn writes under a fresh random agentId, so the files don't
 * aggregate per teammate.
 */
export function extractTeammateTranscriptsFromTasks(tasks: {
  [taskId: string]: {
    type: string
    identity?: { agentId: string }
    messages?: Message[]
  }
}): { [agentId: string]: Message[] } {
  const transcripts: { [agentId: string]: Message[] } = {}

  for (const task of Object.values(tasks)) {
    if (
      task.type === 'in_process_teammate' &&
      task.identity?.agentId &&
      task.messages &&
      task.messages.length > 0
    ) {
      transcripts[task.identity.agentId] = task.messages
    }
  }

  return transcripts
}

/** Batch getAgentTranscript over agent IDs; failures and empties drop out. */
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

/** List the session's subagents directory on disk — survives task eviction,
 *  which AppState.tasks does not. */
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
  // Inverse of getAgentTranscriptPath's filename scheme — keep the two in
  // step when either changes.
  const agentIds = entries
    .filter(
      d =>
        d.isFile() && d.name.startsWith('agent-') && d.name.endsWith('.jsonl'),
    )
    .map(d => d.name.slice('agent-'.length, -'.jsonl'.length))
  return loadSubagentTranscripts(agentIds)
}

/** The Nth log of the sorted listing, or null past the end. */
export async function getLogByIndex(index: number): Promise<LogOption | null> {
  const logs = await loadMessageLogs()
  return logs[index] || null
}

/**
 * Find a tool_use still awaiting its tool_result. Returns the assistant
 * message holding the tool_use, or null when it doesn't exist OR a result
 * already landed — the whole map must be scanned before answering, since
 * the result may sit anywhere after the call.
 */
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
              // Resolved after all — nothing unresolved to report.
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

/**
 * Every session JSONL in a project dir with its stat facts, keyed by
 * sessionId. Filenames must be UUID.jsonl; stats run batched, and a file
 * that vanishes mid-stat is skipped with a debug note.
 */
export async function getSessionFilesWithMtime(
  projectDir: string,
): Promise<
  Map<string, { path: string; mtime: number; ctime: number; size: number }>
> {
  const sessionFilesMap = new Map<
    string,
    { path: string; mtime: number; ctime: number; size: number }
  >()

  let dirents: Dirent[]
  try {
    dirents = await readdir(projectDir, { withFileTypes: true })
  } catch {
    return sessionFilesMap
  }

  const candidates: Array<{ sessionId: string; filePath: string }> = []
  for (const dirent of dirents) {
    if (!dirent.isFile() || !dirent.name.endsWith('.jsonl')) continue
    const sessionId = validateUuid(basename(dirent.name, '.jsonl'))
    if (!sessionId) continue
    candidates.push({ sessionId, filePath: join(projectDir, dirent.name) })
  }

  // Bounded fan-out (libuv serves fs from a four-thread pool — a wall of
  // queued stat promises past it only burns memory on a huge history), and
  // the map now fills in candidates order: deterministic, order-preserving.
  const rows = await mapWithConcurrency(candidates, discoveryPoolWidth(), async ({ sessionId, filePath }) => {
    try {
      const st = await stat(filePath)
      return {
        sessionId,
        row: { path: filePath, mtime: st.mtime.getTime(), ctime: st.birthtime.getTime(), size: st.size },
      }
    } catch {
      logForDebugging(`Failed to stat session file: ${filePath}`)
      return null
    }
  })
  for (const entry of rows) {
    if (entry !== null) sessionFilesMap.set(entry.sessionId, entry.row)
  }

  return sessionFilesMap
}

/**
 * READ-ONLY machine-wide transcript census for /status — derived from
 * getSessionFilesWithMtime above (THE enumerator of session transcripts:
 * UUID .jsonl files with their stat facts), never from a second directory
 * matcher. Transcripts are kept for good — the retention sweep never ages
 * them — so this is the whole estate: every project directory's session
 * files. Counts files on disk (a session spanning two project dirs weighs
 * as its two files — disk truth); `oldestMtimeMs` is null on an empty
 * estate.
 */
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

/**
 * How many sessions the resume picker enriches up front. Each enrichment
 * reads ≤128 KB (head+tail), so 50 costs ~6.4 MB of I/O — cheap on any
 * modern disk, and a far better first paint than a screenful of blanks.
 */
const INITIAL_ENRICH_COUNT = 50

type LiteMetadata = {
  firstPrompt: string
  gitBranch?: string
  isSidechain: boolean
  projectPath?: string
  teamName?: string
  customTitle?: string
  summary?: string
  tag?: string
  agentSetting?: string
  prNumber?: number
  prUrl?: string
  prRepository?: string
  /** Mercury field: the prior run ended on an unrecovered error
   *  (undefined = unknowable). */
  endedOnError?: boolean
}

/** One LogOption per LEAF of one session file, messages included — the
 *  /insights shape, where every branch matters. */
export async function loadAllLogsFromSessionFile(
  sessionFile: string,
  projectPathOverride?: string,
): Promise<LogOption[]> {
  const {
    messages,
    summaries,
    customTitles,
    tags,
    agentNames,
    agentColors,
    agentSettings,
    prNumbers,
    prUrls,
    prRepositories,
    modes,
    fileHistorySnapshots,
    attributionSnapshots,
    contentReplacements,
    leafUuids,
  } = await loadTranscriptFile(sessionFile, { keepAllLeaves: true })

  if (messages.size === 0) return []

  const leafMessages: TranscriptMessage[] = []
  // parent → children, indexed once, so each leaf's trailing lookup is O(1).
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

    // Children hanging off the leaf (post-leaf system entries etc.) ride
    // along, in timestamp order — ISO-8601 UTC sorts lexically.
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
      customTitle: customTitles.get(sessionId),
      tag: tags.get(sessionId),
      agentName: agentNames.get(sessionId),
      agentColor: agentColors.get(sessionId),
      agentSetting: agentSettings.get(sessionId),
      mode: modes.get(sessionId) as LogOption['mode'],
      prNumber: prNumbers.get(sessionId),
      prUrl: prUrls.get(sessionId),
      prRepository: prRepositories.get(sessionId),
      gitBranch: leafMessage.gitBranch,
      projectPath: projectPathOverride ?? firstMessage.cwd,
      fileHistorySnapshots: buildFileHistorySnapshotChain(
        fileHistorySnapshots,
        chain,
      ),
      attributionSnapshots: buildAttributionSnapshotChain(
        attributionSnapshots,
        chain,
      ),
      contentReplacements: contentReplacements.get(sessionId) ?? [],
    })
  }

  return logs
}

/** Full per-leaf loads for a project dir, newest files first under a limit;
 *  unreadable files are skipped with a note. */
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

// Read a session-stamp field (isSidechain, cwd) from the FIRST line that
// carries it as a PARSED top-level key. This walks past
// the non-message preamble (queue-operation / snapshot / mode lines carry
// no stamp) and refuses later lines — a sidechain SUB-message's own
// isSidechain:true, or a prompt merely quoting the text, cannot spoof it.
// Field-boundary-correct by construction: it reads the parsed object's own
// key, where a substring scan false-positives and a first-physical-line
// scan false-negatives (the stamp usually sits around line 3).
function firstMessageField(head: string, field: string): unknown {
  const needle = `"${field}"`
  let start = 0
  for (let scanned = 0; scanned < 80 && start <= head.length; scanned++) {
    const nl = head.indexOf('\n', start)
    const line = nl === -1 ? head.slice(start) : head.slice(start, nl)
    if (line.includes(needle)) {
      try {
        const o = JSON.parse(line) as Record<string, unknown>
        if (o && typeof o === 'object' && field in o) return o[field]
      } catch {
        // not a complete JSON object on this physical line — keep walking
      }
    }
    if (nl === -1) break
    start = nl + 1
  }
  return undefined
}

/**
 * Lite enrichment: bounded head+tail reads (LITE_READ_BUF_SIZE each, via a
 * caller-shared buffer) decode a session's label facts without parsing the
 * file. Head: the session stamps and first prompt. Tail: last-wins
 * metadata — title, tag, PR link, latest branch, error end-state.
 */
async function readLiteMetadata(
  filePath: string,
  fileSize: number,
  buf: Buffer,
): Promise<LiteMetadata> {
  const { head, tail } = await readHeadAndTail(filePath, fileSize, buf)
  if (!head) return { firstPrompt: '', isSidechain: false }

  // Session stamps come from the first message's own parsed fields
  // cwd keeps the whole-head substring scan as a
  // fallback for files whose stamped line didn't parse.
  const isSidechain = firstMessageField(head, 'isSidechain') === true
  const cwdField = firstMessageField(head, 'cwd')
  const projectPath =
    typeof cwdField === 'string' && cwdField
      ? cwdField
      : extractJsonStringField(head, 'cwd')
  const teamName = extractJsonStringField(head, 'teamName')
  const agentSetting = extractJsonStringField(head, 'agentSetting')

  // Label preference: the tail's last-prompt entry (write-time filtered,
  // shows the operator's most recent intent) → the head walk → raw string
  // scrapes, which still catch array-format content such as IDE-metadata
  // first messages.
  const firstPrompt =
    extractLastJsonStringField(tail, 'lastPrompt') ||
    extractFirstPromptFromChunk(head) ||
    extractJsonStringFieldPrefix(head, 'content', 200) ||
    extractJsonStringFieldPrefix(head, 'text', 200) ||
    ''

  // Titles: operator custom-title entries outrank AI ai-title entries; the
  // distinct field names make the last-wins scans disambiguate naturally.
  const customTitle =
    extractLastJsonStringField(tail, 'customTitle') ??
    extractLastJsonStringField(head, 'customTitle') ??
    extractLastJsonStringField(tail, 'aiTitle') ??
    extractLastJsonStringField(head, 'aiTitle')
  const summary = extractLastJsonStringField(tail, 'summary')
  const tag = extractLastJsonStringField(tail, 'tag')
  const gitBranch =
    extractLastJsonStringField(tail, 'gitBranch') ??
    extractJsonStringField(head, 'gitBranch')

  // prNumber serializes as a number, so the string scan needs a numeric
  // fallback over the raw tail bytes.
  const prUrl = extractLastJsonStringField(tail, 'prUrl')
  const prRepository = extractLastJsonStringField(tail, 'prRepository')
  let prNumber: number | undefined
  const prNumStr = extractLastJsonStringField(tail, 'prNumber')
  if (prNumStr) {
    prNumber = parseInt(prNumStr, 10) || undefined
  }
  if (!prNumber) {
    const prNumMatch = tail.lastIndexOf('"prNumber":')
    if (prNumMatch >= 0) {
      const afterColon = tail.slice(prNumMatch + 11, prNumMatch + 25)
      const num = parseInt(afterColon.trim(), 10)
      if (num > 0) prNumber = num
    }
  }

  // Mercury resume-picker end-state: did the prior run end on an
  // unrecovered error? Parse-based reverse scan of the already-read tail —
  // spoof-safe like the stamp reads, zero extra I/O; undefined keeps
  // non-Mercury files byte-identical downstream.
  const endedOnError = scanTailForEndedOnError(tail)

  return {
    firstPrompt,
    gitBranch,
    isSidechain,
    projectPath,
    teamName,
    customTitle,
    summary,
    tag,
    agentSetting,
    prNumber,
    prUrl,
    prRepository,
    endedOnError,
  }
}

/** Exported for prove-first-prompt-extractor (behavioral, both formats). */
export function extractFirstPromptFromChunk(chunk: string): string {
  let start = 0
  let firstCommandFallback = ''
  while (start < chunk.length) {
    const newlineIdx = chunk.indexOf('\n', start)
    const line =
      newlineIdx >= 0 ? chunk.slice(start, newlineIdx) : chunk.slice(start)
    start = newlineIdx >= 0 ? newlineIdx + 1 : chunk.length

    // An operator turn is an input record: payload "kind":"input".
    if (!(line.includes('"kind":"input"') || line.includes('"kind": "input"'))) {
      continue
    }
    if (line.includes('"tool_result"')) continue
    if (line.includes('"isMeta":true') || line.includes('"isMeta": true'))
      continue

    try {
      const entry = jsonParse(line) as Record<string, unknown>

      // The record's meta flags are the hide equivalents, and a
      // meta-carried tool result never titles a session.
      const payload = entry.payload as Record<string, unknown> | undefined
      if (!payload || payload.kind !== 'input') continue
      const meta = (payload.meta ?? {}) as Record<string, unknown>
      if (
        meta.hiddenFromTranscript === true ||
        meta.isVirtual === true ||
        meta.isCompactSummary === true ||
        meta.toolUseResult !== undefined
      ) {
        continue
      }
      const content: unknown = payload.content
      // Collect every text block (fabric blocks spell the discriminator
      // `kind`) — IDE-integrated sessions bury the real prompt behind
      // <ide_selection>-style metadata blocks.
      const texts: string[] = []
      // BOARD CONTROLS item 6: a dispatched session's first message OPENS
      // with the ground note — framing, never the operator's words; the
      // picker row derives from the words alone.
      if (typeof content === 'string') {
        texts.push(stripGroundNote(content))
      } else if (Array.isArray(content)) {
        for (const block of content) {
          const b = block as Record<string, unknown>
          if (b.kind === 'text' && typeof b.text === 'string' && !(b.text as string).startsWith(GROUND_NOTE_MARK)) {
            texts.push(b.text as string)
          }
        }
      }

      for (const text of texts) {
        if (!text) continue

        let result = text.replace(/\n/g, ' ').trim()

        // Slash commands: skip, but remember the first as a fallback so a
        // command-only session still lists cleanly (e.g. "/clear") instead
        // of vanishing from the picker. The fallback records BEFORE the
        // registry consult on purpose: a command line must yield its clean
        // name even when the command registry cannot build in the calling
        // context (the per-line catch would otherwise eat the throw AND
        // the label).
        const commandNameTag = extractTag(result, COMMAND_NAME_TAG)
        if (commandNameTag) {
          if (!firstCommandFallback) {
            firstCommandFallback = commandNameTag
          }
          const name = commandNameTag.replace(/^\//, '')
          const commandArgs = extractTag(result, 'command-args')?.trim() || ''
          if (builtInCommandNames().has(name) || !commandArgs) {
            continue
          }
          // Custom command with real arguments — label with clean text.
          return commandArgs
            ? `${commandNameTag} ${commandArgs}`
            : commandNameTag
        }

        // Bash-mode input, before the generic tag skip eats it.
        const bashInput = extractTag(result, 'bash-input')
        if (bashInput) return `! ${bashInput}`

        if (SKIP_FIRST_PROMPT_PATTERN.test(result)) {
          continue
        }
        if (result.length > 200) {
          result = result.slice(0, 200).trim() + '…'
        }
        return result
      }
    } catch {
      continue
    }
  }
  // Command-only session: the remembered command is the best label there is.
  if (firstCommandFallback) return firstCommandFallback
  return ''
}

/**
 * extractJsonStringField's truncation-tolerant sibling: yields up to
 * maxLen decoded characters even when the closing quote never arrives
 * (the value ran past the read buffer). JSON escapes decode; anything
 * below 0x20 flattens to a space for the one-line label — via a codepoint
 * filter, so no raw control byte appears in this source.
 */
function extractJsonStringFieldPrefix(
  text: string,
  key: string,
  maxLen: number,
): string {
  const patterns = [`"${key}":"`, `"${key}": "`]
  for (const pattern of patterns) {
    const idx = text.indexOf(pattern)
    if (idx < 0) continue

    const valueStart = idx + pattern.length
    let i = valueStart
    let collected = 0
    while (i < text.length && collected < maxLen) {
      if (text[i] === '\\') {
        i += 2 // escape plus escaped char
        collected++
        continue
      }
      if (text[i] === '"') break
      i++
      collected++
    }
    const raw = text.slice(valueStart, i)
    // unescapeJsonString hands back the raw string if the slice ends
    // mid-escape, so a truncated buffer still yields a usable label.
    const decoded = unescapeJsonString(raw)
    return Array.from(decoded, ch => (ch.charCodeAt(0) < 0x20 ? ' ' : ch))
      .join('')
      .trim()
  }
  return ''
}

/** Dedup by sessionId (newest modified wins), sort, renumber. */
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

/**
 * The instant tier of the listing ladder: LogOptions from stat alone —
 * zero file reads. enrichLogs upgrades visible rows with labels on demand.
 */
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

/**
 * Enrich one lite log from its file. null = the session should not list
 * (sidechain or teammate session); everything else lists, with a
 * placeholder label when no prompt survived extraction — a crashed or
 * huge-first-message session must stay reachable from /resume.
 */
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
    teamName: meta.teamName,
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
  if (enriched.teamName) {
    logForDebugging(
      `Session ${log.sessionId} filtered from /resume: teamName=${enriched.teamName}`,
    )
    return null
  }

  return enriched
}

/**
 * Enrich until `count` rows are VALID (filtered rows don't count against
 * the quota), starting at startIndex; returns the rows plus the index the
 * next progressive call should continue from.
 */
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
