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


export type TurnInterruptionState =
  | { kind: 'none' }
  | { kind: 'interrupted_prompt'; message: NormalizedUserMessage }

type InternalInterruptionState = TurnInterruptionState | { kind: 'interrupted_turn' }

export type DeserializeResult = {
  messages: Message[]
  turnInterruptionState: TurnInterruptionState
}

export function getResumePrompt(): string {
  return 'Continue from where you left off.'
}


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

function detectInterruption(messages: Message[]): InternalInterruptionState {
  if (messages.length === 0) return { kind: 'none' }
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
    return { kind: 'none' }
  }
  if (last.type === 'user') {
    if (last.isMeta || last.isCompactSummary) return { kind: 'none' }
    if (isToolUseResultMessage(last)) {
      return isTurnTerminatingToolResult(messages, index) ? { kind: 'none' } : { kind: 'interrupted_turn' }
    }
    return { kind: 'interrupted_prompt', message: last as NormalizedUserMessage }
  }
  if (last.type === 'attachment') {
    return { kind: 'interrupted_turn' }
  }
  return { kind: 'none' }
}


export function deserializeMessagesWithInterruptDetection(serialized: Message[]): DeserializeResult {
  try {
    let messages = serialized.map(migrateLegacyAttachment).map(scrubPermissionMode)
    messages = filterUnresolvedToolUses(messages)
    messages = filterOrphanedThinkingOnlyMessages(messages)
    messages = filterWhitespaceOnlyAssistantMessages(messages)

    let interruption: TurnInterruptionState = { kind: 'none' }
    const detected = detectInterruption(messages)
    if (detected.kind === 'interrupted_turn') {
      const continuation = normalizeMessages([
        createUserMessage({ content: getResumePrompt(), isMeta: true }),
      ])[0] as NormalizedUserMessage
      messages = [...messages, continuation]
      interruption = { kind: 'interrupted_prompt', message: continuation }
    } else if (detected.kind === 'interrupted_prompt') {
      interruption = detected
    }

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

export function deserializeMessages(serialized: Message[]): Message[] {
  return deserializeMessagesWithInterruptDetection(serialized).messages
}

export function deserializeLiveMessages(serialized: Message[]): Message[] {
  return serialized.map(migrateLegacyAttachment).map(scrubPermissionMode)
}

export type LiveTurnState = {
  inFlight: boolean
  phase: 'thinking' | 'tool' | 'responding' | 'idle'
  agentsWaiting: 0
  inProgressToolUseIDs: Set<string>
  turnStartedAtMs: number | null
}

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
    else phase = 'thinking'
  }
  return { inFlight, phase, agentsWaiting: 0, inProgressToolUseIDs: unresolved, turnStartedAtMs: acc.lastPromptMs }
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
      const logs = await loadMessageLogs()
      log = logs[0]
    } else if (sourceJsonlFile !== undefined) {
      const walked = await walkTranscriptFile(sourceJsonlFile)
      messages = walked.messages
      sessionId = walked.sessionId as SessionId | undefined
    } else if (typeof source === 'string') {
      log = await getLastSessionLog(source as UUID)
      sessionId = asSessionId(source)
    } else {
      log = source
    }

    if (!log && messages === undefined) return null

    if (log) {
      if (isLiteLog(log)) log = await loadFullLog(log)
      if (sessionId === undefined) sessionId = getSessionIdFromLog(log) as SessionId
      if (sessionId !== undefined) {
        await copyPlanForResume(log, sessionId)
      }
      void copyFileHistoryForResume(log)
      messages = log.messages as SerializedMessage[]
      checkResumeConsistency(messages as unknown as Message[])
      fullPath = log.fullPath
    }

    const asMessages = (messages ?? []) as unknown as Message[]
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
