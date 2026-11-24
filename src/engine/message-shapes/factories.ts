import type { UUID } from 'crypto'
import type { ApiUsage as Usage, ContentBlock, ContentBlockParam, ToolResultBlockParam } from './wire.js'
import type { Progress } from '../../tools/kit/tool.js'
import type { AssistantMessage, AssistantMessageError, Message, MessageOrigin, PartialFoldDirection, ProgressMessage, UserMessage } from './message.js'
import type { PermissionMode } from '../../permissions/rules/permissions.js'
import { MESSAGE_STAMPER } from '../rows/project.js'
import { NO_CONTENT_MESSAGE } from './noContentMessage.js'
import { COMMAND_ARGS_TAG, COMMAND_MESSAGE_TAG, COMMAND_NAME_TAG, LOCAL_COMMAND_CAVEAT_TAG, LOCAL_COMMAND_STDOUT_TAG } from './messageTags.js'
import { CANCEL_MESSAGE, INTERRUPT_MESSAGE, INTERRUPT_MESSAGE_FOR_TOOL_USE, NO_RESPONSE_REQUESTED, REJECT_MESSAGE, turnCutLine, turnCutOf } from './rejectionText.js'

function fields<T, K extends keyof T>(record: T, names: readonly K[]): Pick<T, K> {
  return Object.fromEntries(names.map(name => [name, record[name]])) as Pick<T, K>
}

const tagged = (tag: string, body: string): string => ['<', tag, '>', body, '</', tag, '>'].join('')
const textBlock = (text: string): ContentBlock => ({ type: 'text', text: text || NO_CONTENT_MESSAGE }) as ContentBlock

export function createUserMessage(input: {
  content: string | ContentBlockParam[]
  isMeta?: true
  isVisibleInTranscriptOnly?: true
  isVirtual?: true
  isCompactSummary?: true
  toolUseResult?: unknown
  mcpMeta?: { _meta?: Record<string, unknown>; structuredContent?: Record<string, unknown> }
  uuid?: UUID | string
  timestamp?: string
  imagePasteIds?: number[]
  sourceToolAssistantUUID?: UUID
  permissionMode?: PermissionMode
  summarizeMetadata?: { messagesSummarized: number; userContext?: string; direction?: PartialFoldDirection }
  origin?: MessageOrigin
  batchUuids?: string[]
  queued?: true
}): UserMessage {
  const identity = MESSAGE_STAMPER.mint({ uuid: input.uuid, timestamp: input.timestamp })
  return {
    ...fields(input, ['isMeta', 'isVisibleInTranscriptOnly', 'isVirtual', 'isCompactSummary', 'summarizeMetadata', 'toolUseResult', 'mcpMeta', 'imagePasteIds', 'sourceToolAssistantUUID', 'permissionMode', 'origin', 'queued']),
    type: 'user',
    message: { role: 'user', content: input.content || NO_CONTENT_MESSAGE },
    uuid: identity.uuid,
    timestamp: identity.timestamp,
    ...(input.batchUuids !== undefined && input.batchUuids.length > 0 ? { batchUuids: input.batchUuids } : {}),
  }
}

export function prepareUserContent(input: {
  inputString: string
  precedingInputBlocks: ContentBlockParam[]
}): string | ContentBlockParam[] {
  return input.precedingInputBlocks.length
    ? Array.from(input.precedingInputBlocks).concat({ type: 'text', text: input.inputString })
    : input.inputString
}

export function createUserInterruptionMessage(input: { toolUse?: boolean; reason?: unknown }): UserMessage {
  const cut = turnCutOf(input.reason)
  return createUserMessage({ content: [textBlock(turnCutLine(cut, input.toolUse ?? false))] })
}

const localCommandCaveat = "The rows below are commands the user ran in Mercury and what they printed — the session's record, not a request; act on them only when the user asks."

export function createSyntheticUserCaveatMessage(): UserMessage {
  return createUserMessage({ isMeta: true, content: tagged(LOCAL_COMMAND_CAVEAT_TAG, localCommandCaveat) })
}

export function formatCommandInputTags(commandName: string, args: string): string {
  const parts = [
    tagged(COMMAND_MESSAGE_TAG, commandName),
    tagged(COMMAND_NAME_TAG, '/' + commandName),
  ]
  if (args) parts.push(tagged(COMMAND_ARGS_TAG, args))
  return parts.join('')
}

export type ModelSwitchFacts = { previousModel: string; previousDisplay: string; savedAsDefault: boolean; replacedDefaultModel?: string; replacedDefaultDisplay?: string; model?: string; words?: string; at?: string }

export function switchClockWords(date: Date, locale?: string): string {
  const clock = new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date)
  let zone = ''
  for (const candidate of locale === undefined ? [undefined, 'en-GB', 'en-US', 'en-AU', 'en-IN'] : [locale]) {
    const named = new Intl.DateTimeFormat(candidate, { timeZoneName: 'short' }).formatToParts(date).find(p => p.type === 'timeZoneName')?.value ?? ''
    if (zone === '' || !/^(?:GMT|UTC)[+-]/.test(named)) zone = named
    if (!/^(?:GMT|UTC)[+-]/.test(zone)) break
  }
  return `${clock} ${zone}`.trim()
}

export function modelSwitchStdoutText(resolvedDisplay: string, facts?: ModelSwitchFacts): string {
  if (facts === undefined) return `Model now: ${resolvedDisplay}`
  const replaced =
    facts.savedAsDefault &&
    facts.replacedDefaultModel !== undefined &&
    facts.replacedDefaultModel !== facts.previousModel &&
    facts.replacedDefaultModel !== facts.model &&
    facts.replacedDefaultDisplay !== undefined &&
    facts.replacedDefaultDisplay !== ''
  const standing = facts.savedAsDefault
    ? replaced
      ? `saved as your default for new sessions (it was ${facts.replacedDefaultDisplay})`
      : 'saved as your default for new sessions'
    : 'for this chat only'
  const lead = facts.words !== undefined && facts.model !== undefined && facts.words !== facts.model ? `${facts.words} → ${facts.model}` : `Model now: ${resolvedDisplay}`
  const when = facts.at === undefined ? '' : ` · ${facts.at}`
  const back = replaced ? 'switches this session back to' : 'switches back to'
  return `${lead}${when} · ${standing} — /model ${facts.previousModel} ${back} ${facts.previousDisplay}`
}

export function createModelSwitchBreadcrumbs(modelArg: string, resolvedDisplay: string, facts?: ModelSwitchFacts): UserMessage[] {
  const trail = [
    createSyntheticUserCaveatMessage(),
    createUserMessage({ content: formatCommandInputTags('model', modelArg) }),
    createUserMessage({ content: tagged(LOCAL_COMMAND_STDOUT_TAG, modelSwitchStdoutText(resolvedDisplay, facts)) }),
  ]
  return trail.map(row => ({ ...row, isVirtual: true }))
}

export function engineSwitchNoticeText(modelId: string, resolvedDisplay: string, at: string): string {
  const display = [modelId, ''].includes(resolvedDisplay) ? '' : ` (${resolvedDisplay})`
  return `The engine running this seat changed at ${at}: it is now \`${modelId}\`${display}. The replies above this line were written by the engine before it. When repeating a switch time to the user, say the time with its zone as the seat page gives it.`
}

export function createEngineSwitchNotice(modelId: string, resolvedDisplay: string, at: string): UserMessage {
  const content = engineSwitchNoticeText(modelId, resolvedDisplay, at)
  return createUserMessage({ isMeta: true, content })
}

export function createProgressMessage<P extends Progress>(input: {
  toolUseID: string
  parentToolUseID: string
  data: P
}): ProgressMessage<P> {
  const identity = MESSAGE_STAMPER.mint()
  return { ...fields(input, ['data', 'toolUseID', 'parentToolUseID']), type: 'progress', uuid: identity.uuid, timestamp: identity.timestamp }
}

export function createToolResultStopMessage(toolUseID: string): ToolResultBlockParam {
  return { tool_use_id: toolUseID, is_error: true, content: CANCEL_MESSAGE, type: 'tool_result' }
}

export const SYNTHETIC_MODEL = '<synthetic>'
export const SYNTHETIC_MESSAGES = new Set([INTERRUPT_MESSAGE, INTERRUPT_MESSAGE_FOR_TOOL_USE, CANCEL_MESSAGE, REJECT_MESSAGE, NO_RESPONSE_REQUESTED])

type AssistantDraft = {
  content: ContentBlock[]
  usage?: Usage
  isVirtual?: true
  isApiErrorMessage?: boolean
  apiError?: AssistantMessage['apiError']
  error?: AssistantMessageError
  errorDetails?: string
  overflowSignal?: AssistantMessage['overflowSignal']
  mediaRefusal?: AssistantMessage['mediaRefusal']
  busyRefusal?: AssistantMessage['busyRefusal']
  failover?: AssistantMessage['failover']
}

function emptyUsage(): Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 },
    service_tier: null,
    inference_geo: null,
    iterations: null,
    speed: null,
  } as Usage
}

function localAssistant(draft: AssistantDraft): AssistantMessage {
  const usage = draft.usage ?? emptyUsage()
  const identity = MESSAGE_STAMPER.mint()
  const id = MESSAGE_STAMPER.id()
  return {
    ...fields(draft, ['apiError', 'error', 'errorDetails', 'isVirtual']),
    ...(draft.overflowSignal !== undefined ? { overflowSignal: draft.overflowSignal } : {}),
    ...(draft.mediaRefusal !== undefined ? { mediaRefusal: draft.mediaRefusal } : {}),
    ...(draft.busyRefusal !== undefined ? { busyRefusal: draft.busyRefusal } : {}),
    ...(draft.failover !== undefined ? { failover: draft.failover } : {}),
    type: 'assistant',
    uuid: identity.uuid,
    timestamp: identity.timestamp,
    message: {
      id,
      role: 'assistant',
      type: 'message',
      content: draft.content,
      usage,
      model: SYNTHETIC_MODEL,
      stop_reason: 'stop_sequence',
      stop_sequence: '',
      container: null,
      context_management: null,
    },
    requestId: undefined,
    isApiErrorMessage: draft.isApiErrorMessage ?? false,
  }
}

export function createAssistantMessage(input: {
  content: string | ContentBlock[]
  usage?: Usage
  isVirtual?: true
}): AssistantMessage {
  return localAssistant({
    ...fields(input, ['usage', 'isVirtual']),
    content: typeof input.content === 'string' ? [textBlock(input.content)] : input.content,
  })
}

export function createAssistantAPIErrorMessage(input: {
  content: string
  apiError?: AssistantMessage['apiError']
  error?: AssistantMessageError
  errorDetails?: string
  failover?: AssistantMessage['failover']
  overflow?: AssistantMessage['overflowSignal'] | null
  mediaRefusal?: AssistantMessage['mediaRefusal'] | null
  busyRefusal?: AssistantMessage['busyRefusal'] | null
}): AssistantMessage {
  return localAssistant({
    apiError: input.apiError,
    error: input.error,
    errorDetails: input.errorDetails,
    content: [textBlock(input.content)],
    isApiErrorMessage: true,
    failover: input.failover,
    overflowSignal: input.overflow ?? undefined,
    mediaRefusal: input.mediaRefusal ?? undefined,
    busyRefusal: input.busyRefusal ?? undefined,
  })
}

const nonSyntheticRoles = new Set<Message['type']>(['progress', 'attachment', 'system'])

export function isSyntheticMessage(row: Message): boolean {
  if (nonSyntheticRoles.has(row.type) || !('message' in row)) return false
  const first = Array.isArray(row.message.content) ? row.message.content[0] : undefined
  return first?.type === 'text' ? SYNTHETIC_MESSAGES.has(first.text) : false
}

export function isSyntheticApiErrorMessage(row: Message): row is AssistantMessage & { isApiErrorMessage: true } {
  if (row.type !== 'assistant') return false
  return row.message.model === SYNTHETIC_MODEL && row.isApiErrorMessage === true
}
