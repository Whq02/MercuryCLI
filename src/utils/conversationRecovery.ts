import type { UUID } from 'crypto'
import { basename, relative } from 'node:path'

import { addInvokedSkill } from '../bootstrap/state.js'
import type { AttachmentMessage, Message, NormalizedUserMessage, UserMessage } from '../types/message.js'
import type { LogOption, SerializedMessage, TranscriptMessage } from '../types/logs.js'
import { PERMISSION_MODES, decodePermissionModeSpelling } from '../types/permissions.js'
import { suppressNextSkillListing } from './attachments/skillListing.js'
import { getCwd } from './cwd.js'
import { copyFileHistoryForResume } from './fileHistory.js'
import { logError } from './log.js'
import { mintImmediateReceipt } from './model/seatReceipts.js'
import {
  createAssistantMessage,
  createUserMessage,
  filterOrphanedThinkingOnlyMessages,
  filterUnresolvedToolUses,
  filterWhitespaceOnlyAssistantMessages,
  isToolUseResultMessage,
  NO_RESPONSE_REQUESTED,
  normalizeMessages,
} from './messages.js'
import { copyPlanForResume } from './plans.js'
import { processSessionStartHooks } from './sessionStart.js'
import {
  buildConversationChain,
  checkResumeConsistency,
  getLastSessionLog,
  getSessionIdFromLog,
  isLiteLog,
  loadFullLog,
  loadMessageLogs,
  loadTranscriptFile,
  removeExtraFields,
} from './sessionStorage.js'
import { PERSISTED_OUTPUT_TAG } from './toolResultStorage.js'
import { asSessionId, type SessionId } from '../types/ids.js'

/**
 * Loading and normalising a persisted conversation for resume, mid-turn
 * interruption detection, and the read-only live-follow view.
 */

export type TurnInterruptionState =
  | { kind: 'none' }
  | { kind: 'interrupted_prompt'; message: NormalizedUserMessage }

type InternalInterruptionState = TurnInterruptionState | { kind: 'interrupted_turn' }

export type DeserializeResult = {
  messages: Message[]
  turnInterruptionState: TurnInterruptionState
}

/**
 * The continuation instruction appended when a turn was interrupted (no
 * env override exists). The default sentence is asserted ABSENT from followed
 * transcripts by a live-follow prover, so a re-wording must be carried
 * there.
 */
export function getResumePrompt(): string {
  return 'Continue from where you left off.'
}

// ---------------------------------------------------------------------------
// Legacy attachment migration and permission-mode scrubbing
// ---------------------------------------------------------------------------

type LegacyAttachmentRecord = {
  type?: string
  filename?: string
  path?: string
  skillDir?: string
  displayPath?: string
  [key: string]: unknown
}

function migrateLegacyAttachment(message: Message): Message {
  if (message.type !== 'attachment') return message
  const attachment = message.attachment as unknown as LegacyAttachmentRecord
  let migrated: LegacyAttachmentRecord | null = null
  if (attachment.type === 'new_file' && typeof attachment.filename === 'string') {
    migrated = { ...attachment, type: 'file', displayPath: relative(getCwd(), attachment.filename) }
  } else if (attachment.type === 'new_directory' && typeof attachment.path === 'string') {
    migrated = { ...attachment, type: 'directory', displayPath: relative(getCwd(), attachment.path) }
  } else if (attachment.displayPath === undefined) {
    const source = attachment.filename ?? attachment.path ?? attachment.skillDir
    if (typeof source === 'string') {
      migrated = { ...attachment, displayPath: relative(getCwd(), source) }
    }
  }
  if (!migrated) return message
  return { ...message, attachment: migrated as unknown as AttachmentMessage['attachment'] }
}

/**
 * A persisted permission mode arrives from disk unvalidated and could have
 * been written by a build with a different vocabulary. A RETIRED spelling
 * (a session recorded before the mode-identity migration) decodes through
 * the bounded alias and is ADOPTED as its new id — zero-loss resume;
 * anything else outside this build's set (a mode this build no longer has)
 * is cleared — the session resumes in its default mode — and the operator
 * hears it ONCE per spelling as one screen-receipt row, never a crash.
 */
const noticedPermissionModes = new Set<string>()
function scrubPermissionMode(message: Message): Message {
  if (message.type !== 'user') return message
  const mode = (message as UserMessage).permissionMode
  if (mode === undefined) return message
  if ((PERMISSION_MODES as readonly string[]).includes(mode)) return message
  const decoded = decodePermissionModeSpelling(mode)
  if (decoded !== mode && (PERMISSION_MODES as readonly string[]).includes(decoded)) {
    return { ...message, permissionMode: decoded } as Message
  }
  if (!noticedPermissionModes.has(mode)) {
    noticedPermissionModes.add(mode)
    mintImmediateReceipt(
      `▲ the saved permission mode '${mode}' is not one this build knows — resuming in the default mode`,
      'warning',
    )
  }
  return { ...message, permissionMode: undefined } as Message
}

// ---------------------------------------------------------------------------
// Interruption detection
// ---------------------------------------------------------------------------

/**
 * Dead arm reproduced as built: the turn-terminating tool exemption. All
 * three tool names resolve to null in this build (first-party-only names
 * deliberately not imported so their strings never enter external
 * builds), so this always answers false and every transcript ending on a
 * tool result classifies as an interrupted turn. Kept as the extension
 * seam; no names are invented.
 */
const TURN_TERMINATING_TOOL_NAMES: ReadonlyArray<string | null> = [null, null, null]

function isTurnTerminatingToolResult(messages: Message[], index: number): boolean {
  const message = messages[index] as Message
  if (message.type !== 'user') return false
  const content = message.message.content
  if (!Array.isArray(content)) return false
  const first = content[0] as { type?: string; tool_use_id?: string } | undefined
  if (!first || first.type !== 'tool_result' || !first.tool_use_id) return false
  for (let i = index - 1; i >= 0; i--) {
    const candidate = messages[i] as Message
    if (candidate.type !== 'assistant') continue
    const blocks = candidate.message.content
    if (!Array.isArray(blocks)) continue
    for (const block of blocks) {
      const use = block as { type?: string; id?: string; name?: string }
      if (use.type === 'tool_use' && use.id === first.tool_use_id) {
        // Only a PRESENT string name is compared: a block with a missing
        // name must never match the (all-null) terminating-tool list.
        return typeof use.name === 'string' && TURN_TERMINATING_TOOL_NAMES.includes(use.name)
      }
    }
  }
  return false
}

function isSyntheticApiErrorAssistant(message: Message): boolean {
  return message.type === 'assistant' && Boolean((message as { isApiErrorMessage?: boolean }).isApiErrorMessage)
}

function detectInterruption(messages: Message[]): InternalInterruptionState {
  if (messages.length === 0) return { kind: 'none' }
  // Skip synthetic API-error assistants: they are stripped before any
  // request anyway, and stopping on one would hide the interruption of a
  // session that died after its retries were exhausted.
  let index = messages.length - 1
  while (index >= 0) {
    const candidate = messages[index] as Message
    if (candidate.type !== 'system' && candidate.type !== 'progress' && !isSyntheticApiErrorAssistant(candidate)) {
      break
    }
    index--
  }
  if (index < 0) return { kind: 'none' }
  const last = messages[index] as Message
  if (last.type === 'assistant') {
    // In the streaming path persisted messages carry no stop reason and
    // unresolved tool uses have been filtered, so an assistant at the end
    // means the turn most likely completed.
    return { kind: 'none' }
  }
  if (last.type === 'user') {
    if (last.isMeta || last.isCompactSummary) return { kind: 'none' }
    // The shared classifier: first content block is a tool result OR the
    // message carries the structured tool-use-result field. A message that
    // is one is never classified as an interrupted prompt.
    if (isToolUseResultMessage(last)) {
      return isTurnTerminatingToolResult(messages, index) ? { kind: 'none' } : { kind: 'interrupted_turn' }
    }
    // A plain prompt: the model had not started responding.
    return { kind: 'interrupted_prompt', message: last as NormalizedUserMessage }
  }
  if (last.type === 'attachment') {
    return { kind: 'interrupted_turn' }
  }
  return { kind: 'none' }
}

// ---------------------------------------------------------------------------
// Deserialisation
// ---------------------------------------------------------------------------

/**
 * The full resume pipeline: legacy migration, permission scrub, unresolved
 * tool-use / orphaned-thinking / whitespace-only filtering, interruption
 * detection, the synthetic continuation prompt for an interrupted turn, and
 * the synthetic assistant sentinel spliced immediately after the last user
 * message (so the removal helper's two-element splice removes the right
 * pair). Errors are logged and re-thrown.
 */
export function deserializeMessagesWithInterruptDetection(serialized: Message[]): DeserializeResult {
  try {
    let messages = serialized.map(migrateLegacyAttachment).map(scrubPermissionMode)
    messages = filterUnresolvedToolUses(messages)
    messages = filterOrphanedThinkingOnlyMessages(messages)
    messages = filterWhitespaceOnlyAssistantMessages(messages)

    let interruption: TurnInterruptionState = { kind: 'none' }
    const detected = detectInterruption(messages)
    if (detected.kind === 'interrupted_turn') {
      // The continuation goes through the message normalizer before it is
      // appended and reported.
      const continuation = normalizeMessages([
        createUserMessage({ content: getResumePrompt(), isMeta: true }),
      ])[0] as NormalizedUserMessage
      messages = [...messages, continuation]
      interruption = { kind: 'interrupted_prompt', message: continuation }
    } else if (detected.kind === 'interrupted_prompt') {
      interruption = detected
    }

    // The synthetic assistant sentinel leaves the conversation API-valid
    // when no resume action is taken.
    let lastRealIndex = -1
    for (let i = messages.length - 1; i >= 0; i--) {
      const candidate = messages[i] as Message
      if (candidate.type !== 'system' && candidate.type !== 'progress') {
        lastRealIndex = i
        break
      }
    }
    if (lastRealIndex !== -1 && (messages[lastRealIndex] as Message).type === 'user') {
      const sentinel = createAssistantMessage({ content: NO_RESPONSE_REQUESTED })
      messages = [...messages.slice(0, lastRealIndex + 1), sentinel, ...messages.slice(lastRealIndex + 1)]
    }
    return { messages, turnInterruptionState: interruption }
  } catch (err) {
    logError(err)
    throw err
  }
}

/** Messages only, for callers that do not need the interruption state. */
export function deserializeMessages(serialized: Message[]): Message[] {
  return deserializeMessagesWithInterruptDetection(serialized).messages
}

/**
 * The read-only "watch another session" view: ONLY the legacy migration
 * and the permission scrub, and no recovery synthesis at all. Routing a
 * live view through the resume normaliser wrote its additions back into
 * whatever session the terminal identified as, and destroyed the view's
 * purpose — the unresolved tool use and trailing thinking block are exactly
 * what an operator is watching for.
 */
export function deserializeLiveMessages(serialized: Message[]): Message[] {
  return serialized.map(migrateLegacyAttachment).map(scrubPermissionMode)
}

export type LiveTurnState = {
  inFlight: boolean
  phase: 'thinking' | 'tool' | 'responding' | 'idle'
  /** The records carry no agent wait — the runner's own state word does
   *  (the connector lifts it over this fold); always 0 here. */
  agentsWaiting: 0
  inProgressToolUseIDs: Set<string>
  turnStartedAtMs: number | null
}

/** The running facts of the live-turn fold — everything the settle needs,
 *  accumulated one message at a time so a prefix can settle once and the
 *  churning tail (the rows a stream keeps revising) refolds over a copy. */
type TurnAccumulator = {
  pending: Set<string>
  resolved: Set<string>
  lastPromptMs: number | null
  lastAssistantMs: number | null
  hasAssistant: boolean
  lastAssistantKind: 'thinking' | 'tool' | 'responding' | null
}

const freshTurnAccumulator = (): TurnAccumulator => ({
  pending: new Set(),
  resolved: new Set(),
  lastPromptMs: null,
  lastAssistantMs: null,
  hasAssistant: false,
  lastAssistantKind: null,
})

const cloneTurnAccumulator = (acc: TurnAccumulator): TurnAccumulator => ({
  pending: new Set(acc.pending),
  resolved: new Set(acc.resolved),
  lastPromptMs: acc.lastPromptMs,
  lastAssistantMs: acc.lastAssistantMs,
  hasAssistant: acc.hasAssistant,
  lastAssistantKind: acc.lastAssistantKind,
})

const parseTurnTime = (timestamp: string): number | null => {
  const parsed = Date.parse(timestamp)
  return Number.isNaN(parsed) ? null : parsed
}

function accumulateTurn(acc: TurnAccumulator, message: Message): void {
  if (message.type === 'user') {
    const content = message.message.content
    if (Array.isArray(content)) {
      let carriedToolResult = false
      for (const block of content) {
        const record = block as { type?: string; tool_use_id?: string }
        if (record.type === 'tool_result' && record.tool_use_id) {
          acc.resolved.add(record.tool_use_id)
          carriedToolResult = true
        }
      }
      if (!carriedToolResult && !message.isMeta) {
        acc.lastPromptMs = parseTurnTime(message.timestamp) ?? acc.lastPromptMs
      }
    } else if (!message.isMeta) {
      acc.lastPromptMs = parseTurnTime(message.timestamp) ?? acc.lastPromptMs
    }
  } else if (message.type === 'assistant') {
    acc.hasAssistant = true
    acc.lastAssistantMs = parseTurnTime(message.timestamp) ?? acc.lastAssistantMs
    const content = message.message.content
    if (Array.isArray(content)) {
      for (const block of content) {
        const record = block as { type?: string; id?: string }
        if (record.type === 'tool_use' && record.id) acc.pending.add(record.id)
      }
      const last = content[content.length - 1] as { type?: string } | undefined
      if (last?.type === 'thinking' || last?.type === 'redacted_thinking') acc.lastAssistantKind = 'thinking'
      else if (last?.type === 'tool_use') acc.lastAssistantKind = 'tool'
      else acc.lastAssistantKind = 'responding'
    }
  }
}

function settleTurn(acc: TurnAccumulator): LiveTurnState {
  const unresolved = new Set<string>()
  for (const id of acc.pending) {
    if (!acc.resolved.has(id)) unresolved.add(id)
  }
  const promptOpen =
    acc.lastPromptMs !== null &&
    (acc.lastAssistantMs === null || acc.lastAssistantMs >= acc.lastPromptMs - 1)
  const inFlight =
    unresolved.size > 0 ||
    acc.lastAssistantKind === 'thinking' ||
    (promptOpen && !acc.hasAssistant)
  let phase: 'thinking' | 'tool' | 'responding' | 'idle' = 'idle'
  if (inFlight) {
    if (unresolved.size > 0) phase = 'tool'
    else if (acc.lastAssistantKind === 'thinking') phase = 'thinking'
    // The only remaining in-flight shape is the pre-first-token window
    // (prompt open, no assistant content at all): nothing has streamed, so
    // the honest phase is 'thinking' — claiming 'responding' painted a
    // writing indicator while the request was still in flight.
    else phase = 'thinking'
  }
  return { inFlight, phase, agentsWaiting: 0, inProgressToolUseIDs: unresolved, turnStartedAtMs: acc.lastPromptMs }
}

/**
 * The live-turn fold kept across reads: the rows before `settledPrefix`
 * are the same rows the previous call folded (the caller's cursor says
 * so), so they settle once and only the rows past the prefix — the tail a
 * stream keeps revising, the rows an append landed — fold on each call. A
 * shorter prefix than the settled one rewinds the settled part.
 */
export interface LiveTurnFold {
  fold(rows: readonly Message[], settledPrefix: number): LiveTurnState
}

export function createLiveTurnFold(): LiveTurnFold {
  let settled = freshTurnAccumulator()
  let settledCount = 0
  return {
    fold(rows, settledPrefix) {
      const k = Math.max(0, Math.min(settledPrefix, rows.length))
      if (k < settledCount) {
        settled = freshTurnAccumulator()
        settledCount = 0
      }
      for (; settledCount < k; settledCount++) accumulateTurn(settled, rows[settledCount]!)
      if (k === rows.length) return settleTurn(settled)
      const live = cloneTurnAccumulator(settled)
      for (let i = k; i < rows.length; i++) accumulateTurn(live, rows[i]!)
      return settleTurn(live)
    },
  }
}

/**
 * A pure fold answering whether a turn is underway, its phase, when it
 * began, and which tool uses still await results — the same inputs the
 * interactive turn indicator consumes. The one-shot form of the fold.
 */
export function liveTurnStateOf(messages: Message[]): LiveTurnState {
  return createLiveTurnFold().fold(messages, 0)
}

// ---------------------------------------------------------------------------
// Skill-state restoration
// ---------------------------------------------------------------------------

/**
 * Re-register invoked skills recorded in the transcript, and latch the
 * skill-listing suppression when the transcript already carries a listing
 * (the bookkeeping that remembers having sent it does not survive the
 * process boundary, so every resume would otherwise inject a second copy).
 */
export function restoreSkillStateFromMessages(messages: Message[]): void {
  let sawListing = false
  for (const message of messages) {
    if (message.type !== 'attachment') continue
    const attachment = message.attachment as {
      type?: string
      skills?: Array<{ name?: string; path?: string; content?: string }>
    }
    if (attachment.type === 'invoked_skills' && Array.isArray(attachment.skills)) {
      for (const skill of attachment.skills) {
        if (skill.name && skill.path && skill.content) {
          addInvokedSkill(skill.name, skill.path, skill.content)
        }
      }
    }
    if (attachment.type === 'skill_listing') sawListing = true
  }
  if (sawListing) suppressNextSkillListing()
}

// ---------------------------------------------------------------------------
// Session-start hook de-duplication
// ---------------------------------------------------------------------------

// The fixed phrase the tool-result storage module emits before a per-run
// file path; the rest of that line is replaced with a stable placeholder.
const PERSISTED_PATH_PHRASE = 'Full output saved to: '

function dedupKeyFor(content: string): string {
  if (content.startsWith(PERSISTED_OUTPUT_TAG)) {
    return content.replace(
      new RegExp(`^(${PERSISTED_PATH_PHRASE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}).*$`, 'm'),
      '$1<path>',
    )
  }
  return content
}

function hookKeysOf(message: Message): string[] {
  if (message.type !== 'attachment') return []
  const attachment = message.attachment as {
    type?: string
    hookEvent?: string
    content?: unknown
  }
  if (attachment.hookEvent !== 'SessionStart') return []
  if (attachment.type === 'hook_additional_context' && Array.isArray(attachment.content)) {
    return (attachment.content as string[]).map(dedupKeyFor)
  }
  if (attachment.type === 'hook_success' && typeof attachment.content === 'string' && attachment.content !== '') {
    return [dedupKeyFor(attachment.content)]
  }
  return []
}

/**
 * Drop hook context the transcript already carries. The "changed" flag is
 * set by every keyed message the loop touches — kept or dropped alike — and
 * never by an unkeyed one; when it stays clear the result is EMPTY even
 * though unkeyed messages were pushed to the working list. Reproduced as
 * built (recorded as a probable defect).
 */
function filterDuplicateSessionStartHooks(incoming: Message[], transcript: Message[]): Message[] {
  if (incoming.length === 0) return []
  const existing = new Set<string>()
  for (const message of transcript) {
    for (const key of hookKeysOf(message)) existing.add(key)
  }
  if (existing.size === 0) return [...incoming]
  const survivors: Message[] = []
  let changed = false
  for (const message of incoming) {
    const keys = hookKeysOf(message)
    if (keys.length === 0) {
      survivors.push(message)
      continue
    }
    changed = true
    const attachment = (message as AttachmentMessage).attachment as { type?: string; content?: unknown }
    if (attachment.type === 'hook_additional_context' && Array.isArray(attachment.content) && attachment.content.length > 1) {
      const kept = (attachment.content as string[]).filter(entry => !existing.has(dedupKeyFor(entry)))
      if (kept.length === 0) continue
      if (kept.length === attachment.content.length) {
        survivors.push(message)
      } else {
        survivors.push({
          ...message,
          attachment: { ...attachment, content: kept },
        } as Message)
      }
      continue
    }
    if (!existing.has(keys[0] as string)) survivors.push(message)
  }
  return changed ? survivors : []
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Walk a transcript file directly: choose the newest non-side-chain leaf by
 * timestamp (a strict "later than the best so far" from zero, so an
 * unparseable or epoch timestamp can never be chosen), build the chain, and
 * return the messages plus the TIP's session id — a forked session begins
 * by copying the head of the chain out of its source transcript, so the
 * first message still names the original session.
 */
async function walkTranscriptFile(
  path: string,
): Promise<{ messages: SerializedMessage[]; sessionId: UUID | undefined }> {
  const loaded = await loadTranscriptFile(path)
  const messages = loaded.messages
  const referencedParents = new Set<string>()
  for (const message of messages.values()) {
    if (message.parentUuid) referencedParents.add(message.parentUuid)
  }
  let best: TranscriptMessage | null = null
  let bestTime = 0
  for (const message of messages.values()) {
    if (referencedParents.has(message.uuid)) continue
    if (message.isSidechain) continue
    const time = Date.parse(message.timestamp)
    if (Number.isNaN(time)) continue
    if (time > bestTime) {
      bestTime = time
      best = message
    }
  }
  if (!best) return { messages: [], sessionId: undefined }
  const chain = buildConversationChain(messages, best)
  return { messages: removeExtraFields(chain), sessionId: best.sessionId as UUID }
}

export async function loadMessagesFromJsonlPath(
  path: string,
): Promise<{ messages: SerializedMessage[]; sessionId: UUID | undefined }> {
  return walkTranscriptFile(path)
}

type ResumeResult = {
  messages: Message[]
  turnInterruptionState: TurnInterruptionState
  // Typed to the consumer's contract (a UUID); on the transcript-walk path
  // with no usable tip this is undefined at runtime (the spec's shape).
  sessionId: UUID
  fileHistorySnapshots?: LogOption['fileHistorySnapshots']
  attributionSnapshots?: LogOption['attributionSnapshots']
  contentReplacements?: LogOption['contentReplacements']
  contextCollapseCommits?: LogOption['contextCollapseCommits']
  contextCollapseSnapshot?: LogOption['contextCollapseSnapshot']
  agentName?: LogOption['agentName']
  agentColor?: LogOption['agentColor']
  agentSetting?: LogOption['agentSetting']
  customTitle?: LogOption['customTitle']
  tag?: LogOption['tag']
  mode?: LogOption['mode']
  worktreeSession?: LogOption['worktreeSession']
  prNumber?: LogOption['prNumber']
  prUrl?: LogOption['prUrl']
  prRepository?: LogOption['prRepository']
  fullPath?: string
}

/**
 * Load a conversation for resume. Source resolution is one ordered chain:
 * undefined (continue-most-recent) FIRST — a supplied transcript path is
 * ignored with no source; then an explicit transcript path; then a session
 * id; then an already-loaded log. Any thrown error is logged and
 * re-thrown.
 */
/**
 * A loaded transcript is a CONVERSATION to continue only when it carries a
 * turn — a user or an assistant message. The chain admits attachment and
 * system rows too (the request renders them, so they persist and replay),
 * but a file holding only those is the metadata-only shape a kill inside an
 * unflushed window leaves: context rows bound to a prompt that never
 * landed. Continuing it answered the next prompt as if a conversation
 * stood; the honest floor refuses it, on every door.
 */
export function hasConversationTurn(messages: readonly { type: string }[]): boolean {
  return messages.some(m => m.type === 'user' || m.type === 'assistant')
}

export async function loadConversationForResume(
  source: string | LogOption | undefined,
  sourceJsonlFile: string | undefined,
): Promise<ResumeResult | null> {
  try {
    let log: LogOption | null | undefined
    let messages: SerializedMessage[] | undefined
    let sessionId: SessionId | undefined
    let fullPath: string | undefined

    if (source === undefined) {
      // The live-session skip set is always empty in this build, so the
      // first log wins unconditionally.
      const logs = await loadMessageLogs()
      log = logs[0]
    } else if (sourceJsonlFile !== undefined) {
      const walked = await walkTranscriptFile(sourceJsonlFile)
      messages = walked.messages
      sessionId = walked.sessionId as SessionId | undefined
      // fullPath is carried only from a loaded log record — the explicit
      // transcript path does not populate it.
    } else if (typeof source === 'string') {
      // The transcript is the one store: the -p pump flushes it before a
      // completion reaches the wire, so a session killed at first sight of
      // its reply still resumes from it (§TRANSCRIPT-DEBOUNCE-SIGKILL).
      log = await getLastSessionLog(source as UUID)
      sessionId = asSessionId(source)
    } else {
      log = source
    }

    if (!log && messages === undefined) return null

    if (log) {
      if (isLiteLog(log)) log = await loadFullLog(log)
      if (sessionId === undefined) sessionId = getSessionIdFromLog(log) as SessionId
      // Keyed by the ORIGINAL session id so the plan associates with the
      // session being resumed, not the temporary pre-resume id. Guarded on
      // a DEFINED session id.
      if (sessionId !== undefined) {
        await copyPlanForResume(log, sessionId)
      }
      void copyFileHistoryForResume(log)
      messages = log.messages as SerializedMessage[]
      checkResumeConsistency(messages as unknown as Message[])
      fullPath = log.fullPath
    }

    const asMessages = (messages ?? []) as unknown as Message[]
    // Judged BEFORE the interruption heal: a transcript that ends without a
    // completed turn is healed with an interruption pair (a user row and an
    // assistant row), which is right for a prompt whose reply never landed
    // and invents a conversation for a file that never held one. A turnless
    // transcript is nothing to continue — the doors refuse it as absent.
    if (!hasConversationTurn(asMessages)) return null
    // Before deserialisation, so skills survive repeated compaction cycles.
    restoreSkillStateFromMessages(asMessages)
    const { messages: deserialized, turnInterruptionState } = deserializeMessagesWithInterruptDetection(asMessages)
    const hookMessages = await processSessionStartHooks('resume', { sessionId })
    const dedupedHooks = filterDuplicateSessionStartHooks(hookMessages as Message[], deserialized)

    return {
      messages: [...deserialized, ...dedupedHooks],
      turnInterruptionState,
      sessionId: sessionId as unknown as UUID,
      ...(log
        ? {
            fileHistorySnapshots: log.fileHistorySnapshots,
            attributionSnapshots: log.attributionSnapshots,
            contentReplacements: log.contentReplacements,
            contextCollapseCommits: log.contextCollapseCommits,
            contextCollapseSnapshot: log.contextCollapseSnapshot,
            agentName: log.agentName,
            agentColor: log.agentColor,
            agentSetting: log.agentSetting,
            customTitle: log.customTitle,
            tag: log.tag,
            mode: log.mode,
            worktreeSession: log.worktreeSession,
            prNumber: log.prNumber,
            prUrl: log.prUrl,
            prRepository: log.prRepository,
          }
        : {}),
      fullPath,
    }
  } catch (err) {
    logError(err)
    throw err
  }
}
