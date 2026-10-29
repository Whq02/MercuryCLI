import type { Tools } from '../../Tool.js'
import { findToolByName, offeredToolNamesClause } from '../../Tool.js'
import type { AssistantMessage, RefusedToolCall } from '../../types/message.js'
import { formatZodValidationError } from '../../utils/toolErrors.js'
import { stripNullArgs } from './openai/openaiWire.js'
import { straightenQuotes } from '../../utils/curlyQuotes.js'
import { declaredInputSchema, repairArgumentsBySchema } from './local/schemaTyping.js'
import { CORRECT_TOOL_NAME, RETAIN_TOOL_NAME } from '../../tools/MemoryTools/prompt.js'
import { displayToolName } from '../../utils/toolNameDisplay.js'

interface IncomingToolCall {
  id: string
  name: string
  argumentsRaw: string
  malformed: boolean
  providerRefusal?: string
}

type ToolCallVerdict =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; refusal: RefusedToolCall }

const PLACEHOLDER_ID = /^missing-(call-)?id(-\d+)?$/

function isEmptyPlaceholder(value: unknown): boolean {
  return value === '' || (Array.isArray(value) && value.length === 0)
}

function acceptsAbsence(field: unknown): boolean {
  const parse = (field as { safeParse?: unknown } | null | undefined)?.safeParse
  if (typeof parse !== 'function') return false
  try {
    return (parse as (value: unknown) => { success: boolean }).call(field, undefined).success === true
  } catch {
    return false
  }
}

function declaredShapes(schema: unknown, depth = 0): Array<Record<string, unknown>> {
  if (typeof schema !== 'object' || schema === null || depth > 4) return []
  const s = schema as { shape?: unknown; options?: unknown; unwrap?: unknown; out?: unknown }
  if (typeof s.shape === 'object' && s.shape !== null) return [s.shape as Record<string, unknown>]
  if (Array.isArray(s.options)) return s.options.flatMap(option => declaredShapes(option, depth + 1))
  if (typeof s.unwrap === 'function') {
    try {
      return declaredShapes((s.unwrap as () => unknown).call(schema), depth + 1)
    } catch {
      return []
    }
  }
  if (typeof s.out === 'object' && s.out !== null) return declaredShapes(s.out, depth + 1)
  return []
}

export function dropEmptyOptionalArgs(
  input: Record<string, unknown>,
  tool: { inputSchema: unknown; keepEmptyInputs?: readonly string[] },
): Record<string, unknown> {
  const empties = Object.keys(input).filter(
    key => isEmptyPlaceholder(input[key]) && !(tool.keepEmptyInputs?.includes(key) ?? false),
  )
  if (empties.length === 0) return input
  let shapes: Array<Record<string, unknown>>
  try {
    shapes = declaredShapes(tool.inputSchema)
  } catch {
    return input
  }
  if (shapes.length === 0) return input
  const out = { ...input }
  for (const key of empties) {
    const declaring = shapes.filter(shape => Object.prototype.hasOwnProperty.call(shape, key))
    if (declaring.length > 0 && declaring.every(shape => acceptsAbsence(shape[key]))) delete out[key]
  }
  return out
}

function straightenValue(value: unknown): unknown {
  if (typeof value === 'string') return straightenQuotes(value)
  if (!Array.isArray(value)) return value
  let changed = false
  const items = value.map(item => {
    if (typeof item !== 'string') return item
    const straight = straightenQuotes(item)
    if (straight !== item) changed = true
    return straight
  })
  return changed ? items : value
}

export function straightenQuoteArgs(
  input: Record<string, unknown>,
  tool: { straightQuoteInputs?: readonly string[] },
): Record<string, unknown> {
  const fields = tool.straightQuoteInputs
  if (!fields || fields.length === 0) return input
  let out: Record<string, unknown> | undefined
  for (const key of fields) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue
    const straight = straightenValue(input[key])
    if (straight === input[key]) continue
    out ??= { ...input }
    out[key] = straight
  }
  return out ?? input
}

export function repairToolInput<Input extends Record<string, unknown>>(
  tool: { inputSchema: unknown; inputJSONSchema?: unknown; keepEmptyInputs?: readonly string[]; isMcp?: boolean },
  input: Input,
): Input {
  const declared = declaredInputSchema(tool)
  if (tool.isMcp === true) return repairArgumentsBySchema(input, declared) as Input
  const stripped = stripNullArgs(input, declared) as Record<string, unknown>
  const dropped = dropEmptyOptionalArgs(stripped, tool)
  return repairArgumentsBySchema(dropped, declared) as Input
}

function refused(call: IncomingToolCall, code: RefusedToolCall['code'], reason: string, offered?: string[]): ToolCallVerdict {
  return {
    ok: false,
    refusal: { id: call.id, name: call.name, argumentsRaw: call.argumentsRaw, argumentsLength: call.argumentsRaw.length, code, reason, ...(offered === undefined ? {} : { offered }) },
  }
}

export const REFUSAL_RAW_DIAGNOSTIC_CHARS = 2_000

export function toolCallRefusalDiagnostic(refusal: RefusedToolCall): string {
  const name = refusal.name.trim() === '' ? 'unnamed' : displayToolName(refusal.name)
  const length = refusal.argumentsLength ?? refusal.argumentsRaw.length
  const raw = refusal.argumentsRaw.slice(0, REFUSAL_RAW_DIAGNOSTIC_CHARS)
  const cut = length > raw.length ? `, the first ${raw.length} shown` : ''
  return `refused tool call ${name} (${refusal.code}, call ${refusal.id || 'no id'}): ${issueSummary(refusal.reason)} — raw arguments (${length} chars${cut}): ${raw === '' ? '(empty)' : raw}`
}

interface ToolCallGateHints {

  deferredUnadmitted?: (name: string) => boolean
  straightenQuotes?: boolean
}

export function schemaNotSentSentence(toolName: string): string {
  return `This tool's schema was not sent to the model: ${toolName} is a deferred tool this session has not admitted yet. Load it first: call ToolSearch with query "select:${toolName}", then retry the call with the schema in hand.`
}

export function gateToolCall(tools: Tools, call: IncomingToolCall, hints?: ToolCallGateHints): ToolCallVerdict {
  if (call.providerRefusal !== undefined) {
    return refused(call, 'provider-malformed', call.providerRefusal)
  }
  if (call.name.trim() === '') {
    return refused(call, 'unknown-tool', 'the call carried no tool name')
  }
  const tool = findToolByName(tools, call.name)
  if (!tool) {
    return refused(call, 'unknown-tool', `No such tool available: ${displayToolName(call.name)}`, tools.map(offered => offered.name))
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
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return refused(
      call,
      'not-an-object',
      `the arguments must be a JSON object, not ${Array.isArray(parsed) ? 'an array' : parsed === null ? 'null' : `a ${typeof parsed}`}`,
    )
  }
  const straightened = hints?.straightenQuotes === true ? straightenQuoteArgs(parsed as Record<string, unknown>, tool) : (parsed as Record<string, unknown>)
  const input = repairToolInput(tool, straightened)
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
  const body = lines.length > 1 && /failed \(issues?\):$/.test(lines[0]!) ? lines.slice(1) : lines
  return body.join('; ')
}

export function toolCallRefusalNote(lane: string, refusal: RefusedToolCall): string {
  const name = refusal.name.trim() === '' ? 'unnamed' : displayToolName(refusal.name)
  switch (refusal.code) {
    case 'unknown-tool':

      return `[${lane}] No such tool available: ${name} — it is not in this session's tool list, so it was not executed. Call one of the tools you were given${offeredToolNamesClause((refusal.offered ?? []).map(offered => ({ name: offered })))} (a ToolSearch query loads a deferred tool when one is offered).`
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
    case 'provider-malformed':
      return `[${lane}] the provider could not parse the function call the model wrote${name === 'unnamed' ? '' : ` (${name})`}: ${issueSummary(refusal.reason)} — it was not executed.`
  }
}

const ANSWERABLE_REFUSALS: ReadonlySet<RefusedToolCall['code']> = new Set(['schema', 'unknown-tool', 'invalid-json', 'not-an-object'])

export function refusalAnswersAsToolResult(refusal: RefusedToolCall): boolean {
  return ANSWERABLE_REFUSALS.has(refusal.code) && refusal.id.trim() !== '' && !PLACEHOLDER_ID.test(refusal.id) && refusal.name.trim() !== ''
}

export function refusedCallInput(refusal: RefusedToolCall): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(refusal.argumentsRaw)
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function toolCallRefusalResultText(refusal: RefusedToolCall): string {
  const name = refusal.name.trim() === '' ? 'the tool' : displayToolName(refusal.name)
  switch (refusal.code) {
    case 'schema':
      return `${refusal.reason}\nThe call did not run. Send it again with arguments that match ${name}'s input schema exactly (required parameters present, correct types, no extra fields on strict tools).`
    case 'invalid-json':
    case 'not-an-object':
      return `${refusal.reason}.\nArguments received: ${previewRaw(refusal.argumentsRaw)}\nThe call did not run. Send it again with its arguments as one JSON object that matches ${name}'s input schema.`
    default:
      return `${refusal.reason}\nThe call did not run.`
  }
}

export function refusalAnsweredBy(refusal: RefusedToolCall, messages: readonly AssistantMessage[]): boolean {
  return messages.some(message =>
    Array.isArray(message.message.content) && message.message.content.some(block => block.type === 'tool_use' && block.id === refusal.id),
  )
}

export function unansweredRefusals(messages: readonly AssistantMessage[]): RefusedToolCall[] {
  return collectRefusedToolCalls(messages).filter(refusal => !refusalAnsweredBy(refusal, messages))
}

export const TOOL_CALL_REFUSAL_CORRECTION_HEAD =
  'One or more of your tool calls were refused by the harness before execution:'

export function toolCallRefusalCorrection(refusals: readonly RefusedToolCall[]): string {
  const items = refusals.map(refusal => {
    const name = refusal.name.trim() === '' ? '(no tool name)' : displayToolName(refusal.name)
    const headline =
      refusal.code === 'unknown-tool'
        ? `unknown tool ${name}: ${refusal.reason}`
        : refusal.code === 'duplicate-id'
          ? `duplicate call id for ${name}: ${refusal.reason}`
          : refusal.code === 'provider-malformed'
            ? `the provider could not parse the function call you wrote${name === '(no tool name)' ? '' : ` for ${name}`}: ${refusal.reason}`
            : `malformed arguments for ${name}: ${refusal.reason}`
    return `- call ${refusal.id || '(no id)'} — ${headline}\n  Arguments received: ${previewRaw(refusal.argumentsRaw)}`
  })
  const memoryWrites = [...new Set(memoryWriteRefusals(refusals).map(refusal => refusal.name))]
  const memoryLine = memoryWrites.length === 0 ? '' : ` ${memoryWrites.map(name => `The user asked for the ${name} call's facts to be kept and nothing was stored: re-issue that ${name} call now, with the same facts and arguments that match its schema, before anything else — the user will not type them again.`).join(' ')}`
  return (
    `${TOOL_CALL_REFUSAL_CORRECTION_HEAD}\n${items.join('\n')}\n` +
    `None of these calls ran, so nothing happened. Re-issue each one with a tool name from your tool list, a call id of its own, and arguments that match that tool's input schema exactly (required parameters present, correct types, no extra fields on strict tools).${memoryLine}`
  )
}

const MEMORY_WRITE_LOST_LINES: Record<string, string> = {
  [RETAIN_TOOL_NAME]: 'the remember did not happen — say it again',
  [CORRECT_TOOL_NAME]: 'the correction did not happen — say it again',
}

export function isMemoryWriteTool(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(MEMORY_WRITE_LOST_LINES, name)
}

export function memoryWriteRefusals(refusals: readonly RefusedToolCall[]): RefusedToolCall[] {
  return refusals.filter(refusal => isMemoryWriteTool(refusal.name))
}

export function memoryWriteLostLine(name: string): string {
  return MEMORY_WRITE_LOST_LINES[name] ?? `the ${name} call did not happen — say it again`
}

export function memoryWriteLostNotice(pending: readonly RefusedToolCall[]): string {
  const names = [...new Set(pending.map(refusal => refusal.name))]
  return names.map(memoryWriteLostLine).join(' · ')
}

function normalizedFactText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim()
}

export function refusedFactTexts(refusal: RefusedToolCall): string[] {
  const out: string[] = []
  try {
    const parsed = JSON.parse(refusal.argumentsRaw) as { items?: unknown }
    if (Array.isArray(parsed.items)) {
      for (const item of parsed.items) {
        const content = (item as { content?: unknown } | null)?.content
        if (typeof content === 'string' && content.trim() !== '') out.push(normalizedFactText(content))
      }
    }
  } catch {
    for (const match of refusal.argumentsRaw.matchAll(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/g)) {
      const content = match[1] ?? ''
      if (content.trim() !== '') out.push(normalizedFactText(content.replace(/\\(.)/g, '$1')))
    }
  }
  return out
}

export function executedCallAnswersRefusal(refusal: RefusedToolCall, call: { name: string; input: unknown }): boolean {
  if (call.name !== refusal.name) return false
  const wanted = refusedFactTexts(refusal)
  if (wanted.length === 0) return true
  const items = (call.input as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) return true
  const stored = items
    .map(item => (item as { content?: unknown } | null)?.content)
    .filter((content): content is string => typeof content === 'string')
    .map(normalizedFactText)
  return wanted.some(fact => stored.some(text => text === fact || text.includes(fact) || fact.includes(text)))
}

export function settleMemoryWriteRefusals(pending: RefusedToolCall[], executed: readonly { name: string; input: unknown }[]): void {
  for (let i = pending.length - 1; i >= 0; i--) {
    const refusal = pending[i]!
    if (executed.some(call => executedCallAnswersRefusal(refusal, call))) pending.splice(i, 1)
  }
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
