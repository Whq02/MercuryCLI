import { rebuildSeenLinesFromTranscript } from '../changeTransaction/seenLines.js'
import { logForDebugging } from '../../utils/debug.js'
import { mainOwnerOfSession, processMainOwner } from '../../utils/run/resolveOwner.js'
import type { UUID } from 'crypto'
import { relative } from 'node:path'

import { addInvokedSkill, getEngineModelOverride } from '../../bootstrap/state.js'
import { rehydrateScreenshots } from '../desktop/screenshotRetention.js'
import { withoutRetractedReplies } from '../engine-connector/midTurnText.js'
import { restoreBoundPrefixFromMessages } from '../providers/anthropic/boundPrefixRecord.js'
import { declaredRouteOf } from '../providers/routeLaw.js'
import type { AssistantMessage, AttachmentMessage, Message, NormalizedUserMessage, UserMessage } from '../../types/message.js'
import type { SessionListing, SerializedMessage, TranscriptMessage, TurnEnded } from '../../types/logs.js'
import { PERMISSION_MODES } from '../../types/permissions.js'
import { suppressNextSkillListing } from '../../utils/attachments/skillListing.js'
import { getCwd } from '../../utils/cwd.js'
import { copyFileHistoryForResume } from '../changeTransaction/fileHistory.js'
import { logError } from '../../utils/log.js'
import { parseUserSpecifiedModel } from '../model/model.js'
import { mintImmediateReceipt } from '../../utils/model/seatReceipts.js'
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
} from '../messages.js'
import { settleToolUsesOfEndedRun } from '../messages/apiFilters.js'
import { isCutResultText } from '../../utils/messages/turnCut.js'
import {
  accumulateOpenToolUses,
  cloneOpenToolUses,
  freshOpenToolUses,
  openToolUseIDs,
  type OpenToolUses,
} from '../../utils/messages/openToolUses.js'
import { runSessionStartHooks } from '../sessionStart.js'
import { resumeFactsOf, type ResumeFacts } from '../../utils/sessionStorage/logs.js'
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
} from '../../utils/sessionStorage.js'
import { PERSISTED_OUTPUT_TAG } from '../../utils/toolResultStorage.js'
import { asSessionId, type SessionId } from '../../types/ids.js'
import { notBuilt, unbuilt, type Unbuilt } from '../../pi/holes.js'


export type TurnInterruptionState =
  Unbuilt

type InternalInterruptionState = Unbuilt

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
  return notBuilt('src/services/resume/conversationRecovery.ts:83')
}

const noticedPermissionModes: Set<string> = unbuilt('src/services/resume/conversationRecovery.ts:101')
function scrubPermissionMode(message: Message): Message {
  if (message.type !== 'user') return message
  const mode = (message as UserMessage).permissionMode
  if (mode === undefined) return message
  if ((PERMISSION_MODES as readonly string[]).includes(mode)) return message
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

export function deserializeMessages(serialized: Message[]): Message[] {
  return notBuilt('src/services/resume/conversationRecovery.ts:281')
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


type WalkedTranscript = Unbuilt

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

type ResumeResult = Unbuilt

export function hasConversationTurn(messages: readonly { type: string }[]): boolean {
  return messages.some(m => m.type === 'user' || m.type === 'assistant')
}

export async function loadConversationForResume(
  source: string | SessionListing | undefined,
  sourceJsonlFile: string | undefined,
): Promise<ResumeResult | null> {
  return notBuilt('src/services/resume/conversationRecovery.ts:513')
}
