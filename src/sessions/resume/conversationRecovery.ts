import { rebuildSeenLinesFromTranscript } from '../../tools/engines/change-transaction/seenLines.js'
import { logForDebugging } from '../../platform/logs/debugLog.js'
import { mainOwnerOfSession, processMainOwner } from '../../engine/run-owner/resolveOwner.js'
import type { UUID } from 'crypto'
import { relative } from 'node:path'

import { addInvokedSkill, getEngineModelOverride } from '../../boot/process-state/processState.js'
import { rehydrateScreenshots } from '../../integrations/desktop/screenshotRetention.js'
import { withoutRetractedReplies } from '../../engine/connector/midTurnText.js'
import { restoreBoundPrefixFromMessages } from '../../models/roads/anthropic/boundPrefixRecord.js'
import { declaredRouteOf } from '../../models/roads/routeLaw.js'
import type { AssistantMessage, AttachmentMessage, Message, NormalizedUserMessage, UserMessage } from '../../engine/message-shapes/message.js'
import type { SessionListing, SerializedMessage, TranscriptMessage, TurnEnded } from '../transcripts/transcriptEntries.js'
import { PERMISSION_MODES } from '../../permissions/rules/permissions.js'
import { suppressNextSkillListing } from '../../engine/attachment-shapes/skillListing.js'
import { getCwd } from '../../platform/files/cwd.js'
import { isOneOf } from '../../platform/primitives/isOneOf.js'
import { copyFileHistoryForResume } from '../../tools/engines/change-transaction/fileHistory.js'
import { logError } from '../../platform/logs/errorLog.js'
import { parseUserSpecifiedModel } from '../../models/catalogue/engineModel.js'
import { mintImmediateReceipt } from '../../models/facts/seatReceipts.js'
import {
  createAssistantMessage,
  createUserMessage,
  filterOrphanedThinkingOnlyMessages,
  filterWhitespaceOnlyAssistantMessages,
  isToolUseResultMessage,
  isTurnCutText,
  NO_RESPONSE_REQUESTED,
  normalizeAttachmentForAPI,
  normalizeMessages,
  SYNTHETIC_MESSAGES,
} from '../../engine/messages/messages.js'
import { settleToolUsesOfEndedRun } from '../../engine/messages/apiFilters.js'
import { isCutResultText } from '../../engine/message-shapes/turnCut.js'
import {
  accumulateOpenToolUses,
  cloneOpenToolUses,
  freshOpenToolUses,
  openToolUseIDs,
  type OpenToolUses,
} from '../../engine/message-shapes/openToolUses.js'
import { runSessionStartHooks } from '../../daemon/runner/sessionStart.js'
import { resumeFactsOf, type ResumeFacts } from '../transcripts/sessionListings.js'
import {
  buildConversationChain,
  checkResumeConsistency,
  lastSession,
  sessionIdOfListing,
  isLiteListing,
  fillSessionListing,
  listProjectSessions,
  loadTranscriptFile,
  removeExtraFields,
} from '../transcripts/sessionStorage.js'
import { PERSISTED_OUTPUT_TAG } from '../../engine/tool-dispatch/toolResultStorage.js'
import { asSessionId, type SessionId } from '../transcripts/ids.js'


export type TurnInterruptionState =
  | { kind: 'none' }
  | { kind: 'interrupted_prompt'; message: NormalizedUserMessage }

type InternalInterruptionState =
  | TurnInterruptionState
  | { kind: 'interrupted_turn' }

export function getResumePrompt(): string {
  return 'The previous run ended before its turn finished — stopped from outside or crashed; continue from where you left off.'
}


type LegacyAttachmentRecord = {
  type?: string
  filename?: string
  path?: string
  skillDir?: string
  displayPath?: string
}

function migrateLegacyAttachment(message: Message): Message {
  if (message.type !== 'attachment') return message
  const raw: LegacyAttachmentRecord = message.attachment
  if (raw.type === 'new_file' && typeof raw.filename === 'string') {
    return {
      ...message,
      attachment: {
        ...message.attachment,
        type: 'file',
        displayPath: relative(getCwd(), raw.filename),
      },
    } as AttachmentMessage
  }
  if (raw.type === 'new_directory' && typeof raw.path === 'string') {
    return {
      ...message,
      attachment: {
        ...message.attachment,
        type: 'directory',
        displayPath: relative(getCwd(), raw.path),
      },
    } as AttachmentMessage
  }
  if (raw.displayPath === undefined) {
    const candidate = raw.filename ?? raw.path ?? raw.skillDir
    if (typeof candidate === 'string') {
      return {
        ...message,
        attachment: {
          ...message.attachment,
          displayPath: relative(getCwd(), candidate),
        },
      } as AttachmentMessage
    }
  }
  return message
}

const noticedPermissionModes: Set<string> = new Set()
function scrubPermissionMode(message: Message): Message {
  if (message.type !== 'user') return message
  const mode = (message as UserMessage).permissionMode
  if (mode === undefined) return message
  if (isOneOf(PERMISSION_MODES, mode)) return message
  if (!noticedPermissionModes.has(mode)) {
    noticedPermissionModes.add(mode)
    mintImmediateReceipt(
      `▲ the saved permission mode '${mode}' is not one this build knows — resuming in the default mode`,
      'warning',
    )
  }
  return { ...message, permissionMode: undefined } as Message
}


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
        return typeof use.name === 'string' && TURN_TERMINATING_TOOL_NAMES.includes(use.name)
      }
    }
  }
  return false
}

function isSyntheticApiErrorAssistant(message: Message): boolean {
  return message.type === 'assistant' && Boolean((message as { isApiErrorMessage?: boolean }).isApiErrorMessage)
}

function asksNoReply(message: Message): boolean {
  if (message.type === 'attachment') return normalizeAttachmentForAPI(message.attachment).length === 0
  return message.type === 'system' || message.type === 'progress' || isSyntheticApiErrorAssistant(message)
}

const TURN_ENDING_STOPS: ReadonlySet<string> = new Set(['end_turn', 'stop_sequence', 'refusal'])

function outputCapIsAskedAgain(model: string): boolean {
  const route = declaredRouteOf(model)
  return route === null || route === 'anthropic'
}

function stopEndsTurn(stop: string, model: string): boolean {
  return TURN_ENDING_STOPS.has(stop) || (stop === 'max_tokens' && !outputCapIsAskedAgain(model))
}

function replyStops(messages: Message[]): Map<string, string> {
  const stops = new Map<string, string>()
  for (const message of messages) {
    if (message.type === 'assistant' && message.message.stop_reason != null) stops.set(message.message.id, message.message.stop_reason)
  }
  return stops
}

const RUN_ENDS_ITS_TURN = ['the turn ends here', 'the reply stands']

function saysRunEndedTurn(message: Message): boolean {
  if (isSyntheticApiErrorAssistant(message)) return true
  return message.type === 'system' && message.subtype === 'informational' && RUN_ENDS_ITS_TURN.some(words => message.content.includes(words))
}

function isLoopGuardStop(message: Message): boolean {
  return message.type === 'attachment' && message.attachment.type === 'loop_stopped'
}

function turnOfLastReply(reply: AssistantMessage, stops: ReadonlyMap<string, string>, ended: boolean, trailed: boolean): InternalInterruptionState {
  if (ended) return { kind: 'none' }
  const stop = stops.get(reply.message.id) ?? reply.message.stop_reason
  if (stop === undefined) return trailed ? { kind: 'interrupted_turn' } : { kind: 'none' }
  return stop !== null && stopEndsTurn(stop, reply.message.model) ? { kind: 'none' } : { kind: 'interrupted_turn' }
}


function runEndedLastTurn(chain: Message[], turnEnd: TurnEnded | undefined): boolean {
  if (turnEnd === undefined || turnEnd.status === 'interrupted') return false
  const trailing = new Set<string>(turnEnd.trailing)
  return !chain.some(row => trailing.has(row.uuid) && !asksNoReply(row))
}

function isOwnCutToolResult(message: UserMessage): boolean {
  const content = message.message.content
  if (!Array.isArray(content)) return false
  const first = content[0]
  return (
    first !== undefined &&
    first.type === 'tool_result' &&
    first.is_error === true &&
    typeof first.content === 'string' &&
    isCutResultText(first.content)
  )
}

function detectInterruption(
  messages: Message[],
  stops: ReadonlyMap<string, string>,
  turnOpen: boolean,
): InternalInterruptionState {
  if (messages.length === 0) return { kind: 'none' }
  let ended = false
  let lastIndex = messages.length - 1
  while (lastIndex >= 0) {
    const row = messages[lastIndex]!
    if (saysRunEndedTurn(row)) ended = true
    if (row.type === 'system' || row.type === 'progress' || isSyntheticApiErrorAssistant(row)) {
      lastIndex--
      continue
    }
    break
  }
  if (lastIndex < 0) return { kind: 'none' }
  const last = messages[lastIndex]!
  if (last.type === 'assistant') {
    return turnOfLastReply(last, stops, ended, false)
  }
  if (last.type === 'user') {
    if (last.isCompactSummary) return { kind: 'none' }
    if (last.isMeta) return turnOpen ? { kind: 'interrupted_turn' } : { kind: 'none' }
    if (isToolUseResultMessage(last)) {
      if (isTurnTerminatingToolResult(messages, lastIndex) || isOwnCutToolResult(last)) {
        return { kind: 'none' }
      }
      return { kind: 'interrupted_turn' }
    }
    return { kind: 'interrupted_prompt', message: last as NormalizedUserMessage }
  }
  if (last.type === 'attachment') {
    for (let i = lastIndex; i >= 0; i--) {
      const row = messages[i]!
      if (isLoopGuardStop(row)) return { kind: 'none' }
      if (saysRunEndedTurn(row)) ended = true
      if (asksNoReply(row)) continue
      if (row.type === 'assistant') {
        return turnOfLastReply(row, stops, ended, true)
      }
      if (row.type === 'user' && isOwnCutToolResult(row)) {
        return { kind: 'none' }
      }
      return { kind: 'interrupted_turn' }
    }
    return { kind: 'interrupted_turn' }
  }
  return { kind: 'none' }
}

function deserializeMessagesWithInterruptDetection(
  serialized: Message[],
  turnEnd?: TurnEnded,
  turnOpen = false,
): { messages: Message[]; turnInterruptionState: TurnInterruptionState } {
  try {
    let messages = withoutRetractedReplies(
      rehydrateScreenshots(
        serialized.map(migrateLegacyAttachment).map(scrubPermissionMode),
      ),
    )
    const ended = runEndedLastTurn(messages, turnEnd)
    const stops = replyStops(messages)
    messages = settleToolUsesOfEndedRun(messages)
    messages = filterOrphanedThinkingOnlyMessages(messages)
    messages = filterWhitespaceOnlyAssistantMessages(messages)

    const detected: InternalInterruptionState = ended
      ? { kind: 'none' }
      : detectInterruption(messages, stops, turnOpen)

    let turnInterruptionState: TurnInterruptionState
    if (detected.kind === 'interrupted_turn') {
      const resumePrompt = normalizeMessages([
        createUserMessage({ content: getResumePrompt(), isMeta: true }),
      ])[0]!
      messages = [...messages, resumePrompt]
      turnInterruptionState = { kind: 'interrupted_prompt', message: resumePrompt }
    } else {
      turnInterruptionState = detected
    }

    let lastNonMetaIdx = messages.length - 1
    while (
      lastNonMetaIdx >= 0 &&
      (messages[lastNonMetaIdx]!.type === 'system' || messages[lastNonMetaIdx]!.type === 'progress')
    ) {
      lastNonMetaIdx--
    }
    if (lastNonMetaIdx >= 0 && messages[lastNonMetaIdx]!.type === 'user') {
      const sentinel = createAssistantMessage({ content: NO_RESPONSE_REQUESTED })
      messages = [
        ...messages.slice(0, lastNonMetaIdx + 1),
        sentinel,
        ...messages.slice(lastNonMetaIdx + 1),
      ]
    }

    return { messages, turnInterruptionState }
  } catch (error) {
    logError(error)
    throw error
  }
}

export function deserializeMessages(serialized: Message[]): Message[] {
  return deserializeMessagesWithInterruptDetection(serialized).messages
}

export function deserializeLiveMessages(serialized: readonly Message[]): Message[] {
  return serialized.map(migrateLegacyAttachment).map(scrubPermissionMode)
}

type LiveTurnState = {
  inFlight: boolean
  phase: 'thinking' | 'tool' | 'responding' | 'idle'
  agentsWaiting: 0
  inProgressToolUseIDs: Set<string>
  turnStartedAtMs: number | null
}

type TurnAccumulator = {
  tools: OpenToolUses
  lastPromptMs: number | null
  lastAssistantMs: number | null
  lastAssistantKind: 'thinking' | 'tool' | 'responding' | null
}

const freshTurnAccumulator = (): TurnAccumulator => ({
  tools: freshOpenToolUses(),
  lastPromptMs: null,
  lastAssistantMs: null,
  lastAssistantKind: null,
})

const cloneTurnAccumulator = (acc: TurnAccumulator): TurnAccumulator => ({
  tools: cloneOpenToolUses(acc.tools),
  lastPromptMs: acc.lastPromptMs,
  lastAssistantMs: acc.lastAssistantMs,
  lastAssistantKind: acc.lastAssistantKind,
})

const parseTurnTime = (timestamp: string): number | null => {
  const parsed = Date.parse(timestamp)
  return Number.isNaN(parsed) ? null : parsed
}

const SHELL_ECHO_MARK = '<bash-input>'

const isLocalShellEcho = (content: UserMessage['message']['content']): boolean => {
  if (typeof content === 'string') return content.startsWith(SHELL_ECHO_MARK)
  const first = content[0]
  return first !== undefined && first.type === 'text' && typeof first.text === 'string' && first.text.trimStart().startsWith(SHELL_ECHO_MARK)
}

const isSyntheticUserRow = (content: UserMessage['message']['content']): boolean => {
  const only = typeof content === 'string' ? content : content.length === 1 && content[0]?.type === 'text' ? content[0].text : undefined
  if (typeof only !== 'string') return false
  const text = only.trim()
  return SYNTHETIC_MESSAGES.has(text) || isTurnCutText(text)
}

function accumulateTurn(acc: TurnAccumulator, message: Message): void {
  if (message.type === 'user') {
    accumulateOpenToolUses(acc.tools, message)
    const content = message.message.content
    if (Array.isArray(content)) {
      let carriedToolResult = false
      for (const block of content) {
        const record = block as { type?: string; tool_use_id?: string }
        if (record.type === 'tool_result' && record.tool_use_id) carriedToolResult = true
      }
      if (!carriedToolResult && !message.isMeta && !isLocalShellEcho(content) && !isSyntheticUserRow(content)) {
        acc.lastPromptMs = parseTurnTime(message.timestamp) ?? acc.lastPromptMs
      }
    } else if (!message.isMeta && !isLocalShellEcho(content) && !isSyntheticUserRow(content)) {
      acc.lastPromptMs = parseTurnTime(message.timestamp) ?? acc.lastPromptMs
    }
  } else if (message.type === 'assistant') {
    accumulateOpenToolUses(acc.tools, message)
    acc.lastAssistantMs = parseTurnTime(message.timestamp) ?? acc.lastAssistantMs
    const content = message.message.content
    if (Array.isArray(content)) {
      const last = content[content.length - 1] as { type?: string } | undefined
      if (last?.type === 'thinking' || last?.type === 'redacted_thinking') acc.lastAssistantKind = 'thinking'
      else if (last?.type === 'tool_use') acc.lastAssistantKind = 'tool'
      else acc.lastAssistantKind = 'responding'
    }
  }
}

function settleTurn(acc: TurnAccumulator): LiveTurnState {
  const unresolved = openToolUseIDs(acc.tools)
  const promptOpen =
    acc.lastPromptMs !== null &&
    (acc.lastAssistantMs === null || acc.lastAssistantMs < acc.lastPromptMs - 1)
  const inFlight =
    unresolved.size > 0 ||
    acc.lastAssistantKind === 'thinking' ||
    promptOpen
  let phase: 'thinking' | 'tool' | 'responding' | 'idle' = 'idle'
  if (inFlight) {
    if (unresolved.size > 0) phase = 'tool'
    else if (acc.lastAssistantKind === 'thinking') phase = 'thinking'
    else phase = 'thinking'
  }
  return { inFlight, phase, agentsWaiting: 0, inProgressToolUseIDs: unresolved, turnStartedAtMs: inFlight ? acc.lastPromptMs : null }
}

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

export function liveTurnStateOf(messages: Message[]): LiveTurnState {
  return createLiveTurnFold().fold(messages, 0)
}


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
  const attachment = message.attachment as { type?: string; event?: string; outcome?: string; words?: unknown }
  if (attachment.type !== 'hook' || attachment.event !== 'session.start' || attachment.outcome !== 'context') return []
  return typeof attachment.words === 'string' && attachment.words !== '' ? [dedupKeyFor(attachment.words)] : []
}

function filterDuplicateSessionStartHooks(incoming: Message[], transcript: Message[]): Message[] {
  if (incoming.length === 0) return []
  const existing = new Set<string>()
  for (const message of transcript) {
    for (const key of hookKeysOf(message)) existing.add(key)
  }
  if (existing.size === 0) return [...incoming]
  return incoming.filter(message => {
    const keys = hookKeysOf(message)
    return keys.length === 0 || !existing.has(keys[0] as string)
  })
}


type WalkedTranscript = {
  messages: SerializedMessage[]
  sessionId: UUID | undefined
  facts: ResumeFacts
}

async function walkTranscriptFile(path: string): Promise<WalkedTranscript> {
  const loaded = await loadTranscriptFile(path)
  const messages = loaded.messages
  const referencedParents = new Set<string>()
  for (const message of messages.values()) {
    if (message.parentUuid && !message.isSidechain) referencedParents.add(message.parentUuid)
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
  if (!best) return { messages: [], sessionId: undefined, facts: {} }
  const chain = buildConversationChain(messages, best)
  const sessionId = best.sessionId as UUID
  return {
    messages: removeExtraFields(chain),
    sessionId,
    facts: resumeFactsOf(loaded, sessionId, chain),
  }
}

type ResumeResult = ResumeFacts & {
  messages: Message[]
  turnInterruptionState: TurnInterruptionState
  sessionId: SessionId | undefined
  fullPath?: string
}

export function hasConversationTurn(messages: readonly { type: string }[]): boolean {
  return messages.some(m => m.type === 'user' || m.type === 'assistant')
}

function listingFactsOf(listing: SessionListing): ResumeFacts {
  return {
    fileHistorySnapshots: listing.fileHistorySnapshots,
    attributionSnapshots: listing.attributionSnapshots,
    contentReplacements: listing.contentReplacements,
    contextCollapseCommits: listing.contextCollapseCommits,
    contextCollapseSnapshot: listing.contextCollapseSnapshot,
    agentName: listing.agentName,
    agentColor: listing.agentColor,
    agentSetting: listing.agentSetting,
    brief: listing.brief,
    briefAdd: listing.briefAdd,
    customTitle: listing.customTitle,
    tag: listing.tag,
    mode: listing.mode,
    advisor: listing.advisor,
    swarm: listing.swarm,
    model: listing.model,
    worktreeSession: listing.worktreeSession,
    prNumber: listing.prNumber,
    prUrl: listing.prUrl,
    prRepository: listing.prRepository,
    turnEnd: listing.turnEnd,
    ...(listing.turnOpen === true ? { turnOpen: true } : {}),
  }
}

export async function loadConversationForResume(
  source: string | SessionListing | undefined,
  sourceJsonlFile: string | undefined,
): Promise<ResumeResult | null> {
  try {
    let rawMessages: Message[]
    let sessionId: UUID | undefined
    let facts: ResumeFacts
    let fullPath: string | undefined

    if (source === undefined) {
      const listings = await listProjectSessions()
      const listing = listings[0]
      if (!listing) return null
      const hydrated = isLiteListing(listing) ? await fillSessionListing(listing) : listing
      sessionId = sessionIdOfListing(hydrated)
      void copyFileHistoryForResume(hydrated)
      rawMessages = hydrated.messages
      checkResumeConsistency(rawMessages)
      fullPath = hydrated.fullPath
      facts = listingFactsOf(hydrated)
    } else if (sourceJsonlFile !== undefined) {
      const walked = await walkTranscriptFile(sourceJsonlFile)
      rawMessages = walked.messages
      sessionId = walked.sessionId
      facts = walked.facts
      fullPath = sourceJsonlFile
    } else {
      let listing: SessionListing | null
      let suppliedId: UUID | undefined
      if (typeof source === 'string') {
        suppliedId = source as UUID
        listing = await lastSession(suppliedId)
      } else {
        listing = source
      }
      if (!listing) return null
      const hydrated = isLiteListing(listing) ? await fillSessionListing(listing) : listing
      sessionId = suppliedId ?? sessionIdOfListing(hydrated)
      void copyFileHistoryForResume(hydrated)
      rawMessages = hydrated.messages
      checkResumeConsistency(rawMessages)
      fullPath = hydrated.fullPath
      facts = listingFactsOf(hydrated)
    }

    if (!hasConversationTurn(rawMessages)) return null

    for (const message of rawMessages) {
      if (message.type !== 'attachment') continue
      if (message.attachment.type === 'invoked_skills') {
        const skills = message.attachment.skills
        if (Array.isArray(skills)) {
          for (const skill of skills) {
            if (skill.name && skill.path && skill.content) {
              addInvokedSkill(skill.name, skill.path, skill.content)
            }
          }
        }
      } else if (message.attachment.type === 'skill_listing') {
        suppressNextSkillListing()
      }
    }

    restoreBoundPrefixFromMessages(rawMessages)

    try {
      const owner = sessionId ? mainOwnerOfSession(sessionId) : processMainOwner()
      const rebuilt = rebuildSeenLinesFromTranscript(owner, rawMessages)
      if (rebuilt.files > 0) {
        logForDebugging(
          `read ledger: ${rebuilt.lines} line(s) of ${rebuilt.files} file(s) this session read or wrote before the restart still read the same and count as read`,
        )
      }
    } catch (error) {
      logForDebugging(
        `read ledger: the transcript could not be read back for the seen lines (${String(error)})`,
      )
    }

    const { messages: deserialized, turnInterruptionState } =
      deserializeMessagesWithInterruptDetection(rawMessages, facts.turnEnd, facts.turnOpen === true)

    const recordedModel =
      getEngineModelOverride() === undefined && facts.model
        ? parseUserSpecifiedModel(facts.model)
        : undefined
    const incomingHooks = await runSessionStartHooks('resumed', {
      sessionId,
      ...(recordedModel !== undefined ? { model: recordedModel } : {}),
    })
    const filteredHooks = filterDuplicateSessionStartHooks(incomingHooks, deserialized)
    const messages = filteredHooks.length > 0 ? [...deserialized, ...filteredHooks] : deserialized

    return {
      messages,
      turnInterruptionState,
      sessionId: sessionId !== undefined ? asSessionId(sessionId) : undefined,
      ...facts,
      fullPath,
    }
  } catch (error) {
    logError(error)
    throw error
  }
}
