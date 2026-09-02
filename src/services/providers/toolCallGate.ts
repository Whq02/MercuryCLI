import type { Tools } from '../../Tool.js'
import { findToolByName } from '../../Tool.js'
import type { AssistantMessage, RefusedToolCall } from '../../types/message.js'
import { formatZodValidationError } from '../../utils/toolErrors.js'
import { stripNullArgs } from './openai/openaiWire.js'

export interface IncomingToolCall {
  id: string
  name: string
  argumentsRaw: string
  malformed: boolean
}

export type ToolCallVerdict =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; refusal: RefusedToolCall }

const PLACEHOLDER_ID = /^missing-(call-)?id(-\d+)?$/

function refused(call: IncomingToolCall, code: RefusedToolCall['code'], reason: string): ToolCallVerdict {
  return {
    ok: false,
    refusal: { id: call.id, name: call.name, argumentsRaw: call.argumentsRaw, code, reason },
  }
}

export interface ToolCallGateHints {
  deferredUnadmitted?: (name: string) => boolean
}

export function schemaNotSentSentence(toolName: string): string {
  return `This tool's schema was not sent to the model: ${toolName} is a deferred tool this session has not admitted yet. Load it first: call ToolSearch with query "select:${toolName}", then retry the call with the schema in hand.`
}

export function gateToolCall(tools: Tools, call: IncomingToolCall, hints?: ToolCallGateHints): ToolCallVerdict {
  if (call.name.trim() === '') {
    return refused(call, 'unknown-tool', 'the call carried no tool name')
  }
  const tool = findToolByName(tools, call.name)
  if (!tool) {
    return refused(call, 'unknown-tool', `No such tool available: ${call.name}`)
  }
  const raw = call.argumentsRaw.trim() === '' ? '{}' : call.argumentsRaw
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    return refused(
      call,
      'invalid-json',
      `the arguments were not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  if (call.malformed && (call.id.trim() === '' || PLACEHOLDER_ID.test(call.id))) {
    return refused(call, 'missing-id', 'the provider delivered the call without a call id, so its result could not be paired')
  }
  const stripped = stripNullArgs(parsed)
  if (typeof stripped !== 'object' || stripped === null || Array.isArray(stripped)) {
    return refused(
      call,
      'not-an-object',
      `the arguments must be a JSON object, not ${Array.isArray(stripped) ? 'an array' : stripped === null ? 'null' : `a ${typeof stripped}`}`,
    )
  }
  const input = stripped as Record<string, unknown>
  try {
    const verdict = tool.inputSchema.safeParse(input)
    if (!verdict.success) {
      const reason = formatZodValidationError(tool.name, verdict.error, tool.inputJSONSchema)
      const unadmitted = hints?.deferredUnadmitted?.(tool.name) === true
      return refused(call, 'schema', unadmitted ? `${reason}\n${schemaNotSentSentence(tool.name)}` : reason)
    }
  } catch (error) {
    return refused(
      call,
      'schema',
      `the ${tool.name} tool's input schema could not validate these arguments (${error instanceof Error ? error.message : String(error)})`,
    )
  }
  return { ok: true, input }
}

export function gateToolCalls(tools: Tools, calls: readonly IncomingToolCall[], hints?: ToolCallGateHints): ToolCallVerdict[] {
  const seen = new Set<string>()
  return calls.map(call => {
    const verdict = gateToolCall(tools, call, hints)
    if (!verdict.ok) return verdict
    if (seen.has(call.id)) {
      return refused(
        call,
        'duplicate-id',
        `the provider reused call id ${call.id} for a second call in the same turn; only the first call carrying that id ran`,
      )
    }
    seen.add(call.id)
    return verdict
  })
}

const RAW_PREVIEW_CHARS = 600

function previewRaw(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '') return '(empty)'
  return trimmed.length > RAW_PREVIEW_CHARS
    ? `${trimmed.slice(0, RAW_PREVIEW_CHARS)}… [${trimmed.length - RAW_PREVIEW_CHARS} more characters]`
    : trimmed
}

function issueSummary(reason: string): string {
  const lines = reason.split('\n').map(l => l.trim()).filter(Boolean)
  const body = lines.length > 1 && /failed due to the following issue/.test(lines[0]!) ? lines.slice(1) : lines
  return body.join('; ')
}

export function toolCallRefusalNote(lane: string, refusal: RefusedToolCall): string {
  const name = refusal.name.trim() === '' ? 'unnamed' : refusal.name
  switch (refusal.code) {
    case 'unknown-tool':
      return `[${lane}] No such tool available: ${name} — it is not in this session's tool list, so it was not executed. Call one of the tools you were given (a ToolSearch query loads a deferred tool when one is offered).`
    case 'missing-id':
      return `[${lane}] the provider emitted a malformed tool call (${name}): it carried no call id, so it was not executed.`
    case 'invalid-json':
      return `[${lane}] the provider emitted a malformed tool call (${name}): its arguments were not valid JSON, so it was not executed.`
    case 'not-an-object':
      return `[${lane}] the provider emitted a malformed tool call (${name}): its arguments were not a JSON object, so it was not executed.`
    case 'schema':
      return `[${lane}] the provider emitted a malformed tool call (${name}): the arguments do not match the tool's input schema (${issueSummary(refusal.reason)}) — it was not executed.`
    case 'duplicate-id':
      return `[${lane}] the provider emitted a second tool call (${name}) under a call id already used in this turn (${refusal.id}) — only the first call with that id was executed.`
  }
}

export const TOOL_CALL_REFUSAL_CORRECTION_HEAD =
  'One or more of your tool calls were refused by the harness before execution:'

export function toolCallRefusalCorrection(refusals: readonly RefusedToolCall[]): string {
  const items = refusals.map(refusal => {
    const name = refusal.name.trim() === '' ? '(no tool name)' : refusal.name
    const headline =
      refusal.code === 'unknown-tool'
        ? `unknown tool ${name}: ${refusal.reason}`
        : refusal.code === 'duplicate-id'
          ? `duplicate call id for ${name}: ${refusal.reason}`
          : `malformed arguments for ${name}: ${refusal.reason}`
    return `- call ${refusal.id || '(no id)'} — ${headline}\n  Arguments received: ${previewRaw(refusal.argumentsRaw)}`
  })
  return (
    `${TOOL_CALL_REFUSAL_CORRECTION_HEAD}\n${items.join('\n')}\n` +
    `None of these calls ran, so nothing happened. Re-issue each one with a tool name from your tool list, a call id of its own, and arguments that match that tool's input schema exactly (required parameters present, correct types, no extra fields on strict tools).`
  )
}

export function isToolCallRefusalCorrectionText(text: string): boolean {
  return text.startsWith(TOOL_CALL_REFUSAL_CORRECTION_HEAD)
}

export function collectRefusedToolCalls(messages: readonly AssistantMessage[]): RefusedToolCall[] {
  const out: RefusedToolCall[] = []
  for (const message of messages) {
    if (message.refusedToolCalls) out.push(...message.refusedToolCalls)
  }
  return out
}
